import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { escapeData, judge, main } from '../eval-errors-check.mjs';
import { buildRunResult, writeRunResult } from '../../evals/src/report';
import type { CaseResult } from '../../evals/src/types';

const ciYml = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
const SCRIPT = fileURLToPath(new URL('../eval-errors-check.mjs', import.meta.url));

// The message every case returned on the credit-out nights (run 40724712885).
const CREDIT_OUT = '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
  '"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing ' +
  'to upgrade or purchase credits."}}';

function measured(id: string, status: 'pass' | 'fail' | 'needs-taxonomy' = 'pass'): CaseResult {
  return {
    id,
    verdicts: { constraints: { status, detail: status === 'pass' ? [] : ['cap exceeded'] } },
    turns: 2,
    toolCallCount: 3,
    readCallCount: 1,
    anomalies: [],
    usage: { inputTokens: 1000, outputTokens: 200 },
    costUsd: 0.01,
    latencyMs: 4000,
    transcriptHash: 'abc',
    transcriptPath: `evals/results/transcripts/x/${id}.json`,
  };
}

// The shape evals/run.ts records when a case throws.
function errored(id: string, error = CREDIT_OUT): CaseResult {
  return {
    id,
    verdicts: {},
    turns: 0,
    toolCallCount: 0,
    anomalies: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
    transcriptHash: '',
    transcriptPath: '',
    error,
  };
}

let dir: string;
let log: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-errors-check-'));
  log = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Through the runner's own writer, so the file has the shape CI reads (a
 *  top-level `cases` array). The `error` field itself comes from the fixture
 *  above, which mirrors evals/run.ts's catch block by hand: no tsc project
 *  includes this file, so renaming that field would not fail here. */
function resultFile(cases: CaseResult[]): string {
  return writeRunResult(buildRunResult('claude-sonnet-5', 'claude-haiku-5', 'api', cases), join(dir, 'run.json'));
}
const run = (path: string) => main({ path, log: (line: string) => log.push(line) });

describe('eval-errors-check', () => {
  it('a credit-out run, every case errored: exits 1 and names the count and the first message', () => {
    const path = resultFile(['a', 'b', 'c'].map(id => errored(id)));
    expect(run(path)).toBe(1);
    expect(log[0]).toMatch(/^::error title=Coach evals errored::3 of 3 coach eval case\(s\) errored, so the run measured nothing\. First \(a\): 400 /);
    expect(log[0]).toContain('credit balance is too low');
    // One cause, said once with its count, not three times.
    expect(log).toContain('1 distinct error message(s):');
    expect(log.filter(l => l.startsWith('  3x 400 '))).toHaveLength(1);
  });

  it('fail and needs-taxonomy verdicts with no errors pass: verdicts stay advisory', () => {
    const path = resultFile([measured('a', 'fail'), measured('b', 'needs-taxonomy'), measured('c')]);
    expect(run(path)).toBe(0);
    expect(log).toEqual(['coach evals: all 3 case(s) measured, none errored.']);
  });

  it('one errored case among measured ones is enough: a key that runs dry mid-run', () => {
    const path = resultFile([measured('a'), measured('b', 'fail'), errored('c', '401 invalid x-api-key')]);
    expect(run(path)).toBe(1);
    expect(log[0]).toContain('1 of 3 coach eval case(s) errored, so the run measured only 2. First (c): 401 invalid x-api-key');
  });

  it('different causes are listed most common first', () => {
    const path = resultFile([
      errored('a', '429 rate_limit_error'), errored('b', CREDIT_OUT), errored('c', CREDIT_OUT),
    ]);
    expect(run(path)).toBe(1);
    expect(log[0]).toContain('First (a): 429 rate_limit_error');
    const i = log.indexOf('2 distinct error message(s):');
    expect(log[i + 1]).toMatch(/^ {2}2x 400 /);
    expect(log[i + 2]).toBe('  1x 429 rate_limit_error');
  });

  it('an empty error message is still an error', () => {
    expect(judge({ cases: [measured('a'), errored('b', '')] }).code).toBe(1);
  });

  it('a result with no cases measured nothing', () => {
    expect(run(resultFile([]))).toBe(1);
    expect(log[0]).toContain('holds no cases');
  });

  it('a missing, unparseable or shapeless file is "could not read" (2), never a pass', () => {
    expect(run(join(dir, 'absent.json'))).toBe(2);
    expect(main({ path: 'x.json', log: () => {}, read: () => '{ not json' })).toBe(2);
    expect(main({ path: 'x.json', log: () => {}, read: () => '{"cases": "nope"}' })).toBe(2);
    expect(main({ log: () => {} })).toBe(2);
  });

  it('a newline or percent in a message cannot end the annotation early', () => {
    expect(escapeData('50%\r\nnext')).toBe('50%25%0D%0Anext');
    const { lines } = judge({ cases: [errored('a', 'line one\nline two')] });
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toContain('line one%0Aline two');
  });

  it('a long message is clipped in the annotation', () => {
    const { lines } = judge({ cases: [errored('a', 'x'.repeat(5000))] });
    expect(lines[0].length).toBeLessThan(500);
    expect(lines[0].endsWith('…')).toBe(true);
  });
});

describe('as a process', () => {
  it('the exit code reaches the shell: 1 for an errored run, 0 for a measured one', () => {
    const bad = resultFile([errored('a')]);
    const r = spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^::error /);
    const good = writeRunResult(buildRunResult('m', 'j', 'api', [measured('a', 'fail')]), join(dir, 'good.json'));
    expect(spawnSync(process.execPath, [SCRIPT, good], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync(process.execPath, [SCRIPT, join(dir, 'absent.json')], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('the nightly evals job', () => {
  const start = ciYml.search(/^ {2}evals:\s*$/m);
  const rest = ciYml.slice(start + 1);
  const next = rest.search(/^ {2}[^\s#]/m);
  const job = next < 0 ? rest : rest.slice(0, next);
  const stepLines = job.slice(job.indexOf('      - name: Run coach evals')).split('\n');
  const runAt = stepLines.findIndex(l => /^ {8}run: \|\s*$/.test(l));
  const body: string[] = [];
  for (const l of stepLines.slice(runAt + 1)) {
    if (l.trim() && !l.startsWith(' '.repeat(10))) break;
    body.push(l.slice(10));
  }
  const script = body.join('\n');

  // The step's own script, under the shell GitHub runs it with (`bash -e`
  // when ci.yml names no shell), with `npm` replaced by a stub that writes a
  // fixture to --out. The stub comes first on PATH and the real key is
  // stripped, so this can never start a real eval.
  function runStep(o: { key?: string; fixture?: CaseResult[]; npmExit?: number }) {
    const work = mkdtempSync(join(dir, 'step-'));
    mkdirSync(join(work, 'scripts'));
    copyFileSync(SCRIPT, join(work, 'scripts', 'eval-errors-check.mjs'));
    const bin = join(work, 'bin');
    mkdirSync(bin);
    const npmLog = join(work, 'npm.log');
    writeFileSync(join(bin, 'npm'), [
      '#!/bin/sh',
      'echo "$@" >> "$STUB_LOG"',
      '[ -n "$STUB_NPM_EXIT" ] && exit "$STUB_NPM_EXIT"',
      'while [ $# -gt 0 ]; do [ "$1" = "--out" ] && out="$2"; shift; done',
      'mkdir -p "$(dirname "$out")" && cp "$STUB_FIXTURE" "$out"',
    ].join('\n'), { mode: 0o755 });
    const fixture = join(work, 'fixture.json');
    writeRunResult(buildRunResult('m', 'j', 'api', o.fixture ?? []), fixture);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    Object.assign(env, {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_RUN_ID: '4242',
      ANTHROPIC_API_KEY: o.key ?? '',
      STUB_LOG: npmLog,
      STUB_FIXTURE: fixture,
      STUB_NPM_EXIT: o.npmExit === undefined ? '' : String(o.npmExit),
    });
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: work, env, encoding: 'utf8' });
    const npmCalls = existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n') : [];
    return { status: r.status, out: `${r.stdout}${r.stderr}`, npmCalls };
  }

  it('is found where the tests look for it', () => {
    expect(start).toBeGreaterThan(0);
    expect(runAt).toBeGreaterThan(0);
    expect(script).toContain('eval-errors-check.mjs');
  });

  it('every case errored: the step fails, naming the count', () => {
    const r = runStep({ key: 'sk-test', fixture: ['a', 'b'].map(id => errored(id)) });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('::error title=Coach evals errored::2 of 2');
    expect(r.npmCalls).toEqual(['run eval -- --out evals/results/nightly-4242.json']);
  });

  it('fail verdicts and no errors: the step passes', () => {
    expect(runStep({ key: 'sk-test', fixture: [measured('a', 'fail'), measured('b')] }).status).toBe(0);
  });

  it('the runner itself fails: the step fails', () => {
    expect(runStep({ key: 'sk-test', npmExit: 1 }).status).not.toBe(0);
  });

  it('no secret: the step passes with a notice and never runs the eval', () => {
    const r = runStep({ fixture: [errored('a')] });
    expect(r.status).toBe(0);
    expect(r.out).toContain('::notice::ANTHROPIC_API_KEY secret not set');
    expect(r.npmCalls).toEqual([]);
  });

  it('nothing lets the step\'s failure through, and the artifact still uploads', () => {
    expect(job).not.toMatch(/continue-on-error/);
    expect(script).toMatch(/result="evals\/results\/[^"]+\.json"/);
    expect(job).toMatch(/- uses: actions\/upload-artifact@\S+\n\s+if: always\(\)\n(\s+.*\n)*?\s+path: evals\/results\/\n/);
  });
});
