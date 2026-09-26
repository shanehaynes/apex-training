import { describe, it, expect } from 'vitest';
import { streamToWireEvents, type UpstreamEvent } from '../_lib/wire';
import type { ChatWireEvent } from '../../src/lib/coach/wire';

// The translator's second job since the sight loop: rebuild the assistant
// message the stream describes, so api/chat.ts can hand it back to the API
// unchanged before the tool results it produced. The wire-event half is
// pinned in chat.test.ts (streamToWireEvents suite); this file pins the
// message and the two options the chat loop uses.

async function* upstream(events: UpstreamEvent[]): AsyncIterable<UpstreamEvent> {
  for (const event of events) yield event;
}

async function run(events: UpstreamEvent[], options?: Parameters<typeof streamToWireEvents>[2]) {
  const out: ChatWireEvent[] = [];
  const outcome = await streamToWireEvents(upstream(events), e => out.push(e), options);
  return { out, outcome };
}

describe('streamToWireEvents — the assistant message', () => {
  it('accumulates text, thinking, redacted_thinking and tool_use blocks in stream order', async () => {
    const { outcome } = await run([
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', content_block: { type: 'thinking' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Look ' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'first.' } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'redacted_thinking', data: 'opaque' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Chec' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'king.' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'get_prs' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"scope":' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"all"}' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { type: 'message_delta', stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    ]);
    expect(outcome.content).toEqual([
      { type: 'thinking', thinking: 'Look first.', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'tu_1', name: 'get_prs', input: { scope: 'all' } },
    ]);
    expect(outcome).toMatchObject({ usage: { input_tokens: 3, output_tokens: 9 }, stopReason: 'tool_use', toolUseCount: 1 });
  });

  it('opens a text block implicitly for a stream that never sends content_block_start', async () => {
    // The summary handler's stream and the older tests feed bare deltas.
    const { outcome, out } = await run([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Strong ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'session.' } },
    ]);
    expect(outcome.content).toEqual([{ type: 'text', text: 'Strong session.' }]);
    expect(out).toEqual([{ type: 'text', delta: 'Strong ' }, { type: 'text', delta: 'session.' }, { type: 'done' }]);
  });

  it('keeps citations on the text block and forwards each as a citation event', async () => {
    const citation = {
      type: 'char_location', cited_text: 'Base first.', document_index: 0, document_title: 'The aerobic base',
      start_char_index: 0, end_char_index: 11,
    };
    const { outcome, out } = await run([
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Base before intensity.' } },
      { type: 'content_block_delta', delta: { type: 'citations_delta', citation } },
      { type: 'content_block_stop' },
    ]);
    expect(outcome.content).toEqual([{ type: 'text', text: 'Base before intensity.', citations: [citation] }]);
    expect(out).toEqual([
      { type: 'text', delta: 'Base before intensity.' },
      { type: 'citation', citedText: 'Base first.', documentTitle: 'The aerobic base' },
      { type: 'done' },
    ]);
  });

  it('deferToolUse keeps tool_use blocks off the wire but in the message; done:false emits no done', async () => {
    const { outcome, out } = await run([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'On it.' } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'delete_event' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":"a","scope":"all"}' } },
      { type: 'content_block_stop' },
    ], { deferToolUse: true, done: false });
    expect(out).toEqual([{ type: 'text', delta: 'On it.' }]);
    expect(outcome.content[1]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'delete_event', input: { event_id: 'a', scope: 'all' } });
    expect(outcome.toolUseCount).toBe(1);
  });

  it('ignores a block kind it does not accumulate, and deltas that follow it', async () => {
    const { outcome } = await run([
      { type: 'content_block_start', content_block: { type: 'server_tool_use', id: 'st_1', name: 'web_search' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop' },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
    ]);
    expect(outcome.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(outcome.toolUseCount).toBe(0);
  });
});
