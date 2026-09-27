import { isServerSideTool } from '../../../src/lib/coach/tools';
import { MAX_SERVER_ROUNDS } from '../reads';
import type {
  ApiMessage,
  Backend,
  CallModel,
  ModelResponse,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  TurnOutcome,
  TurnRequest,
  TurnToolCall,
} from '../types';

// The Messages-API backend: the conversation loop api/chat.ts + useChat.ts
// run, lifted behind RunTurn. Production-shaped, and the measurement of
// record.
//
//   user msg → stream WITH tools
//     → a response asking only for server-side tools (reads, read_doctrine)
//       is answered here — assistant content echoed, ONE tool_result user
//       message — and the model is called again WITH tools, up to
//       MAX_SERVER_ROUNDS times (api/chat.ts, "THE SIGHT LOOP")
//     → a response with any write tool_use ends the loop: its reads run
//       first, then every write is confirmed in emission order via the real
//       executors, and all results flush as ONE tool_result user message with
//       the read results ahead of the write results (useChat's heldResults)
//     → re-stream with tools OFF (production's tool_choice: none re-stream)
//   → next script step.
//
// A turn with no reads produces byte-for-byte the transcript this backend
// produced before the sight loop existed. Thinking blocks are dropped from
// history (the wire protocol has no thinking event, and the stored thread
// production replays carries none — see DECISIONS in evals/README.md,
// "Reads and doctrine"). The system prompt is rebuilt from the mutated
// fixture before every call, as ChatSidebar's resolveSystemPrompt does.

type ResponseContent = Array<Record<string, unknown> & { type: string }>;

export function extractBlocks(content: ResponseContent): { text: string; toolUses: ToolUseBlock[] } {
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

/** The assistant message as the thread stores it: a bare string for a
 *  text-only reply, the block array otherwise. */
function assistantMessage(text: string, toolUses: ToolUseBlock[]): ApiMessage {
  const content: Array<TextBlock | ToolUseBlock> = [];
  if (text) content.push({ type: 'text', text });
  content.push(...toolUses);
  return {
    role: 'assistant',
    content: content.length === 1 && content[0].type === 'text' ? text : content,
  };
}

export function makeApiBackend(callModel: CallModel): Backend {
  const runTurn = async (req: TurnRequest): Promise<TurnOutcome> => {
    const { userText, transcript, buildSystem, executeTool, executeRead, toolMode, turnIndex, anomaly } = req;
    const usage = { inputTokens: 0, outputTokens: 0 };

    // Long thinking streams get killed by flaky networks / sleeping machines
    // ("terminated"); the SDK doesn't retry a stream that dies mid-body, so
    // the harness does — the request is stateless, nothing mutates until a
    // response is processed. Real API errors (4xx) surface immediately.
    const call = async (withTools: boolean): Promise<ModelResponse> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await callModel({
            system: buildSystem(),
            messages: transcript,
            withTools,
            ...(toolMode ? { toolMode } : {}),
          });
          usage.inputTokens += response.usage.inputTokens;
          usage.outputTokens += response.usage.outputTokens;
          return response;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/^4\d\d/.test(message)) throw err;
          lastError = err;
          anomaly(`streamRetry:attempt ${attempt + 1} failed: ${message.slice(0, 80)}`);
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      throw lastError;
    };

    // Reads are answered from the fixture and never throw (executeServerSideTool
    // has that contract); a write goes through the real executor, whose throw
    // is the "backend failed" tool_result production would send.
    const runRead = async (toolUse: ToolUseBlock): Promise<ToolResultBlock> => {
      const outcome = await executeRead!(toolUse.name, toolUse.input);
      toolCalls.push({ name: toolUse.name, input: toolUse.input, resultText: outcome.text, kind: 'read', round: rounds });
      const block: ToolResultBlock & { is_error?: boolean } = {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: outcome.content ?? outcome.text,
        ...(outcome.isError ? { is_error: true } : {}),
      };
      return block;
    };
    const runWrite = async (toolUse: ToolUseBlock): Promise<ToolResultBlock> => {
      let result: string;
      try {
        result = await executeTool(toolUse.name, toolUse.input);
      } catch (err) {
        result = 'The operation failed — something went wrong on the backend.';
        anomaly(`executorThrew:${toolUse.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      toolCalls.push({ name: toolUse.name, input: toolUse.input, resultText: result, kind: 'write', round: rounds });
      return { type: 'tool_result', tool_use_id: toolUse.id, content: result };
    };

    transcript.push({ role: 'user', content: userText });

    const toolCalls: TurnToolCall[] = [];
    const texts: string[] = [];
    let assistantBlocks: Array<TextBlock | ToolUseBlock> = [];
    let stopReason: string | null = null;
    let rounds = 0;

    for (;;) {
      const response = await call(true);
      const { text, toolUses } = extractBlocks(response.content);
      stopReason = response.stopReason;
      if (stopReason && stopReason !== 'end_turn' && stopReason !== 'tool_use') {
        anomaly(`stop_reason:${stopReason} (turn ${turnIndex})`);
      }
      if (text) texts.push(text);

      // Without executeRead (builder, analytics, a pre-sight-loop caller)
      // every tool_use is a write, as it always was.
      const reads = executeRead ? toolUses.filter(t => isServerSideTool(t.name)) : [];
      const writes = executeRead ? toolUses.filter(t => !isServerSideTool(t.name)) : toolUses;

      if (reads.length && !writes.length && rounds >= MAX_SERVER_ROUNDS) {
        // Production stops the loop BEFORE running the reads and sends a
        // notice; the tool_use blocks never reach the client, so the stored
        // turn ends on the text alone. Same here, so the transcript stays
        // API-valid (no unanswered tool_use).
        anomaly(`serverRoundCap:${rounds} (turn ${turnIndex})`);
        assistantBlocks = text ? [{ type: 'text', text }] : [];
        transcript.push(assistantMessage(text, []));
        break;
      }

      assistantBlocks = [...(text ? [{ type: 'text', text } as TextBlock] : []), ...toolUses];
      transcript.push(assistantMessage(text, toolUses));
      if (!toolUses.length) break;

      // Read results lead the tool_result message (useChat folds a mixed
      // round's held read results ahead of the confirm flow's write results).
      const results: ToolResultBlock[] = [];
      for (const toolUse of reads) results.push(await runRead(toolUse));

      if (!writes.length) {
        // A read-only round: answer it and call again with tools ON.
        rounds += 1;
        transcript.push({ role: 'user', content: results });
        continue;
      }

      // Every write is confirmed in emission order (actionQueue.ts holds the
      // results and flushes them as ONE user message once the last one
      // settles — the API requires a tool_result per tool_use up front).
      for (const toolUse of writes) results.push(await runWrite(toolUse));
      transcript.push({ role: 'user', content: results });

      const followup = await call(false);
      const followupBlocks = extractBlocks(followup.content);
      if (followupBlocks.toolUses.length) {
        anomaly(`toolUseWithToolsOff (turn ${turnIndex})`);
      }
      transcript.push({ role: 'assistant', content: followupBlocks.text });
      if (followupBlocks.text) texts.push(followupBlocks.text);
      break;
    }

    return {
      assistantBlocks,
      assistantText: texts.join('\n'),
      toolCalls,
      stopReason,
      usage,
    };
  };

  return { kind: 'api', runTurn };
}
