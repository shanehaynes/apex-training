import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { escapeData, judge, main } from '../eval-errors-check.mjs';
import { buildRunResult, writeRunResult } from '../../evals/src/report';
import type { CaseResult } from '../../evals/src/types';

const ciYml = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');

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

/** Through the runner's own writer, so a rename of the field it records
 *  errors under fails here rather than going quietly green in CI. */
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

describe('the nightly evals job runs the check', () => {
  const start = ciYml.search(/^ {2}evals:\s*$/m);
  const rest = ciYml.slice(start + 1);
  const next = rest.search(/^ {2}[^\s#]/m);
  const job = next < 0 ? rest : rest.slice(0, next);
  const step = job.slice(job.indexOf('- name: Run coach evals'));

  it('writes the result where the check reads it, after the skip-without-secret exit', () => {
    expect(start).toBeGreaterThan(0);
    const out = step.match(/npm run eval -- --out "(\$\w+)"/);
    const checked = step.match(/node scripts\/eval-errors-check\.mjs "(\$\w+)"/);
    expect(out?.[1]).toBeDefined();
    expect(checked?.[1]).toBe(out?.[1]);
    expect(step.indexOf('exit 0')).toBeGreaterThan(0);
    expect(step.indexOf('exit 0')).toBeLessThan(step.indexOf('npm run eval'));
    expect(step.indexOf('npm run eval')).toBeLessThan(step.indexOf('eval-errors-check.mjs "'));
  });

  it('the result file lands under evals/results/, which the artifact uploads', () => {
    expect(step).toMatch(/result="evals\/results\/[^"]+\.json"/);
    expect(job).toMatch(/path: evals\/results\/\n/);
  });
});
