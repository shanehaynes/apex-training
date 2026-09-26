import type Anthropic from '@anthropic-ai/sdk';
import type { ChatWireEvent } from '../../src/lib/coach/wire.js';

// Anthropic event stream → NDJSON wire events. Lifted out of api/chat.ts so
// the post-workout summary (api/_lib/handlers/coachSummary.ts) streams the
// same way the coach does; the client reads both with createWireCollector.
//
// It also rebuilds the assistant message the stream describes — every
// content block, thinking and redacted_thinking included, in order — because
// the coach's server-side tool loop (api/chat.ts) has to hand that message
// back to the API unchanged before the tool results it produced. The SDK's
// own accumulator would do the same, but this one works on the plain event
// objects the tests feed in.

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
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    /** redacted_thinking arrives whole: its opaque payload. */
    data?: string;
  };
  delta?: {
    type: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    /** citations_delta: one citation into a document the turn carried. */
    citation?: Record<string, unknown>;
    stop_reason?: string | null;
  };
  /** message_start carries the input + cache counters. */
  message?: { usage?: UpstreamUsage };
  /** message_delta carries the running output count. */
  usage?: UpstreamUsage;
}

/** What one translated stream is worth recording: the merged token counts,
 *  how the turn ended, how many tool calls it produced, and the message. */
export interface StreamOutcome {
  /** Merged usage from message_start/message_delta, null if the stream carried none. */
  usage: UpstreamUsage | null;
  /** The message_delta's stop_reason, null if the stream never reported one. */
  stopReason: string | null;
  /** Completed tool_use blocks — the response's tool-call count. */
  toolUseCount: number;
  /** The assistant content as the API returned it, in block order: text
   *  (with any citations), thinking, redacted_thinking, tool_use. */
  content: Anthropic.ContentBlockParam[];
}

export interface StreamOptions {
  /**
   * Keep completed tool_use blocks OFF the wire and leave them to the caller
   * (they are still in `content`). The chat loop needs this: a read tool's
   * block becomes a tool_read event and a server-side execution, not a
   * confirm card.
   */
  deferToolUse?: boolean;
  /** Emit `done` when the stream ends. Default true; the chat loop emits its
   *  own once after the last round. */
  done?: boolean;
}

type ToolUseParam = Anthropic.ToolUseBlockParam;
type TextParam = Anthropic.TextBlockParam;
type ThinkingParam = Anthropic.ThinkingBlockParam;
type Citation = NonNullable<TextParam['citations']>[number];

/**
 * Translate the Anthropic event stream into the NDJSON wire events. Partial
 * tool-input JSON is buffered and emitted as one complete tool_use per block.
 * Returns what the turn measured (see StreamOutcome) so the handler can log
 * cache effectiveness, record the run, and continue the conversation.
 */
export async function streamToWireEvents(
  stream: AsyncIterable<UpstreamEvent>,
  emit: (event: ChatWireEvent) => void,
  options: StreamOptions = {},
): Promise<StreamOutcome> {
  const { deferToolUse = false, done = true } = options;
  const content: Anthropic.ContentBlockParam[] = [];
  let usage: UpstreamUsage | null = null;
  let stopReason: string | null = null;
  let toolUseCount = 0;

  // The block being streamed. Tool input arrives as partial JSON, so it is
  // buffered on the side and parsed once at content_block_stop. (An object,
  // not two `let`s: the helpers below assign it, and TypeScript's narrowing
  // cannot see through a closure.)
  const cursor: { block: Anthropic.ContentBlockParam | null; toolJson: string } = { block: null, toolJson: '' };

  const open = (block: Anthropic.ContentBlockParam) => {
    cursor.block = block;
    content.push(block);
  };
  /** A text delta with no open text block (the summary's stream, the tests)
   *  opens one implicitly, so a stream without content_block_start still
   *  yields a well-formed message. */
  const textBlock = (): TextParam => {
    if (cursor.block?.type !== 'text') open({ type: 'text', text: '' });
    return cursor.block as TextParam;
  };

  for await (const event of stream) {
    const eventUsage = event.type === 'message_start' ? event.message?.usage : event.usage;
    if (eventUsage) usage = { ...(usage ?? {}), ...eventUsage };
    // message_delta's delta carries stop_reason (and nothing a content block
    // would recognise, so it never reaches the branches below).
    if (event.type === 'message_delta' && event.delta?.stop_reason != null) {
      stopReason = event.delta.stop_reason;
    }

    if (event.type === 'content_block_start' && event.content_block) {
      const block = event.content_block;
      switch (block.type) {
        case 'tool_use':
          cursor.toolJson = '';
          open({ type: 'tool_use', id: block.id ?? '', name: block.name ?? '', input: {} });
          break;
        case 'thinking':
          open({ type: 'thinking', thinking: '', signature: '' });
          break;
        case 'redacted_thinking':
          open({ type: 'redacted_thinking', data: block.data ?? '' });
          break;
        case 'text':
          open({ type: 'text', text: '' });
          break;
        default:
          // A block kind this coach never asks for (server tools, containers):
          // nothing to accumulate, and nothing to attribute deltas to.
          cursor.block = null;
      }
    } else if (event.type === 'content_block_delta' && event.delta) {
      const delta = event.delta;
      if (delta.type === 'text_delta' && delta.text) {
        textBlock().text += delta.text;
        emit({ type: 'text', delta: delta.text });
      } else if (delta.type === 'citations_delta' && delta.citation) {
        const block = textBlock();
        (block.citations ??= []).push(delta.citation as unknown as Citation);
        const c = delta.citation;
        emit({
          type: 'citation',
          citedText: typeof c.cited_text === 'string' ? c.cited_text : '',
          documentTitle: typeof c.document_title === 'string' ? c.document_title : null,
        });
      } else if (delta.type === 'input_json_delta' && cursor.block?.type === 'tool_use') {
        cursor.toolJson += delta.partial_json ?? '';
      } else if (delta.type === 'thinking_delta' && cursor.block?.type === 'thinking') {
        (cursor.block as ThinkingParam).thinking += delta.thinking ?? '';
      } else if (delta.type === 'signature_delta' && cursor.block?.type === 'thinking') {
        (cursor.block as ThinkingParam).signature = delta.signature ?? '';
      }
    } else if (event.type === 'content_block_stop') {
      if (cursor.block?.type === 'tool_use') {
        const tool = cursor.block as ToolUseParam;
        tool.input = JSON.parse(cursor.toolJson || '{}') as Record<string, unknown>;
        toolUseCount += 1;
        if (!deferToolUse) {
          emit({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input as Record<string, unknown> });
        }
      }
      cursor.block = null;
      cursor.toolJson = '';
    }
  }

  if (done) emit({ type: 'done' });
  return { usage, stopReason, toolUseCount, content };
}
