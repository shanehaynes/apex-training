import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { ALL_CASES } from './cases/index';
import { runCase } from './src/harness';
import { checkConstraints } from './src/checkers/constraints';
import { checkProgression } from './src/checkers/progression';
import { checkIntegrity } from './src/checkers/integrity';
import { judgeRefusal } from './src/judge/refusal';
import { makeApiBackend } from './src/backends/api';
import { makeAgentSdkBackend } from './src/backends/agentSdk';
import { makeAgentSdkJudge, makeApiJudge, type JudgeCall } from './src/backends/judge';
import {
  costUsd,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_MODEL,
  evalApiKey,
  evalOauthToken,
  makeAnthropicCaller,
  makeClient,
} from './src/models';
import { buildRunResult, printRunTable, sha256, writeRunResult, writeTranscript } from './src/report';
import type { Backend, BackendKind, CaseResult, EvalCase } from './src/types';

// On-demand eval runner.
//   npm run eval                                    # full suite, default model, API backend
//   npm run eval -- --model claude-opus-5           # production arm
//   npm run eval -- --case pulley-injury            # single case (substring match)
//   npm run eval -- --case a,b,c                    # several cases (exact ids)
//   npm run eval -- --dims constraints,refusal      # restrict checked dimensions
//   npm run eval -- --backend agent-sdk             # spend a subscription, not a key
//   npm run eval -- --out evals/results/mine.json   # name the result file
//
// --backend defaults to `api`, so every command that worked before this flag
// existed still runs exactly the same way.

function parseArgs(argv: string[]) {
  const args = {
    model: DEFAULT_MODEL,
    judgeModel: DEFAULT_JUDGE_MODEL,
    caseFilter: '',
    dims: '',
    backend: 'api' as BackendKind,
    judgeBackend: '' as '' | BackendKind,
    out: '',
  };
  const backendArg = (raw: string): BackendKind => {
    if (raw !== 'api' && raw !== 'agent-sdk') {
      throw new Error(`Unknown backend "${raw}" — expected "api" or "agent-sdk".`);
    }
    return raw;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--judge-model') args.judgeModel = argv[++i];
    else if (argv[i] === '--case') args.caseFilter = argv[++i];
    else if (argv[i] === '--dims') args.dims = argv[++i];
    else if (argv[i] === '--backend') args.backend = backendArg(argv[++i]);
    else if (argv[i] === '--judge-backend') args.judgeBackend = backendArg(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

/** One value keeps the substring semantics it has always had; a comma-separated
 *  list selects those ids exactly, so a set of cases can be named without a
 *  substring accidentally dragging a neighbour in. */
export function selectCases(cases: EvalCase[], filter: string): EvalCase[] {
  if (!filter) return cases;
  const parts = filter.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return cases.filter(c => c.id.includes(parts[0] ?? filter));
  const wanted = new Set(parts);
  return cases.filter(c => wanted.has(c.id));
}

function oauthTokenOrThrow(): string {
  const token = evalOauthToken();
  if (!token) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN is not set — run `claude setup-token` and export it, or add a ' +
        'CLAUDE_CODE_OAUTH_TOKEN= line to .env.local. The agent-sdk backend runs on a Claude ' +
        'subscription and never on an API key.',
    );
  }
  return token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dims = args.dims ? new Set(args.dims.split(',').map(d => d.trim())) : null;
  const wants = (dim: string) => !dims || dims.has(dim);

  let cases: EvalCase[] = selectCases(ALL_CASES, args.caseFilter);
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

  // The judge falls back to the subscription when no API key resolves, so a
  // machine with only a token can run the whole suite.
  const judgeBackend: BackendKind = args.judgeBackend || (evalApiKey() ? 'api' : 'agent-sdk');

  // Lazy: an all-subscription run must never require a key to exist.
  let client: Anthropic | undefined;
  const anthropic = () => (client ??= makeClient());

  const backend: Backend = args.backend === 'agent-sdk'
    ? makeAgentSdkBackend({ model: args.model, oauthToken: oauthTokenOrThrow() })
    : makeApiBackend(makeAnthropicCaller(anthropic(), args.model));

  const judge: JudgeCall = judgeBackend === 'agent-sdk'
    ? makeAgentSdkJudge({ model: args.judgeModel, oauthToken: oauthTokenOrThrow() })
    : makeApiJudge(anthropic(), args.judgeModel);

  console.log(
    `Running ${cases.length} case(s) on ${args.model} via ${args.backend} ` +
    `(judge: ${args.judgeModel} via ${judgeBackend})`);

  const results: CaseResult[] = [];
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${runStamp}__${args.model}`;

  for (const evalCase of cases) {
    process.stdout.write(`  ${evalCase.id} ... `);
    try {
      const harness = await runCase(evalCase, backend);
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
          judge, harness,
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
        // A backend that reported no tokens gets 0 and a flag, never a
        // measured-looking zero.
        costUsd: harness.usageUnavailable ? 0 : costUsd(args.model, harness.usage),
        ...(harness.usageUnavailable ? { usageUnavailable: true } : {}),
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

  const run = buildRunResult(args.model, args.judgeModel, args.backend, results);
  run.runId = runId;
  const path = writeRunResult(run, args.out ? resolve(args.out) : undefined);
  printRunTable(run);
  console.log(`\nResults written to ${path}`);
}

// Only when run as the entry point, so the pure helpers above (selectCases)
// can be imported by a test without launching a suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
