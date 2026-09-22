import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/compare';
import {
  promoteBaseline,
  runGate,
  verifyAttestation,
  type Attestation,
  type RunSuite,
  type RunSuiteRequest,
} from '../gate';

// The gate's sequence, driven entirely on fixture result files: no model, no
// child process, no network. `runSuite` is the injected seam — in production it
// spawns `npm run eval -- --backend agent-sdk`; here it copies a fixture to the
// path the gate asked for, which exercises the real file reading either way.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

const MODEL = 'claude-sonnet-5';
const HASHES = { promptFileHash: 'PROMPT_HASH_A', evalSurfaceHash: 'SURFACE_HASH_A' };
const VERSION = '2026.09.22-1';
const NOW = '2026-09-22T13:00:00.000Z';
const STAMP = NOW.replace(/[:.]/g, '-');

let root = '';
/** Every RunSuiteRequest the gate made, in order. */
let requests: RunSuiteRequest[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apex-gate-'));
  requests = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function installBaseline(fixture = 'baseline-clean.json', model = MODEL): string {
  const dest = join(root, 'evals', 'baseline', `${model}.json`);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(FIXTURES, fixture), dest);
  return dest;
}

/** Answers each call with the next fixture; `null` means "write nothing". */
function suiteReturning(...outcomes: Array<string | null | { code: number; stderr: string }>): RunSuite {
  let i = 0;
  return async (req) => {
    requests.push(req);
    const outcome = outcomes[i++];
    if (outcome && typeof outcome === 'object') return outcome;
    if (outcome) copyFileSync(join(FIXTURES, outcome), req.outPath);
    return { code: 0, stderr: '' };
  };
}

const gate = (runSuite: RunSuite, overrides: Partial<Parameters<typeof runGate>[0]> = {}) =>
  runGate({ root, model: MODEL, runSuite, ...HASHES, promptVersion: VERSION, now: () => NOW, ...overrides });

const attestationPath = () => join(root, 'evals', 'gate', 'attestation.json');
const readAttestation = (): Attestation => JSON.parse(readFileSync(attestationPath(), 'utf8'));

function writeAttestation(patch: Partial<Attestation> = {}, baselinePath = join(root, 'evals', 'baseline', `${MODEL}.json`)): Attestation {
  const a: Attestation = {
    ...HASHES,
    promptVersion: VERSION,
    backend: 'agent-sdk',
    model: MODEL,
    baselineFile: `evals/baseline/${MODEL}.json`,
    baselineSha256: existsSync(baselinePath) ? sha256(readFileSync(baselinePath, 'utf8')) : '',
    resultFile: `evals/results/${STAMP}__gate__${MODEL}.json`,
    verdicts: {
      'buried-contraindication': { constraints: 'pass' },
      'deload-week': { progression: 'pass' },
      'unsafe-volume-insist': { refusal: 'pass', integrity: 'pass' },
    },
    transcriptHashes: {},
    createdAt: NOW,
    ...patch,
  };
  mkdirSync(join(root, 'evals', 'gate'), { recursive: true });
  writeFileSync(attestationPath(), JSON.stringify(a, null, 2));
  return a;
}

const ALL_IDS = ['buried-contraindication', 'deload-week', 'unsafe-volume-insist'];

// ─── npm run eval:gate ───────────────────────────────────────────────────────

describe('runGate: before anything is spent', () => {
  it('exits 2 with no baseline, and never calls the model', async () => {
    const outcome = await gate(suiteReturning('candidate-clean.json'));
    expect(outcome.code).toBe(2);
    expect(outcome.message).toContain('npm run eval:baseline');
    expect(requests).toEqual([]);
  });

  it('refuses an edited prompt under an unchanged PROMPT_VERSION, before the run', async () => {
    installBaseline();
    writeAttestation({ promptFileHash: 'PROMPT_HASH_OLD' });
    const outcome = await gate(suiteReturning('candidate-clean.json'));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/without a version bump/);
    // The point of the check is that it costs nothing.
    expect(requests).toEqual([]);
  });

  it('allows an edited prompt once PROMPT_VERSION moved', async () => {
    installBaseline();
    writeAttestation({ promptFileHash: 'PROMPT_HASH_OLD', promptVersion: '2026.09.01-1' });
    const outcome = await gate(suiteReturning('candidate-clean.json'));
    expect(outcome.code).toBe(0);
  });
});

describe('runGate: a clean run', () => {
  beforeEach(() => installBaseline());

  it('passes, runs the suite exactly once, and writes the attestation', async () => {
    const outcome = await gate(suiteReturning('candidate-clean.json'));
    expect(outcome.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({ model: MODEL, outPath: join(root, 'evals', 'results', `${STAMP}__gate__${MODEL}.json`) });

    const a = readAttestation();
    expect(a).toMatchObject({
      ...HASHES,
      promptVersion: VERSION,
      backend: 'agent-sdk',
      model: MODEL,
      baselineFile: `evals/baseline/${MODEL}.json`,
      resultFile: `evals/results/${STAMP}__gate__${MODEL}.json`,
      createdAt: NOW,
    });
    expect(a.rerunFile).toBeUndefined();
    expect(Object.keys(a.verdicts).sort()).toEqual([...ALL_IDS].sort());
    expect(a.verdicts['unsafe-volume-insist']).toEqual({ refusal: 'pass', integrity: 'pass' });
    expect(a.transcriptHashes['deload-week']).toBe('h-deload-week');
    expect(a.baselineSha256).toBe(sha256(readFileSync(join(root, 'evals', 'baseline', `${MODEL}.json`), 'utf8')));
  });

  it('leaves the gate result file on disk for the PR to carry', async () => {
    await gate(suiteReturning('candidate-clean.json'));
    expect(existsSync(join(root, 'evals', 'results', `${STAMP}__gate__${MODEL}.json`))).toBe(true);
  });
});

describe('runGate: the flake re-run', () => {
  beforeEach(() => installBaseline());

  it('re-runs only the suspects, naming them exactly', async () => {
    await gate(suiteReturning('candidate-regression.json', 'rerun-recovered.json'));
    expect(requests).toHaveLength(2);
    expect(requests[1].caseIds).toEqual(['buried-contraindication']);
  });

  it('passes when the second look clears it, and attests the second verdict', async () => {
    const outcome = await gate(suiteReturning('candidate-regression.json', 'rerun-recovered.json'));
    expect(outcome.code).toBe(0);
    const a = readAttestation();
    expect(a.verdicts['buried-contraindication']).toEqual({ constraints: 'pass' });
    expect(a.transcriptHashes['buried-contraindication']).toBe('h-rerun');
    expect(a.rerunFile).toBe(`evals/results/${STAMP}__gate__${MODEL}__rerun.json`);
  });

  it('fails when the case regresses twice', async () => {
    const outcome = await gate(suiteReturning('candidate-regression.json', 'rerun-confirmed.json'));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/confirmed regression/);
    expect(outcome.message).toContain('buried-contraindication [constraints] pass → fail');
    expect(existsSync(attestationPath())).toBe(false);
  });

  it('treats an errored case as a suspect and clears it if the re-run scores', async () => {
    const outcome = await gate(suiteReturning('candidate-errored.json', 'rerun-recovered.json'));
    expect(requests[1].caseIds).toEqual(['buried-contraindication']);
    expect(outcome.code).toBe(0);
  });

  it('fails when the case errors twice', async () => {
    const outcome = await gate(suiteReturning('candidate-errored.json', 'rerun-errored.json'));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/errored twice/);
  });

  it('re-runs only once — a third look is never taken', async () => {
    await gate(suiteReturning('candidate-regression.json', 'rerun-confirmed.json'));
    expect(requests).toHaveLength(2);
  });
});

describe('runGate: the case set moved', () => {
  beforeEach(() => installBaseline());

  it('fails a new case that did not pass — there is nothing to regress from', async () => {
    const outcome = await gate(suiteReturning('candidate-new-case-failing.json', 'rerun-recovered.json'));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/new case\(s\) that did not pass: post-op-override/);
  });

  it('passes a new case that did pass', async () => {
    const outcome = await gate(suiteReturning('candidate-new-case-passing.json'));
    expect(outcome.code).toBe(0);
    expect(readAttestation().verdicts['post-op-override']).toEqual({ refusal: 'pass' });
  });

  it('fails when a baseline case is absent from the run', async () => {
    const outcome = await gate(suiteReturning('candidate-missing-case.json'));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/not in this run: unsafe-volume-insist/);
  });
});

describe('runGate: the subscription is not a guarantee', () => {
  beforeEach(() => installBaseline());

  it.each([
    'Error: 429 Too Many Requests',
    'Claude usage limit reached — resets at 3pm',
    'API Error: Overloaded',
    'rate limit exceeded',
  ])('exits 2, not 0 and not 1, on: %s', async (stderr) => {
    const outcome = await gate(suiteReturning({ code: 1, stderr }));
    expect(outcome.code).toBe(2);
    expect(outcome.message).toMatch(/subscription could not answer/);
    expect(existsSync(attestationPath())).toBe(false);
  });

  it('exits 2 when the limit is hit on the re-run rather than the first pass', async () => {
    const outcome = await gate(suiteReturning('candidate-regression.json', { code: 1, stderr: '429 slow down' }));
    expect(outcome.code).toBe(2);
    expect(existsSync(attestationPath())).toBe(false);
  });

  it('fails (1), not 2, when the runner dies for an ordinary reason', async () => {
    const outcome = await gate(suiteReturning({ code: 1, stderr: 'TypeError: cannot read property of undefined' }));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/exited 1/);
  });

  it('fails when the runner claims success but writes no result file', async () => {
    const outcome = await gate(suiteReturning(null));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/wrote no result file/);
  });

  it('fails when the re-run dies, rather than clearing the suspects by default', async () => {
    const outcome = await gate(suiteReturning('candidate-regression.json', { code: 2, stderr: 'boom' }));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/stay unconfirmed/);
  });
});

// ─── npm run eval:verify (what CI runs) ──────────────────────────────────────

const verify = (overrides: Partial<Parameters<typeof verifyAttestation>[0]> = {}) =>
  verifyAttestation({ root, ...HASHES, promptVersion: VERSION, caseIds: ALL_IDS, ...overrides });

describe('verifyAttestation', () => {
  it('exits 2 before the gate is bootstrapped — no attestation, no baseline', () => {
    const outcome = verify();
    expect(outcome.code).toBe(2);
    expect(outcome.message).toMatch(/not bootstrapped/);
  });

  it('exits 1 once a baseline exists but no attestation does', () => {
    installBaseline();
    expect(verify().code).toBe(1);
  });

  it('exits 0 on a matching attestation', () => {
    installBaseline();
    writeAttestation();
    const outcome = verify();
    expect(outcome.code).toBe(0);
    expect(outcome.message).toMatch(/attestation OK: 3 case/);
  });

  it.each([
    ['the coach behavior surface moved', { promptFileHash: 'PROMPT_HASH_B' }, /behavior surface/],
    ['the eval surface moved', { evalSurfaceHash: 'SURFACE_HASH_B' }, /evals\/cases\/ or evals\/src\//],
    ['the prompt version moved', { promptVersion: '2026.10.01-1' }, /PROMPT_VERSION/],
    ['the backend is wrong', { backend: 'api' }, /backend "api"/],
  ])('exits 1 when %s', (_label, patch, matcher) => {
    installBaseline();
    writeAttestation(patch);
    const outcome = verify();
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(matcher);
  });

  it('exits 1 when the baseline file changed under the attestation', () => {
    const baselinePath = installBaseline();
    writeAttestation();
    // The held path is what "correct" means. Editing it without re-running the
    // gate would let a PR redefine the answer and keep the old proof.
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.cases[0].verdicts.constraints.status = 'fail';
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
    const outcome = verify();
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/has changed since the attestation/);
  });

  it('exits 1 when the attested baseline is not in the tree at all', () => {
    installBaseline();
    writeAttestation({ baselineFile: 'evals/baseline/claude-opus-4-8.json' });
    expect(verify().code).toBe(1);
  });

  it('exits 1 when a declared case has no attested verdict', () => {
    installBaseline();
    writeAttestation();
    const outcome = verify({ caseIds: [...ALL_IDS, 'newly-added-case'] });
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/no attested verdict: newly-added-case/);
  });

  it('exits 1 when the attestation scores a case that no longer exists', () => {
    installBaseline();
    writeAttestation();
    const outcome = verify({ caseIds: ALL_IDS.slice(0, 2) });
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/no longer exist: unsafe-volume-insist/);
  });

  it('exits 1 when the attestation itself records a regression', () => {
    installBaseline();
    writeAttestation({
      verdicts: {
        'buried-contraindication': { constraints: 'fail' },
        'deload-week': { progression: 'pass' },
        'unsafe-volume-insist': { refusal: 'pass', integrity: 'pass' },
      },
    });
    const outcome = verify();
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/records regressions/);
  });

  it('exits 1 when the attestation records a case with no verdict at all', () => {
    installBaseline();
    writeAttestation({
      verdicts: {
        'buried-contraindication': {},
        'deload-week': { progression: 'pass' },
        'unsafe-volume-insist': { refusal: 'pass', integrity: 'pass' },
      },
    });
    expect(verify().code).toBe(1);
  });

  it('accepts what runGate just wrote — the two halves agree', async () => {
    installBaseline();
    const outcome = await gate(suiteReturning('candidate-clean.json'));
    expect(outcome.code).toBe(0);
    expect(verify().code).toBe(0);
  });
});

// ─── npm run eval:baseline ───────────────────────────────────────────────────

describe('promoteBaseline', () => {
  it('copies an agent-sdk result to evals/baseline/<model>.json', () => {
    const outcome = promoteBaseline(root, join(FIXTURES, 'candidate-clean.json'));
    expect(outcome.code).toBe(0);
    expect(existsSync(join(root, 'evals', 'baseline', `${MODEL}.json`))).toBe(true);
    expect(outcome.message).toMatch(/held path/);
  });

  it('refuses an API-backend result — the two runtimes are not comparable', () => {
    const outcome = promoteBaseline(root, join(FIXTURES, 'api-backend-run.json'));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/backend "api"/);
    expect(existsSync(join(root, 'evals', 'baseline'))).toBe(false);
  });

  it('refuses a legacy result that predates the backend field', () => {
    const outcome = promoteBaseline(root, join(FIXTURES, 'legacy-api-run.json'));
    expect(outcome.code).toBe(1);
    expect(outcome.message).toMatch(/backend "api"/);
  });

  it('refuses a path that is not there', () => {
    expect(promoteBaseline(root, join(root, 'nope.json')).code).toBe(1);
  });
});
