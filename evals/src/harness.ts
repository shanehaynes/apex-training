import { parseISO } from 'date-fns';
import { buildBuilderPrompt, buildSystemPrompt } from '../../src/lib/coach/prompt';
import { findCoachTool } from '../../src/lib/coach/tools';
import { applyDraftUpdate, describeDraft, emptyDraft, type DraftUpdateInput } from '../../src/lib/builder/draft';
import { createMemoryDeps } from './memoryDeps';
import { loadLibrary } from './library';
import type {
  ApiMessage,
  CallModel,
  EvalCase,
  HarnessResult,
  RecordedToolCall,
  TextBlock,
  ToolUseBlock,
  TurnRecord,
} from './types';

// The conversation runner. Mirrors useChat.ts + actionQueue.ts:
//   user msg → stream WITH tools → confirm EVERY tool_use in emission order
//   via the real executors against in-memory deps → flush all results as ONE
//   tool_result user message → re-stream with tools OFF → next script step.
//   Thinking blocks are dropped from history (the wire protocol has no
//   thinking event). The system prompt is rebuilt from the mutated fixture
//   before every call, as ChatSidebar's resolveSystemPrompt does.

const DEFAULT_CONTINUE = 'Yes, continue.';

function extractBlocks(content: HarnessResultContent): { text: string; toolUses: ToolUseBlock[] } {
  let text = '';
  const toolUses: ToolUseBlock[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block.type === 'tool_use') {
      toolUses.push({
        type: 'tool_use',
        id: String(block.id),
        name: String(block.name),
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return { text, toolUses };
}

type HarnessResultContent = Array<Record<string, unknown> & { type: string }>;

export async function runCase(evalCase: EvalCase, callModel: CallModel): Promise<HarnessResult> {
  const definitions = evalCase.fixture.definitions ?? loadLibrary();
  const { deps, state } = createMemoryDeps(evalCase.fixture.events, definitions, evalCase.fixture.meals ?? []);
  const today = parseISO(evalCase.fixture.today);
  const todayStr = evalCase.fixture.today;

  const transcript: ApiMessage[] = [];
  const turns: TurnRecord[] = [];
  const toolCalls: RecordedToolCall[] = [];
  const anomalies: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const startedAt = Date.now();

  // builder mode: the sidebar loop is replaced by the builder-coach loop —
  // the single update_workout_draft tool reducing onto a draft, exactly as
  // BuilderCoachPanel auto-applies it. Nothing else mutates.
  const mode = evalCase.mode ?? 'chat';
  let draft = emptyDraft(todayStr, evalCase.fixture.draft?.title ?? '');

  // All 7 production arguments — block and today's meals included, so the
  // blockSection and <meals> prompt regions are exercised, not skipped.
  const buildSystem = (): string => mode === 'builder'
    ? buildBuilderPrompt(describeDraft(draft), [], state.definitions.values(), today)
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
    const tool = findCoachTool(name);
    if (!tool) {
      anomalies.push(`unknownTool:${name} (turn ${turns.length + 1})`);
      return `Unknown tool "${name}".`;
    }
    return tool.execute(input, deps);
  };

  // Long thinking streams get killed by flaky networks / sleeping machines
  // ("terminated"); the SDK doesn't retry a stream that dies mid-body, so the
  // harness does — the request is stateless, nothing mutates until a response
  // is processed. Real API errors (4xx) surface immediately.
  const call = async (withTools: boolean) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await callModel({
          system: buildSystem(),
          messages: transcript,
          withTools,
          ...(mode === 'builder' ? { toolMode: 'builder' as const } : {}),
        });
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        return response;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/^4\d\d/.test(message)) throw err;
        lastError = err;
        anomalies.push(`streamRetry:attempt ${attempt + 1} failed: ${message.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastError;
  };

  // One full turn: user text → tools-on stream → confirm every tool_use →
  // one flushed tool_result message + tools-off follow-up. Returns whether
  // any tool call was confirmed this turn.
  const runTurn = async (userText: string): Promise<boolean> => {
    transcript.push({ role: 'user', content: userText });
    const turnStart = Date.now();
    const response = await call(true);

    const { text, toolUses } = extractBlocks(response.content);
    if (response.stopReason && response.stopReason !== 'end_turn' && response.stopReason !== 'tool_use') {
      anomalies.push(`stop_reason:${response.stopReason} (turn ${turns.length + 1})`);
    }

    const assistantContent: Array<TextBlock | ToolUseBlock> = [];
    if (text) assistantContent.push({ type: 'text', text });
    assistantContent.push(...toolUses);
    transcript.push({
      role: 'assistant',
      content: assistantContent.length === 1 && assistantContent[0].type === 'text'
        ? text
        : assistantContent,
    });

    let assistantText = text;
    if (toolUses.length) {
      // Every tool_use is confirmed in emission order (actionQueue.ts holds
      // the results and flushes them as ONE user message once the last one
      // settles — the API requires a tool_result per tool_use up front).
      const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
      for (const toolUse of toolUses) {
        let result: string;
        try {
          result = await executeTool(toolUse.name, toolUse.input);
        } catch (err) {
          result = 'The operation failed — something went wrong on the backend.';
          anomalies.push(`executorThrew:${toolUse.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        toolCalls.push({ name: toolUse.name, input: toolUse.input, result, turn: turns.length + 1 });
        results.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
      }
      transcript.push({ role: 'user', content: results });

      const followup = await call(false);
      const followupBlocks = extractBlocks(followup.content);
      if (followupBlocks.toolUses.length) {
        anomalies.push(`toolUseWithToolsOff (turn ${turns.length + 1})`);
      }
      transcript.push({ role: 'assistant', content: followupBlocks.text });
      assistantText = [text, followupBlocks.text].filter(Boolean).join('\n');
    }

    turns.push({
      userText,
      assistantText,
      stopReason: response.stopReason,
      latencyMs: Date.now() - turnStart,
    });
    return toolUses.length > 0;
  };

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

  return {
    transcript,
    turns,
    toolCalls,
    finalEvents: state.events,
    finalDefinitions: [...state.definitions.values()],
    finalMeals: state.meals,
    createdDefinitionNames: state.createdDefinitionNames,
    ...(mode === 'builder' ? { finalDraft: draft } : {}),
    anomalies,
    usage,
    latencyMs: Date.now() - startedAt,
  };
}
