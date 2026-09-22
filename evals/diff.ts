import { readFileSync } from 'node:fs';
import { classify, type Change, type StoredRunResult } from './src/compare';

// Compare two result files: regressions (pass→fail) first, then improvements,
// then everything else that changed, plus cost/latency deltas.
//   npm run eval:diff -- results/A.json results/B.json
//   npm run eval:diff -- results/A.json results/B.json --fail-on-regression
//
// Without the flag this only reports, exit 0 — that is what it has always
// done, and a human reading two runs does not want a non-zero shell. The flag
// is for a script that wants the verdict as an exit code.

function load(path: string): StoredRunResult {
  return JSON.parse(readFileSync(path, 'utf8')) as StoredRunResult;
}

function main() {
  const argv = process.argv.slice(2);
  const failOnRegression = argv.includes('--fail-on-regression');
  const [pathA, pathB] = argv.filter(a => !a.startsWith('--'));
  if (!pathA || !pathB) {
    console.error('Usage: npm run eval:diff -- <resultA.json> <resultB.json> [--fail-on-regression]');
    process.exit(1);
  }
  const a = load(pathA);
  const b = load(pathB);

  console.log(`A: ${a.runId} (${a.model}${a.backend ? `/${a.backend}` : ''}, commit ${a.gitCommit.slice(0, 8)})`);
  console.log(`B: ${b.runId} (${b.model}${b.backend ? `/${b.backend}` : ''}, commit ${b.gitCommit.slice(0, 8)})`);
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
  if ((a.backend ?? 'api') !== (b.backend ?? 'api')) {
    console.log(
      `NOTE: different backends (${a.backend ?? 'api'} → ${b.backend ?? 'api'}) — the two runtimes ` +
      'differ in tool loop, token accounting and max_tokens (evals/README.md, Backends).');
  }

  const result = classify(a, b);

  const print = (title: string, changes: Change[]) => {
    if (!changes.length) return;
    console.log(`\n${title}:`);
    for (const c of changes) console.log(`  ${c.caseId} [${c.dim}] ${c.from} → ${c.to}`);
  };
  const printIds = (title: string, ids: string[]) => {
    if (!ids.length) return;
    console.log(`\n${title}:`);
    for (const id of ids) console.log(`  ${id}`);
  };
  print('REGRESSIONS (pass → fail / needs-taxonomy)', result.regressions);
  print('Improvements (fail → pass)', result.improvements);
  print('Other changes', result.otherChanges);
  // Broken, not scored — and therefore not evidence either way. Loud, because a
  // half-dead suite otherwise reads as a quiet diff.
  printIds('ERRORED in B (the run broke — no verdict)', result.erroredCases);
  printIds('New cases in B', result.newCases);
  printIds('Cases missing from B', result.missingCases);

  const nothingMoved = !result.regressions.length && !result.improvements.length
    && !result.otherChanges.length && !result.erroredCases.length
    && !result.newCases.length && !result.missingCases.length;
  if (nothingMoved) console.log('\nNo verdict changes.');

  const costDelta = b.aggregate.totalCostUsd - a.aggregate.totalCostUsd;
  const latDelta = b.aggregate.meanLatencyMs - a.aggregate.meanLatencyMs;
  console.log(
    `\ncost: $${a.aggregate.totalCostUsd.toFixed(4)} → $${b.aggregate.totalCostUsd.toFixed(4)} ` +
    `(${costDelta >= 0 ? '+' : ''}$${costDelta.toFixed(4)})`);
  console.log(
    `mean latency: ${(a.aggregate.meanLatencyMs / 1000).toFixed(1)}s → ${(b.aggregate.meanLatencyMs / 1000).toFixed(1)}s ` +
    `(${latDelta >= 0 ? '+' : ''}${(latDelta / 1000).toFixed(1)}s)`);

  if (failOnRegression && (result.regressions.length || result.erroredCases.length)) {
    console.error(
      `\n${result.regressions.length} regression(s), ${result.erroredCases.length} errored case(s) — failing.`);
    process.exit(1);
  }
}

main();
