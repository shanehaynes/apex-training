import type { ChatWireEvent } from '../../src/lib/coach/wire.js';

// Anthropic event stream → NDJSON wire events. Lifted out of api/chat.ts so
// the post-workout summary (api/_lib/handlers/coachSummary.ts) streams the
// same way the coach does; the client reads both with createWireCollector.

/** Token counters we care about — cache hit/miss is the only way to tell
 *  whether the prompt-cache breakpoints are actually earning their write premium. */
export interface UpstreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Structural subset of the SDK's MessageStreamEvent — keeps the translator
// testable with plain objects.
export interface UpstreamEvent {
  type: string;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string | null };
  /** message_start carries the input + cache counters. */
  message?: { usage?: UpstreamUsage };
  /** message_delta carries the running output count. */
  usage?: UpstreamUsage;
}

/** What one translated stream is worth recording: the merged token counts,
 *  how the turn ended, and how many tool calls it produced. All three go into
 *  a coach_runs row (api/_lib/coachRuns.ts); usage alone used to be logged
 *  and dropped. */
export interface StreamOutcome {
  /** Merged usage from message_start/message_delta, null if the stream carried none. */
  usage: UpstreamUsage | null;
  /** The message_delta's stop_reason, null if the stream never reported one. */
  stopReason: string | null;
  /** Completed tool_use blocks emitted — the turn's tool-call count. */
  toolUseCount: number;
}

/**
 * Translate the Anthropic event stream into the NDJSON wire events. Partial
 * tool-input JSON is buffered and emitted as one complete tool_use per block.
 * Returns what the turn measured (see StreamOutcome) so the handler can log
 * cache effectiveness and record the run.
 */
export async function streamToWireEvents(
  stream: AsyncIterable<UpstreamEvent>,
  emit: (event: ChatWireEvent) => void,
): Promise<StreamOutcome> {
  let currentTool: { id: string; name: string; json: string } | null = null;
  let usage: UpstreamUsage | null = null;
  let stopReason: string | null = null;
  let toolUseCount = 0;

  for await (const event of stream) {
    const eventUsage = event.type === 'message_start' ? event.message?.usage : event.usage;
    if (eventUsage) usage = { ...(usage ?? {}), ...eventUsage };
    // message_delta's delta carries stop_reason (and nothing a content block
    // would recognise, so it never reaches the branches below).
    if (event.type === 'message_delta' && event.delta?.stop_reason != null) {
      stopReason = event.delta.stop_reason;
    }

    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      currentTool = { id: event.content_block.id ?? '', name: event.content_block.name ?? '', json: '' };
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        emit({ type: 'text', delta: event.delta.text });
      } else if (event.delta?.type === 'input_json_delta' && currentTool) {
        currentTool.json += event.delta.partial_json ?? '';
      }
    } else if (event.type === 'content_block_stop' && currentTool) {
      emit({
        type: 'tool_use',
        id: currentTool.id,
        name: currentTool.name,
        input: JSON.parse(currentTool.json || '{}') as Record<string, unknown>,
      });
      currentTool = null;
      toolUseCount += 1;
    }
  }

  emit({ type: 'done' });
  return { usage, stopReason, toolUseCount };
}
