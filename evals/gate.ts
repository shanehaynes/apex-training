import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALL_CASES } from './cases/index';
import { PROMPT_VERSION } from '../src/lib/coach/prompt';
import {
  casePassed,
  classify,
  evalSurfaceHash,
  promptFileHash,
  sha256,
  type CaseResultLike,
  type RunResultLike,
  type StoredRunResult,
} from './src/compare';
import type { VerdictStatus } from './src/types';

// The coach eval gate.
//
//   npm run eval:gate                       # run the suite locally, decide, attest
//   npm run eval:gate -- --concurrency 3    # fewer lanes (default 6)
//   npm run eval:baseline -- <result.json>  # promote a result file to the baseline
//   npm run eval:hash                       # print the two hashes the attestation pins
//   npm run eval:verify                     # token-free: check the committed attestation
//
// WHY IT IS SHAPED THIS WAY. The gate has to spend a Claude subscription and
// never API credit, and subscription entitlement cannot run inside GitHub
// Actions. So the expensive half runs HERE, on the developer's logged-in Claude
// Code (`--backend agent-sdk`), and commits an attestation; CI runs the cheap
// half, which re-derives every hash from the tree and calls no model at all.
// The attestation is only worth anything because it pins BOTH what the coach
// is (promptFileHash) and what the question was (evalSurfaceHash) — without
// the second, the gate could be satisfied by making the test easier.
//
// Exit codes, the same three this repo uses for prod-checks:
//   0  pass
//   1  fail — a regression, a broken attestation, a stale hash
//   2  could not look — no baseline yet, or the subscription ran out of rope.
//      Never a fake pass.

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..');

export const BACKEND = 'agent-sdk';
const BASELINE_DIR = 'evals/baseline';
const ATTESTATION_FILE = 'evals/gate/attestation.json';
/** The agent-sdk backend runs one tool per round, so a serial suite is ~20
 *  minutes against ~4 at six lanes. Cases are independent and each gets its
 *  own backend and session, so this changes timing, not verdicts. */
export const DEFAULT_CONCURRENCY = 6;

/** Non-zero child exits whose stderr matches this are "out of rope", not "broken code". */
const LIMIT_PATTERN = /rate limit|overloaded|429|usage limit/i;

export interface Attestation {
  promptFileHash: string;
  evalSurfaceHash: string;
  promptVersion: string;
  backend: string;
  model: string;
  baselineFile: string;
  baselineSha256: string;
  resultFile: string;
  /** Lanes the suite ran in. Absent on attestations written before the gate
   *  could run cases side by side, which were all serial — readers fall back
   *  to 1, exactly as they fall back for promptVersion and backend. */
  concurrency?: number;
  /** Present only when the flake re-run fired; those cases' verdicts come from it. */
  rerunFile?: string;
  verdicts: Record<string, Record<string, VerdictStatus>>;
  transcriptHashes: Record<string, string>;
  createdAt: string;
}

export interface RunSuiteRequest {
  model: string;
  /** Where the runner must write its result file. */
  outPath: string;
  /** Absent for the full suite; a subset for the flake re-run. */
  caseIds?: string[];
}
export interface RunSuiteOutcome {
  code: number;
  stderr: string;
}
export type RunSuite = (req: RunSuiteRequest) => Promise<RunSuiteOutcome>;

export interface GateDeps {
  /** Directory holding evals/ — the repo root in production, a temp dir in tests. */
  root: string;
  model: string;
  runSuite: RunSuite;
  /** Recorded in the attestation. The gate does not schedule anything itself —
   *  runSuite owns that — so this is a statement about the run, not a knob. */
  concurrency?: number;
  promptFileHash: string;
  evalSurfaceHash: string;
  promptVersion: string;
  /** ISO timestamp. Injected so a test can name the result file it will assert on. */
  now: () => string;
  log?: (line: string) => void;
}

export interface GateOutcome {
  code: 0 | 1 | 2;
  message: string;
  attestation?: Attestation;
}

const posix = (p: string) => p.split('\\').join('/');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The verdict map an attestation carries, from a run's cases. */
function verdictMap(cases: CaseResultLike[]): Attestation['verdicts'] {
  const out: Attestation['verdicts'] = {};
  for (const c of cases) {
    const dims: Record<string, VerdictStatus> = {};
    for (const [dim, v] of Object.entries(c.verdicts)) if (v) dims[dim] = v.status;
    out[c.id] = dims;
  }
  return out;
}

/** An attestation's verdicts, read back as something classify() can compare. */
export function attestationAsRun(a: Attestation): RunResultLike {
  return {
    cases: Object.entries(a.verdicts).map(([id, dims]) => ({
      id,
      verdicts: Object.fromEntries(Object.entries(dims).map(([dim, status]) => [dim, { status }])),
    })),
  };
}

// ─── npm run eval:gate ───────────────────────────────────────────────────────

export async function runGate(deps: GateDeps): Promise<GateOutcome> {
  const log = deps.log ?? (() => {});
  const baselineRel = `${BASELINE_DIR}/${deps.model}.json`;
  const baselinePath = join(deps.root, baselineRel);

  // (1) No baseline is not a failure — it is nothing to compare against.
  if (!existsSync(baselinePath)) {
    return {
      code: 2,
      message: `no baseline for ${deps.model}; run \`npm run eval:baseline -- <result.json>\` ` +
        `with an agent-sdk result to create ${baselineRel}`,
    };
  }
  const baselineRaw = readFileSync(baselinePath, 'utf8');
  const baseline = JSON.parse(baselineRaw) as StoredRunResult;

  // (2) Fail fast, BEFORE any model call: an edited prompt under an unchanged
  // PROMPT_VERSION means the version no longer identifies the prompt, and a
  // gate run would attest to a name that has stopped meaning anything.
  const attestationPath = join(deps.root, ATTESTATION_FILE);
  if (existsSync(attestationPath)) {
    const prior = readJson<Attestation>(attestationPath);
    if (prior.promptFileHash !== deps.promptFileHash && prior.promptVersion === deps.promptVersion) {
      return {
        code: 1,
        message: `prompt changed without a version bump: the coach behavior surface differs from the ` +
          `attestation but PROMPT_VERSION is still ${deps.promptVersion}. Bump it in src/lib/coach/prompt.ts.`,
      };
    }
  }

  // (3) Spend the subscription. The runner is a child process, invoked by
  // command line rather than imported, so the gate stays independent of the
  // runner's module graph.
  const stamp = deps.now().replace(/[:.]/g, '-');
  const resultRel = `evals/results/${stamp}__gate__${deps.model}.json`;
  const resultPath = join(deps.root, resultRel);
  mkdirSync(dirname(resultPath), { recursive: true });

  log(`running the suite on ${deps.model} via ${BACKEND} → ${resultRel}`);
  const first = await deps.runSuite({ model: deps.model, outPath: resultPath });
  const limited = limitOutcome(first);
  if (limited) return limited;
  if (first.code !== 0) {
    return { code: 1, message: `the eval run exited ${first.code} — the gate did not complete.` };
  }
  if (!existsSync(resultPath)) {
    return { code: 1, message: `the eval run reported success but wrote no result file at ${resultRel}.` };
  }
  const firstRun = readJson<StoredRunResult>(resultPath);

  // (4)+(5) Classify, then look again at everything that looks bad exactly
  // once. A model is not a pure function; one bad sample is a suspicion, two
  // is a finding.
  const firstPass = classify(baseline, firstRun);
  const suspects = [...new Set([...firstPass.regressions.map(r => r.caseId), ...firstPass.erroredCases])];

  let finalCases: CaseResultLike[] = firstRun.cases;
  let rerunRel: string | undefined;
  if (suspects.length) {
    rerunRel = `evals/results/${stamp}__gate__${deps.model}__rerun.json`;
    const rerunPath = join(deps.root, rerunRel);
    log(`re-running ${suspects.length} suspect case(s) once: ${suspects.join(', ')}`);
    const second = await deps.runSuite({ model: deps.model, outPath: rerunPath, caseIds: suspects });
    const secondLimited = limitOutcome(second);
    if (secondLimited) return secondLimited;
    if (second.code !== 0 || !existsSync(rerunPath)) {
      return { code: 1, message: `the flake re-run exited ${second.code} — the suspects stay unconfirmed, so the gate fails.` };
    }
    const rerun = readJson<StoredRunResult>(rerunPath);
    // Only the suspects are taken from the re-run; every other case keeps its
    // first-run verdict. A case still bad on its second look is confirmed by
    // the same classify() that flagged it.
    const suspectSet = new Set(suspects);
    const byId = new Map(rerun.cases.filter(c => suspectSet.has(c.id)).map(c => [c.id, c]));
    finalCases = firstRun.cases.map(c => byId.get(c.id) ?? c);
    for (const id of suspects) {
      if (!finalCases.some(c => c.id === id)) {
        const fresh = byId.get(id);
        if (fresh) finalCases.push(fresh);
      }
    }
  }

  // (6) One classification over the settled run. Because only suspects were
  // replaced, a regression here is one that survived two looks.
  const final = classify(baseline, { cases: finalCases });
  const byId = new Map(finalCases.map(c => [c.id, c]));
  const unprovenNewCases = final.newCases.filter(id => {
    const c = byId.get(id);
    return !c || !casePassed(c);
  });

  const reasons: string[] = [];
  if (final.regressions.length) {
    reasons.push(`${final.regressions.length} confirmed regression(s): ` +
      final.regressions.map(r => `${r.caseId} [${r.dim}] ${r.from} → ${r.to}`).join('; '));
  }
  if (final.erroredCases.length) {
    reasons.push(`${final.erroredCases.length} case(s) errored twice: ${final.erroredCases.join(', ')}`);
  }
  if (unprovenNewCases.length) {
    // A new case is absent from the held baseline by construction, so there is
    // nothing to regress from — it has to stand on its own.
    reasons.push(`new case(s) that did not pass: ${unprovenNewCases.join(', ')}`);
  }
  if (final.missingCases.length) {
    reasons.push(`case(s) in the baseline but not in this run: ${final.missingCases.join(', ')}`);
  }
  if (reasons.length) return { code: 1, message: reasons.join('\n') };

  // (7) Attest.
  const attestation: Attestation = {
    promptFileHash: deps.promptFileHash,
    evalSurfaceHash: deps.evalSurfaceHash,
    promptVersion: deps.promptVersion,
    backend: BACKEND,
    model: deps.model,
    baselineFile: baselineRel,
    baselineSha256: sha256(baselineRaw),
    resultFile: posix(resultRel),
    ...(deps.concurrency ? { concurrency: deps.concurrency } : {}),
    ...(rerunRel ? { rerunFile: posix(rerunRel) } : {}),
    verdicts: verdictMap(finalCases),
    transcriptHashes: Object.fromEntries(
      finalCases.filter(c => c.transcriptHash).map(c => [c.id, c.transcriptHash as string])),
    createdAt: deps.now(),
  };
  mkdirSync(join(deps.root, dirname(ATTESTATION_FILE)), { recursive: true });
  writeFileSync(join(deps.root, ATTESTATION_FILE), `${JSON.stringify(attestation, null, 2)}\n`);

  const improved = final.improvements.length ? `, ${final.improvements.length} improvement(s)` : '';
  return {
    code: 0,
    message: `gate passed: ${finalCases.length} case(s), no regressions${improved}. ` +
      `Attestation written to ${ATTESTATION_FILE} — commit it with ${resultRel} and its transcripts.`,
    attestation,
  };
}

function limitOutcome(outcome: RunSuiteOutcome): GateOutcome | null {
  if (outcome.code === 0 || !LIMIT_PATTERN.test(outcome.stderr)) return null;
  return {
    code: 2,
    message: 'the subscription could not answer (rate limit / usage limit / overloaded). ' +
      'The gate did not run; nothing is attested. Try again later.\n' + outcome.stderr.trim(),
  };
}

// ─── npm run eval:verify (token-free; this is what CI runs) ──────────────────

export interface VerifyDeps {
  root: string;
  promptFileHash: string;
  evalSurfaceHash: string;
  promptVersion: string;
  /** Every id the case set declares today. */
  caseIds: string[];
}

export function verifyAttestation(deps: VerifyDeps): GateOutcome {
  const attestationPath = join(deps.root, ATTESTATION_FILE);
  const baselineDir = join(deps.root, BASELINE_DIR);
  const baselines = existsSync(baselineDir)
    ? readdirSync(baselineDir).filter(f => f.endsWith('.json'))
    : [];

  if (!existsSync(attestationPath)) {
    // Before the first baseline lands there is nothing the gate could have
    // attested to, and saying so is honest. The moment a baseline exists, a
    // missing attestation is a coach change that never ran the gate.
    if (!baselines.length) {
      return { code: 2, message: `no ${ATTESTATION_FILE} and no baseline yet — the gate is not bootstrapped.` };
    }
    return {
      code: 1,
      message: `${ATTESTATION_FILE} is missing but a baseline exists — run \`npm run eval:gate\` and commit the attestation.`,
    };
  }

  const a = readJson<Attestation>(attestationPath);
  const fail = (m: string): GateOutcome => ({ code: 1, message: m });

  if (a.backend !== BACKEND) {
    return fail(`attestation records backend "${a.backend}" — the gate runs on ${BACKEND}.`);
  }
  if (a.promptFileHash !== deps.promptFileHash) {
    return fail('the coach behavior surface (prompt.ts, schemas.ts, tools.ts, model.ts) has changed since ' +
      'the attestation — run `npm run eval:gate` and commit the new one.');
  }
  if (a.evalSurfaceHash !== deps.evalSurfaceHash) {
    return fail('evals/cases/ or evals/src/ has changed since the attestation — the question the gate asked ' +
      'is not the question in this tree. Run `npm run eval:gate` and commit the new one.');
  }
  if (a.promptVersion !== deps.promptVersion) {
    return fail(`attestation is for PROMPT_VERSION ${a.promptVersion}, the tree is ${deps.promptVersion}.`);
  }

  const baselinePath = join(deps.root, a.baselineFile);
  if (!existsSync(baselinePath)) return fail(`the attested baseline ${a.baselineFile} is not in the tree.`);
  const baselineRaw = readFileSync(baselinePath, 'utf8');
  if (sha256(baselineRaw) !== a.baselineSha256) {
    return fail(`${a.baselineFile} has changed since the attestation — re-run the gate against the new baseline.`);
  }

  const attested = new Set(Object.keys(a.verdicts));
  const declared = new Set(deps.caseIds);
  const unscored = deps.caseIds.filter(id => !attested.has(id));
  const stale = [...attested].filter(id => !declared.has(id));
  if (unscored.length) return fail(`case(s) with no attested verdict: ${unscored.join(', ')}`);
  if (stale.length) return fail(`attestation scores case(s) that no longer exist: ${stale.join(', ')}`);

  const baseline = JSON.parse(baselineRaw) as StoredRunResult;
  const result = classify(baseline, attestationAsRun(a));
  if (result.regressions.length) {
    return fail('the attestation itself records regressions against the baseline: ' +
      result.regressions.map(r => `${r.caseId} [${r.dim}] ${r.from} → ${r.to}`).join('; '));
  }
  if (result.erroredCases.length) {
    return fail(`the attestation records case(s) with no verdict: ${result.erroredCases.join(', ')}`);
  }
  if (result.missingCases.length) {
    return fail(`the attestation omits baseline case(s): ${result.missingCases.join(', ')}`);
  }

  return {
    code: 0,
    message: `attestation OK: ${attested.size} case(s) on ${a.model}/${a.backend}, prompt ${a.promptVersion}, ` +
      `against ${a.baselineFile} (attested ${a.createdAt}).`,
  };
}

// ─── npm run eval:baseline ───────────────────────────────────────────────────

export function promoteBaseline(root: string, resultPath: string): GateOutcome {
  if (!existsSync(resultPath)) return { code: 1, message: `no such result file: ${resultPath}` };
  const run = readJson<StoredRunResult>(resultPath);
  // An API-backend run and an agent-sdk run are not comparable: different tool
  // loop, no max_tokens control, different token accounting (evals/README.md,
  // Backends). A baseline from the wrong runtime would turn every gate run
  // into noise.
  if (run.backend !== BACKEND) {
    return {
      code: 1,
      message: `${resultPath} was produced by backend "${run.backend ?? 'api'}" — the baseline must be an ` +
        `${BACKEND} run, because that is the runtime the gate measures. Re-run with ` +
        '`npm run eval -- --backend agent-sdk`.',
    };
  }
  if (!run.model) return { code: 1, message: `${resultPath} names no model.` };
  const rel = `${BASELINE_DIR}/${run.model}.json`;
  mkdirSync(join(root, BASELINE_DIR), { recursive: true });
  copyFileSync(resultPath, join(root, rel));
  return {
    code: 0,
    message: `${rel} ← ${resultPath} (${run.cases.length} cases, prompt ${run.promptVersion ?? 'unversioned'}). ` +
      'It is a held path: the PR carrying it needs Shane.',
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

/** The runner, by command line. Never imported — the gate must not depend on
 *  the runner's module graph to compile. */
/** The child runner's argv. Pure, so a test can assert what the gate forwards
 *  without spawning npm. */
export function suiteArgv(
  { model, outPath, caseIds }: RunSuiteRequest,
  concurrency: number = DEFAULT_CONCURRENCY,
): string[] {
  const args = [
    'run', 'eval', '--', '--backend', BACKEND, '--model', model, '--out', outPath,
    // Forwarded to BOTH the full run and the flake re-run: a gate that takes
    // twenty minutes is one people route around.
    '--concurrency', String(concurrency),
  ];
  if (caseIds?.length) {
    // run.ts treats a single value as a SUBSTRING and a comma-separated list
    // as exact ids. Repeating one id takes the exact path without dragging a
    // neighbouring case in.
    args.push('--case', (caseIds.length === 1 ? [caseIds[0], caseIds[0]] : caseIds).join(','));
  }
  return args;
}

export function spawnSuite(root: string, concurrency: number = DEFAULT_CONCURRENCY): RunSuite {
  return async req => {
    const args = suiteArgv(req, concurrency);
    const child = spawnSync('npm', args, { cwd: root, encoding: 'utf8', stdio: ['inherit', 'inherit', 'pipe'] });
    const stderr = `${child.stderr ?? ''}${child.error ? `\n${child.error.message}` : ''}`;
    if (stderr.trim()) process.stderr.write(stderr);
    return { code: child.status ?? 1, stderr };
  };
}

function parseModel(argv: string[]): string | null {
  const i = argv.indexOf('--model');
  return i >= 0 ? argv[i + 1] ?? null : null;
}

export function parseConcurrency(argv: string[]): number {
  const i = argv.indexOf('--concurrency');
  if (i < 0) return DEFAULT_CONCURRENCY;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--concurrency must be a positive integer, got "${argv[i + 1]}".`);
  }
  return n;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'run';
  const root = REPO_ROOT;
  const hashes = { promptFileHash: promptFileHash(), evalSurfaceHash: evalSurfaceHash(root) };

  if (command === 'hash') {
    console.log(`promptFileHash  ${hashes.promptFileHash}`);
    console.log(`evalSurfaceHash ${hashes.evalSurfaceHash}`);
    return 0;
  }

  if (command === 'verify') {
    const outcome = verifyAttestation({
      root, ...hashes, promptVersion: PROMPT_VERSION, caseIds: ALL_CASES.map(c => c.id),
    });
    (outcome.code === 0 ? console.log : console.error)(outcome.message);
    return outcome.code;
  }

  if (command === 'baseline') {
    const resultPath = argv[1];
    if (!resultPath) {
      console.error('Usage: npm run eval:baseline -- <result.json>');
      return 1;
    }
    const outcome = promoteBaseline(root, resultPath);
    (outcome.code === 0 ? console.log : console.error)(outcome.message);
    return outcome.code;
  }

  if (command !== 'run') {
    console.error(`Unknown command "${command}" — expected run, baseline, hash or verify.`);
    return 1;
  }

  // The default model is the one the baseline directory names, when it names
  // exactly one; otherwise say so rather than guess which arm is meant.
  let model = parseModel(argv);
  if (!model) {
    const found = existsSync(join(root, BASELINE_DIR))
      ? readdirSync(join(root, BASELINE_DIR)).filter(f => f.endsWith('.json'))
      : [];
    if (found.length === 1) model = found[0].replace(/\.json$/, '');
    else if (found.length === 0) {
      console.error(`no baseline yet; run \`npm run eval:baseline -- <result.json>\` to create ${BASELINE_DIR}/<model>.json`);
      return 2;
    } else {
      console.error(`several baselines (${found.join(', ')}) — pass --model <id>.`);
      return 2;
    }
  }

  const concurrency = parseConcurrency(argv);
  const outcome = await runGate({
    root,
    model,
    runSuite: spawnSuite(root, concurrency),
    concurrency,
    ...hashes,
    promptVersion: PROMPT_VERSION,
    now: () => new Date().toISOString(),
    log: line => console.log(`  ${line}`),
  });
  (outcome.code === 0 ? console.log : console.error)(outcome.message);
  return outcome.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
