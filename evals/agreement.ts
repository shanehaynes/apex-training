import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JUDGE_BEHAVIORS } from './src/judge/refusal';
import type { JudgeBehavior, RunResult } from './src/types';

// Judge-vs-human agreement over every (caseId, transcriptHash) pair that has
// both a judge verdict (from a result file) and a human label. Raw agreement %
// plus a confusion matrix; kappa is deliberately skipped at n≈30 — the CI
// would be too wide to mean anything.
//   npm run eval:agreement

const here = dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = join(here, 'labels', 'labels.json');
const RESULTS_DIR = join(here, 'results');

interface Label { caseId: string; transcriptHash: string; humanBehavior: JudgeBehavior }

function main() {
  if (!existsSync(LABELS_PATH)) {
    console.error('No labels yet — run npm run eval:label first.');
    process.exit(1);
  }
  const labels = JSON.parse(readFileSync(LABELS_PATH, 'utf8')) as Label[];
  const labelKey = new Map(labels.map(l => [`${l.caseId}::${l.transcriptHash}`, l.humanBehavior]));

  const resultFiles = existsSync(RESULTS_DIR)
    ? readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'))
    : [];

  const pairs: Array<{ caseId: string; human: JudgeBehavior; judge: JudgeBehavior; model: string }> = [];
  const seen = new Set<string>();
  for (const file of resultFiles) {
    const run = JSON.parse(readFileSync(join(RESULTS_DIR, file), 'utf8')) as RunResult;
    for (const c of run.cases) {
      const judged = c.verdicts.refusal?.behavior;
      if (!judged || !c.transcriptHash) continue;
      const key = `${c.id}::${c.transcriptHash}`;
      const human = labelKey.get(key);
      if (!human || seen.has(key)) continue;
      seen.add(key);
      pairs.push({ caseId: c.id, human, judge: judged, model: run.judgeModel });
    }
  }

  if (!pairs.length) {
    console.log('No overlapping (label, judge verdict) pairs found yet.');
    return;
  }

  const agree = pairs.filter(p => p.human === p.judge).length;
  console.log(`n = ${pairs.length} labeled transcripts with judge verdicts`);
  console.log(`raw agreement: ${agree}/${pairs.length} (${((agree / pairs.length) * 100).toFixed(0)}%)`);
  console.log('(kappa omitted: at this n the estimate is too noisy to report honestly)');

  // Confusion matrix: rows = human, cols = judge.
  const short = (b: JudgeBehavior) => ({
    refused: 'ref',
    pushed_back_then_refused: 'pb-ref',
    pushed_back_then_complied: 'pb-cmp',
    complied_modified: 'cmp-mod',
    complied: 'cmp',
  }[b]);
  const colWidth = 8;
  console.log(`\n${'human \\ judge'.padEnd(14)}${JUDGE_BEHAVIORS.map(b => short(b).padEnd(colWidth)).join('')}`);
  for (const human of JUDGE_BEHAVIORS) {
    const row = JUDGE_BEHAVIORS.map(judge =>
      String(pairs.filter(p => p.human === human && p.judge === judge).length).padEnd(colWidth)).join('');
    console.log(`${short(human).padEnd(14)}${row}`);
  }

  const disagreements = pairs.filter(p => p.human !== p.judge);
  if (disagreements.length) {
    console.log('\nDisagreements:');
    for (const d of disagreements) console.log(`  ${d.caseId}: human=${d.human} judge=${d.judge} (${d.model})`);
  }
}

main();
