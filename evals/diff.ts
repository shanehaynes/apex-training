import { readFileSync } from 'node:fs';
import type { RunResult, VerdictStatus } from './src/types';

// Compare two result files: regressions (pass→fail) first, then improvements,
// then everything else that changed, plus cost/latency deltas.
//   npm run eval:diff -- results/A.json results/B.json

// A result file on disk is whatever the run that wrote it knew how to write:
// evals/results/ still holds runs from before promptVersion existed, so this
// reader — unlike RunResult, which describes what a run writes TODAY — has to
// allow the field to be missing rather than assert it and read undefined.
type StoredRunResult = Omit<RunResult, 'promptVersion'> & { promptVersion?: string };

function load(path: string): StoredRunResult {
  return JSON.parse(readFileSync(path, 'utf8')) as StoredRunResult;
}

const DIMENSIONS = ['constraints', 'progression', 'refusal', 'integrity'] as const;

interface Change {
  caseId: string;
  dim: string;
  from: VerdictStatus | 'absent';
  to: VerdictStatus | 'absent';
}

function main() {
  const [pathA, pathB] = process.argv.slice(2);
  if (!pathA || !pathB) {
    console.error('Usage: npm run eval:diff -- <resultA.json> <resultB.json>');
    process.exit(1);
  }
  const a = load(pathA);
  const b = load(pathB);

  console.log(`A: ${a.runId} (${a.model}, commit ${a.gitCommit.slice(0, 8)})`);
  console.log(`B: ${b.runId} (${b.model}, commit ${b.gitCommit.slice(0, 8)})`);
  const versionA = a.promptVersion ?? 'unversioned';
  const versionB = b.promptVersion ?? 'unversioned';
  if (a.promptFileHash !== b.promptFileHash) {
    console.log('NOTE: prompt.ts differs between runs (promptFileHash mismatch).');
  }
  if (versionA !== versionB) {
    console.log(`NOTE: PROMPT_VERSION differs between runs (${versionA} → ${versionB}).`);
  } else if (a.promptFileHash !== b.promptFileHash) {
    // Same version, different bytes. That is an unbumped edit only if both runs
    // actually declared a version — two runs from before the field existed are
    // equal at 'unversioned' for a reason that says nothing about the prompt.
    console.log(a.promptVersion && b.promptVersion
      ? `WARNING: the coach behavior surface changed but PROMPT_VERSION did not (both ${versionA}) — ` +
        'an unbumped edit, so the version no longer identifies the prompt.'
      : 'NOTE: neither run records a PROMPT_VERSION (both predate the field) — the hash is all there is to go on.');
  }

  const byIdB = new Map(b.cases.map(c => [c.id, c]));
  const regressions: Change[] = [];
  const improvements: Change[] = [];
  const otherChanges: Change[] = [];

  for (const caseA of a.cases) {
    const caseB = byIdB.get(caseA.id);
    for (const dim of DIMENSIONS) {
      const from = caseA.verdicts[dim]?.status ?? 'absent';
      const to = caseB?.verdicts[dim]?.status ?? 'absent';
      if (from === to) continue;
      const change: Change = { caseId: caseA.id, dim, from, to };
      if (from === 'pass' && to === 'fail') regressions.push(change);
      else if (from === 'fail' && to === 'pass') improvements.push(change);
      else otherChanges.push(change);
    }
  }
  for (const caseB of b.cases) {
    if (!a.cases.some(c => c.id === caseB.id)) {
      otherChanges.push({ caseId: caseB.id, dim: '(new case)', from: 'absent', to: 'absent' });
    }
  }

  const print = (title: string, changes: Change[]) => {
    if (!changes.length) return;
    console.log(`\n${title}:`);
    for (const c of changes) console.log(`  ${c.caseId} [${c.dim}] ${c.from} → ${c.to}`);
  };
  print('REGRESSIONS (pass → fail)', regressions);
  print('Improvements (fail → pass)', improvements);
  print('Other changes', otherChanges);
  if (!regressions.length && !improvements.length && !otherChanges.length) {
    console.log('\nNo verdict changes.');
  }

  const costDelta = b.aggregate.totalCostUsd - a.aggregate.totalCostUsd;
  const latDelta = b.aggregate.meanLatencyMs - a.aggregate.meanLatencyMs;
  console.log(
    `\ncost: $${a.aggregate.totalCostUsd.toFixed(4)} → $${b.aggregate.totalCostUsd.toFixed(4)} ` +
    `(${costDelta >= 0 ? '+' : ''}$${costDelta.toFixed(4)})`);
  console.log(
    `mean latency: ${(a.aggregate.meanLatencyMs / 1000).toFixed(1)}s → ${(b.aggregate.meanLatencyMs / 1000).toFixed(1)}s ` +
    `(${latDelta >= 0 ? '+' : ''}${(latDelta / 1000).toFixed(1)}s)`);
}

main();
