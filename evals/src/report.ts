import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CaseResult, RunResult, VerdictStatus } from './types';

const here = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(here, '..', 'results');
const PROMPT_FILE = join(here, '..', '..', 'src', 'lib', 'coach', 'prompt.ts');

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function gitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: here, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function promptFileHash(): string {
  return sha256(readFileSync(PROMPT_FILE, 'utf8'));
}

const DIMENSIONS = ['constraints', 'progression', 'refusal', 'integrity'] as const;

export function buildRunResult(
  model: string,
  judgeModel: string,
  cases: CaseResult[],
): RunResult {
  const timestamp = new Date().toISOString();
  const passRateByDimension: RunResult['aggregate']['passRateByDimension'] = {};
  for (const dim of DIMENSIONS) {
    let pass = 0, fail = 0, other = 0;
    for (const c of cases) {
      const v = c.verdicts[dim];
      if (!v || v.status === 'skipped') continue;
      if (v.status === 'pass') pass += 1;
      else if (v.status === 'fail') fail += 1;
      else other += 1;
    }
    if (pass + fail + other > 0) passRateByDimension[dim] = { pass, fail, other };
  }
  return {
    runId: `${timestamp.replace(/[:.]/g, '-')}__${model}`,
    timestamp,
    model,
    judgeModel,
    gitCommit: gitCommit(),
    promptFileHash: promptFileHash(),
    cases,
    aggregate: {
      passRateByDimension,
      totalCostUsd: round(cases.reduce((s, c) => s + c.costUsd, 0), 4),
      totalInputTokens: cases.reduce((s, c) => s + c.usage.inputTokens, 0),
      totalOutputTokens: cases.reduce((s, c) => s + c.usage.outputTokens, 0),
      meanLatencyMs: cases.length ? Math.round(cases.reduce((s, c) => s + c.latencyMs, 0) / cases.length) : 0,
    },
  };
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function writeRunResult(run: RunResult): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${run.runId}.json`);
  writeFileSync(path, JSON.stringify(run, null, 2));
  return path;
}

export function writeTranscript(runId: string, caseId: string, transcript: unknown): string {
  const dir = join(RESULTS_DIR, 'transcripts', runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${caseId}.json`);
  writeFileSync(path, JSON.stringify(transcript, null, 2));
  return path;
}

// ─── Terminal table ──────────────────────────────────────────────────────────

const STATUS_ICON: Record<VerdictStatus, string> = {
  pass: '✓',
  fail: '✗',
  'needs-taxonomy': '?',
  skipped: '·',
};

export function printRunTable(run: RunResult): void {
  const idWidth = Math.max(...run.cases.map(c => c.id.length), 8);
  const header = `${'case'.padEnd(idWidth)}  cons prog refu intg  turns  tools  cost      latency`;
  console.log(`\nmodel: ${run.model}   judge: ${run.judgeModel}   commit: ${run.gitCommit.slice(0, 8)}`);
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const c of run.cases) {
    const cell = (dim: typeof DIMENSIONS[number]) => {
      const v = c.verdicts[dim];
      return (v ? STATUS_ICON[v.status] : '·').padEnd(4);
    };
    console.log(
      `${c.id.padEnd(idWidth)}  ${cell('constraints')} ${cell('progression')} ${cell('refusal')} ${cell('integrity')}  ` +
      `${String(c.turns).padEnd(5)}  ${String(c.toolCallCount).padEnd(5)}  $${c.costUsd.toFixed(4)}  ${(c.latencyMs / 1000).toFixed(1)}s` +
      (c.error ? `  ERROR: ${c.error}` : '') +
      (c.anomalies.length ? `  [${c.anomalies.join('; ')}]` : ''),
    );
  }
  console.log('-'.repeat(header.length));
  for (const [dim, r] of Object.entries(run.aggregate.passRateByDimension)) {
    console.log(`${dim}: ${r.pass} pass / ${r.fail} fail${r.other ? ` / ${r.other} needs-taxonomy` : ''}`);
  }
  console.log(
    `total: $${run.aggregate.totalCostUsd.toFixed(4)}  ` +
    `${run.aggregate.totalInputTokens} in / ${run.aggregate.totalOutputTokens} out tokens  ` +
    `mean ${(run.aggregate.meanLatencyMs / 1000).toFixed(1)}s/case`,
  );

  const failures = run.cases.filter(c =>
    Object.values(c.verdicts).some(v => v && v.status !== 'pass' && v.status !== 'skipped'));
  if (failures.length) {
    console.log('\nFailure detail:');
    for (const c of failures) {
      for (const [dim, v] of Object.entries(c.verdicts)) {
        if (!v || v.status === 'pass' || v.status === 'skipped') continue;
        console.log(`  ${c.id} [${dim}] ${v.status}`);
        for (const line of v.detail) console.log(`    ${line}`);
      }
    }
  }
}
