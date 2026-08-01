import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sha256 } from './src/report';
import { JUDGE_BEHAVIORS } from './src/judge/refusal';
import type { JudgeBehavior, RunResult } from './src/types';

// Interactive human labeling of refusal-case transcripts. Human verdicts are
// the oracle the LLM judge is measured against (agreement.ts). Labels key on
// (caseId, transcriptHash) so a verdict attaches to the exact conversation it
// judged, and is reused across runs that reproduce it.
//   npm run eval:label -- results/<run>.json

const here = dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = join(here, 'labels', 'labels.json');

interface Label {
  caseId: string;
  transcriptHash: string;
  humanBehavior: JudgeBehavior;
  notes: string;
  labeledAt: string;
}

function loadLabels(): Label[] {
  if (!existsSync(LABELS_PATH)) return [];
  return JSON.parse(readFileSync(LABELS_PATH, 'utf8')) as Label[];
}

function saveLabels(labels: Label[]): void {
  mkdirSync(dirname(LABELS_PATH), { recursive: true });
  writeFileSync(LABELS_PATH, JSON.stringify(labels, null, 2));
}

interface StoredTranscript {
  caseId: string;
  apiMessages: unknown[];
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string; turn: number }>;
}

function renderStored(t: StoredTranscript): string {
  const lines: string[] = [];
  for (const msg of t.apiMessages as Array<{ role: string; content: unknown }>) {
    if (typeof msg.content === 'string') {
      lines.push(`${msg.role.toUpperCase()}: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'text') lines.push(`${msg.role.toUpperCase()}: ${String(block.text)}`);
        if (block.type === 'tool_use') lines.push(`  [tool_use ${String(block.name)}: ${JSON.stringify(block.input)}]`);
        if (block.type === 'tool_result') lines.push(`  [tool_result: ${String(block.content)}]`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const runPath = process.argv[2];
  if (!runPath) {
    console.error('Usage: npm run eval:label -- results/<run>.json');
    process.exit(1);
  }
  const run = JSON.parse(readFileSync(runPath, 'utf8')) as RunResult;
  const labels = loadLabels();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const refusalCases = run.cases.filter(c => c.verdicts.refusal && !c.error);
  console.log(`${refusalCases.length} refusal case(s) in this run.\n`);

  for (const caseResult of refusalCases) {
    const transcriptDir = join(here, 'results', 'transcripts', run.runId);
    const files = existsSync(transcriptDir) ? readdirSync(transcriptDir) : [];
    const file = files.find(f => f === `${caseResult.id}.json`);
    if (!file) {
      console.log(`skipping ${caseResult.id}: transcript file not found`);
      continue;
    }
    const stored = JSON.parse(readFileSync(join(transcriptDir, file), 'utf8')) as StoredTranscript;
    const hash = caseResult.transcriptHash || sha256(JSON.stringify(stored.apiMessages));

    const existing = labels.find(l => l.caseId === caseResult.id && l.transcriptHash === hash);
    if (existing) {
      console.log(`${caseResult.id}: already labeled (${existing.humanBehavior}) — skipping`);
      continue;
    }

    console.log('='.repeat(78));
    console.log(`CASE: ${caseResult.id}`);
    console.log('='.repeat(78));
    console.log(renderStored(stored));
    console.log('Behaviors:');
    JUDGE_BEHAVIORS.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
    const answer = await rl.question('Your verdict (1-5, or s to skip): ');
    if (answer.trim().toLowerCase() === 's') continue;
    const idx = parseInt(answer.trim(), 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= JUDGE_BEHAVIORS.length) {
      console.log('invalid — skipping');
      continue;
    }
    const notes = await rl.question('Notes (optional): ');
    labels.push({
      caseId: caseResult.id,
      transcriptHash: hash,
      humanBehavior: JUDGE_BEHAVIORS[idx],
      notes: notes.trim(),
      labeledAt: new Date().toISOString(),
    });
    saveLabels(labels);
    console.log('saved.\n');
  }

  rl.close();
  console.log(`Done. ${labels.length} label(s) total in labels/labels.json.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
