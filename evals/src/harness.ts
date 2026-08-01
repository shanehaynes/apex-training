import { parseISO } from 'date-fns';
import { buildSystemPrompt } from '../../src/lib/coach/prompt';
import { findCoachTool } from '../../src/lib/coach/tools';
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

// The conversation runner. Mirrors useChat.ts exactly:
//   user msg → stream WITH tools → keep LAST tool_use only (useChat.ts:94;
//   extras recorded as a multiToolTurn anomaly) → execute via the real
//   executor against in-memory deps → tool_result → re-stream with tools OFF
//   → next script step. Thinking blocks are dropped from history (the wire
//   protocol has no thinking event). The system prompt is rebuilt from the
//   mutated fixture before every call, as ChatSidebar's useMemo does.

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
  const { deps, state } = createMemoryDeps(evalCase.fixture.events, definitions);
  const today = parseISO(evalCase.fixture.today);
  const todayStr = evalCase.fixture.today;

  const transcript: ApiMessage[] = [];
  const turns: TurnRecord[] = [];
  const toolCalls: RecordedToolCall[] = [];
  const anomalies: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const startedAt = Date.now();

  const buildSystem = (): string => buildSystemPrompt(
    state.events.filter(e => e.date === todayStr),
    state.events,
    today,
    state.definitions.values(),
    evalCase.fixture.athlete,
  );

  // Long thinking streams get killed by flaky networks / sleeping machines
  // ("terminated"); the SDK doesn't retry a stream that dies mid-body, so the
  // harness does — the request is stateless, nothing mutates until a response
  // is processed. Real API errors (4xx) surface immediately.
  const call = async (withTools: boolean) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await callModel({ system: buildSystem(), messages: transcript, withTools });
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

  // One full turn: user text → tools-on stream → optional confirm + tools-off
  // follow-up. Returns whether a tool call was confirmed this turn.
  const runTurn = async (userText: string): Promise<boolean> => {
    transcript.push({ role: 'user', content: userText });
    const turnStart = Date.now();
    const response = await call(true);

    const { text, toolUses } = extractBlocks(response.content);
    if (response.stopReason && response.stopReason !== 'end_turn' && response.stopReason !== 'tool_use') {
      anomalies.push(`stop_reason:${response.stopReason} (turn ${turns.length + 1})`);
    }
    if (toolUses.length > 1) {
      anomalies.push(`multiToolTurn:${toolUses.length} tool_use blocks, kept last (turn ${turns.length + 1})`);
    }
    const toolUse = toolUses.length ? toolUses[toolUses.length - 1] : null;

    const assistantContent: Array<TextBlock | ToolUseBlock> = [];
    if (text) assistantContent.push({ type: 'text', text });
    if (toolUse) assistantContent.push(toolUse);
    transcript.push({
      role: 'assistant',
      content: assistantContent.length === 1 && assistantContent[0].type === 'text'
        ? text
        : assistantContent,
    });

    let assistantText = text;
    if (toolUse) {
      const tool = findCoachTool(toolUse.name);
      let result: string;
      if (!tool) {
        result = `Unknown tool "${toolUse.name}".`;
        anomalies.push(`unknownTool:${toolUse.name} (turn ${turns.length + 1})`);
      } else {
        try {
          result = await tool.execute(toolUse.input, deps);
        } catch (err) {
          result = 'The operation failed — something went wrong on the backend.';
          anomalies.push(`executorThrew:${toolUse.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      toolCalls.push({ name: toolUse.name, input: toolUse.input, result, turn: turns.length + 1 });
      transcript.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: result }],
      });

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
    return toolUse !== null;
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
    createdDefinitionNames: state.createdDefinitionNames,
    anomalies,
    usage,
    latencyMs: Date.now() - startedAt,
  };
}
