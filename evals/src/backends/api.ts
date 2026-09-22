import type {
  ApiMessage,
  Backend,
  CallModel,
  ModelResponse,
  TextBlock,
  ToolUseBlock,
  TurnOutcome,
  TurnRequest,
  TurnToolCall,
} from '../types';

// The Messages-API backend: the conversation loop the harness has always run,
// lifted behind RunTurn unchanged. Production-shaped, and the measurement of
// record — every existing `npm run eval` invocation lands here and produces
// the same transcript, the same anomalies in the same order, and the same
// transcriptHash inputs it did before the seam existed.
//
//   user msg → stream WITH tools → confirm EVERY tool_use in emission order
//   via the real executors → flush all results as ONE tool_result user message
//   → re-stream with tools OFF (production's tool_choice: none re-stream)
//   → next script step.
//
// Thinking blocks are dropped from history (the wire protocol has no thinking
// event). The system prompt is rebuilt from the mutated fixture before every
// call, as ChatSidebar's resolveSystemPrompt does.

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

export function makeApiBackend(callModel: CallModel): Backend {
  const runTurn = async (req: TurnRequest): Promise<TurnOutcome> => {
    const { userText, transcript, buildSystem, executeTool, toolMode, turnIndex, anomaly } = req;
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

    transcript.push({ role: 'user', content: userText });
    const response = await call(true);

    const { text, toolUses } = extractBlocks(response.content);
    if (response.stopReason && response.stopReason !== 'end_turn' && response.stopReason !== 'tool_use') {
      anomaly(`stop_reason:${response.stopReason} (turn ${turnIndex})`);
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
    const toolCalls: TurnToolCall[] = [];
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
          anomaly(`executorThrew:${toolUse.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        toolCalls.push({ name: toolUse.name, input: toolUse.input, resultText: result });
        results.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
      }
      transcript.push({ role: 'user', content: results } as ApiMessage);

      const followup = await call(false);
      const followupBlocks = extractBlocks(followup.content);
      if (followupBlocks.toolUses.length) {
        anomaly(`toolUseWithToolsOff (turn ${turnIndex})`);
      }
      transcript.push({ role: 'assistant', content: followupBlocks.text });
      assistantText = [text, followupBlocks.text].filter(Boolean).join('\n');
    }

    return {
      assistantBlocks: assistantContent,
      assistantText,
      toolCalls,
      stopReason: response.stopReason,
      usage,
    };
  };

  return { kind: 'api', runTurn };
}
