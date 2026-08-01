import { ALL_CASES } from './cases/index';
import { runCase } from './src/harness';
import { checkConstraints } from './src/checkers/constraints';
import { checkProgression } from './src/checkers/progression';
import { checkIntegrity } from './src/checkers/integrity';
import { judgeRefusal } from './src/judge/refusal';
import { costUsd, DEFAULT_JUDGE_MODEL, DEFAULT_MODEL, makeAnthropicCaller, makeClient } from './src/models';
import { buildRunResult, printRunTable, sha256, writeRunResult, writeTranscript } from './src/report';
import type { CaseResult, EvalCase } from './src/types';

// On-demand eval runner.
//   npm run eval                                # full suite on the default (Sonnet) model
//   npm run eval -- --model claude-opus-4-8     # production arm
//   npm run eval -- --case pulley-injury        # single case (substring match)
//   npm run eval -- --dims constraints,refusal  # restrict checked dimensions

function parseArgs(argv: string[]) {
  const args = { model: DEFAULT_MODEL, judgeModel: DEFAULT_JUDGE_MODEL, caseFilter: '', dims: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--judge-model') args.judgeModel = argv[++i];
    else if (argv[i] === '--case') args.caseFilter = argv[++i];
    else if (argv[i] === '--dims') args.dims = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dims = args.dims ? new Set(args.dims.split(',').map(d => d.trim())) : null;
  const wants = (dim: string) => !dims || dims.has(dim);

  let cases: EvalCase[] = ALL_CASES;
  if (args.caseFilter) cases = cases.filter(c => c.id.includes(args.caseFilter));
  if (dims) {
    cases = cases.filter(c =>
      (wants('constraints') && c.expect.constraints) ||
      (wants('progression') && c.expect.progression) ||
      (wants('refusal') && c.expect.refusal) ||
      (wants('integrity') && c.expect.integrity));
  }
  if (!cases.length) {
    console.error('No cases matched.');
    process.exit(1);
  }

  const client = makeClient();
  const callModel = makeAnthropicCaller(client, args.model);
  console.log(`Running ${cases.length} case(s) on ${args.model} (judge: ${args.judgeModel})`);

  const results: CaseResult[] = [];
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${runStamp}__${args.model}`;

  for (const evalCase of cases) {
    process.stdout.write(`  ${evalCase.id} ... `);
    try {
      const harness = await runCase(evalCase, callModel);
      const verdicts: CaseResult['verdicts'] = {};
      if (evalCase.expect.constraints && wants('constraints')) {
        verdicts.constraints = checkConstraints(evalCase, harness.toolCalls, harness.finalDefinitions);
      }
      if (evalCase.expect.progression && wants('progression')) {
        verdicts.progression = checkProgression(evalCase, harness.finalEvents, harness.finalDefinitions);
      }
      if (evalCase.expect.integrity && wants('integrity')) {
        verdicts.integrity = checkIntegrity(evalCase, harness);
      }
      if (evalCase.expect.refusal && wants('refusal')) {
        verdicts.refusal = await judgeRefusal(
          client, args.judgeModel, harness,
          evalCase.expect.refusal.expected, evalCase.expect.refusal.rubric,
          evalCase.expect.refusal.acceptable);
      }
      const transcriptPath = writeTranscript(runId, evalCase.id, {
        caseId: evalCase.id,
        apiMessages: harness.transcript,
        toolCalls: harness.toolCalls,
        anomalies: harness.anomalies,
      });
      const statuses = Object.values(verdicts).map(v => v.status);
      results.push({
        id: evalCase.id,
        verdicts,
        turns: harness.turns.length,
        toolCallCount: harness.toolCalls.length,
        anomalies: harness.anomalies,
        usage: harness.usage,
        costUsd: costUsd(args.model, harness.usage),
        latencyMs: harness.latencyMs,
        transcriptHash: sha256(JSON.stringify(harness.transcript)),
        transcriptPath,
      });
      console.log(statuses.length ? statuses.join('/') : 'no-dims');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        id: evalCase.id,
        verdicts: {},
        turns: 0,
        toolCallCount: 0,
        anomalies: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        transcriptHash: '',
        transcriptPath: '',
        error: message,
      });
      console.log(`ERROR: ${message}`);
    }
  }

  const run = buildRunResult(args.model, args.judgeModel, results);
  run.runId = runId;
  const path = writeRunResult(run);
  printRunTable(run);
  console.log(`\nResults written to ${path}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
