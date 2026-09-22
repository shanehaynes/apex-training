import { parseISO } from 'date-fns';
import { buildBuilderPrompt, buildSystemPrompt } from '../../src/lib/coach/prompt';
import { findCoachTool } from '../../src/lib/coach/tools';
import { applyDraftUpdate, describeDraft, emptyDraft, type DraftUpdateInput } from '../../src/lib/builder/draft';
import { applyChartDraftUpdate, describeChartDraft, emptyChartDraft, type DraftUpdateInput as ChartDraftUpdateInput } from '../../src/lib/analytics/draft';
import { buildAnalyticsPrompt } from '../../src/lib/coach/prompt';
import { createMemoryDeps } from './memoryDeps';
import { loadLibrary } from './library';
import { makeApiBackend } from './backends/api';
import type {
  ApiMessage,
  Backend,
  CallModel,
  EvalCase,
  HarnessResult,
  RecordedToolCall,
  SessionHandle,
  TurnRecord,
} from './types';

// The conversation runner. It owns the fixture, the in-memory deps, the real
// tool executors and the production prompt builders; a BACKEND owns how one
// scripted turn reaches a model. See types.ts (`TurnRequest`) for why the seam
// sits at the turn and not at the single API call.
//
// Passing a bare CallModel still works and is exactly the old behavior — it is
// wrapped in the API backend, whose loop is the loop this file used to hold.

const DEFAULT_CONTINUE = 'Yes, continue.';

export async function runCase(
  evalCase: EvalCase,
  backendOrCallModel: CallModel | Backend,
): Promise<HarnessResult> {
  // A CallModel is a bare function; a Backend is an object. Tests and every
  // existing caller hand over the former.
  const backend: Backend = typeof backendOrCallModel === 'function'
    ? makeApiBackend(backendOrCallModel)
    : backendOrCallModel;

  const definitions = evalCase.fixture.definitions ?? loadLibrary();
  const { deps, state } = createMemoryDeps(evalCase.fixture.events, definitions, evalCase.fixture.meals ?? []);
  const today = parseISO(evalCase.fixture.today);
  const todayStr = evalCase.fixture.today;

  const transcript: ApiMessage[] = [];
  const turns: TurnRecord[] = [];
  const toolCalls: RecordedToolCall[] = [];
  const anomalies: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let usageUnavailable = false;
  let session: SessionHandle | undefined;
  const startedAt = Date.now();

  // builder mode: the sidebar loop is replaced by the builder-coach loop —
  // the single update_workout_draft tool reducing onto a draft, exactly as
  // BuilderCoachPanel auto-applies it. Nothing else mutates.
  const mode = evalCase.mode ?? 'chat';
  let draft = emptyDraft(todayStr, evalCase.fixture.draft?.title ?? '');
  let chartDraft = emptyChartDraft();

  // All 7 production arguments — block and today's meals included, so the
  // blockSection and <meals> prompt regions are exercised, not skipped.
  const buildSystem = (): string => mode === 'builder'
    ? buildBuilderPrompt(describeDraft(draft), [], state.definitions.values(), today)
    : mode === 'analytics'
    ? buildAnalyticsPrompt(describeChartDraft(chartDraft), [], today)
    : buildSystemPrompt(
        state.events.filter(e => e.date === todayStr),
        state.events,
        today,
        state.definitions.values(),
        evalCase.fixture.athlete,
        evalCase.fixture.block ?? null,
        state.meals.filter(m => m.date === todayStr),
      );

  const executeTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
    if (mode === 'builder') {
      if (name !== 'update_workout_draft') {
        anomalies.push(`unknownTool:${name} (turn ${turns.length + 1})`);
        return `Unknown tool "${name}".`;
      }
      const applied = applyDraftUpdate(draft, input as DraftUpdateInput, state.definitions);
      if ('error' in applied) return applied.error;
      draft = applied.draft;
      return applied.summary;
    }
    if (mode === 'analytics') {
      if (name !== 'update_chart_draft') {
        anomalies.push(`unknownTool:${name} (turn ${turns.length + 1})`);
        return `Unknown tool "${name}".`;
      }
      const applied = applyChartDraftUpdate(chartDraft, input as ChartDraftUpdateInput);
      if ('error' in applied) return applied.error;
      chartDraft = applied.draft;
      return applied.summary;
    }
    const tool = findCoachTool(name);
    if (!tool) {
      anomalies.push(`unknownTool:${name} (turn ${turns.length + 1})`);
      return `Unknown tool "${name}".`;
    }
    return tool.execute(input, deps);
  };

  // One scripted turn. Returns whether any tool call was confirmed, which is
  // what auto-continue keys on.
  const runTurn = async (userText: string): Promise<boolean> => {
    const turnStart = Date.now();
    const outcome = await backend.runTurn({
      userText,
      transcript,
      buildSystem,
      executeTool,
      ...(mode === 'builder' || mode === 'analytics' ? { toolMode: mode } : {}),
      turnIndex: turns.length + 1,
      session,
      anomaly: text => anomalies.push(text),
    });

    if (outcome.session) session = outcome.session;
    if (outcome.usage) {
      usage.inputTokens += outcome.usage.inputTokens;
      usage.outputTokens += outcome.usage.outputTokens;
    } else {
      usageUnavailable = true;
    }
    for (const call of outcome.toolCalls) {
      toolCalls.push({ name: call.name, input: call.input, result: call.resultText, turn: turns.length + 1 });
    }

    turns.push({
      userText,
      assistantText: outcome.assistantText,
      stopReason: outcome.stopReason,
      latencyMs: Date.now() - turnStart,
    });
    return outcome.toolCalls.length > 0;
  };

  try {
    let lastTurnHadToolCall = false;
    for (const step of evalCase.script) {
      if (step.kind === 'user') {
        lastTurnHadToolCall = await runTurn(step.text);
      } else {
        for (let i = 0; i < step.max && lastTurnHadToolCall; i++) {
          lastTurnHadToolCall = await runTurn(step.text ?? DEFAULT_CONTINUE);
        }
      }
    }
  } finally {
    backend.endCase?.();
  }

  return {
    transcript,
    turns,
    toolCalls,
    finalEvents: state.events,
    finalDefinitions: [...state.definitions.values()],
    finalMeals: state.meals,
    createdDefinitionNames: state.createdDefinitionNames,
    ...(mode === 'builder' ? { finalDraft: draft } : {}),
    ...(mode === 'analytics' ? { finalChartDraft: chartDraft } : {}),
    anomalies,
    usage,
    ...(usageUnavailable ? { usageUnavailable: true } : {}),
    latencyMs: Date.now() - startedAt,
  };
}
