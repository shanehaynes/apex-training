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
  delta?: { type: string; text?: string; partial_json?: string };
  /** message_start carries the input + cache counters. */
  message?: { usage?: UpstreamUsage };
  /** message_delta carries the running output count. */
  usage?: UpstreamUsage;
}

/**
 * Translate the Anthropic event stream into the NDJSON wire events. Partial
 * tool-input JSON is buffered and emitted as one complete tool_use per block.
 * Returns the merged usage from message_start/message_delta (null if the
 * stream carried none) so the handler can log cache effectiveness.
 */
export async function streamToWireEvents(
  stream: AsyncIterable<UpstreamEvent>,
  emit: (event: ChatWireEvent) => void,
): Promise<UpstreamUsage | null> {
  let currentTool: { id: string; name: string; json: string } | null = null;
  let usage: UpstreamUsage | null = null;

  for await (const event of stream) {
    const eventUsage = event.type === 'message_start' ? event.message?.usage : event.usage;
    if (eventUsage) usage = { ...(usage ?? {}), ...eventUsage };

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
    }
  }

  emit({ type: 'done' });
  return usage;
}
