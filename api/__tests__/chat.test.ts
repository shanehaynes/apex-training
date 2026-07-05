import { describe, it, expect } from 'vitest';
import { streamToWireEvents } from '../chat';
import type { UpstreamEvent } from '../chat';
import type { ChatWireEvent } from '../../src/lib/coach/wire';

async function* upstream(events: UpstreamEvent[]): AsyncIterable<UpstreamEvent> {
  for (const event of events) yield event;
}

async function collect(events: UpstreamEvent[]): Promise<ChatWireEvent[]> {
  const out: ChatWireEvent[] = [];
  await streamToWireEvents(upstream(events), e => out.push(e));
  return out;
}

describe('streamToWireEvents', () => {
  it('forwards text deltas and ends with done', async () => {
    const out = await collect([
      { type: 'message_start' },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop' },
      { type: 'message_stop' },
    ]);
    expect(out).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'done' },
    ]);
  });

  it('buffers partial tool-input JSON and emits one complete tool_use', async () => {
    const out = await collect([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'delete_event' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"abc","scope":"all"}' } },
      { type: 'content_block_stop' },
    ]);
    expect(out).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'delete_event', input: { event_id: 'abc', scope: 'all' } },
      { type: 'done' },
    ]);
  });

  it('treats an empty tool input as {}', async () => {
    const out = await collect([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_2', name: 'create_event' } },
      { type: 'content_block_stop' },
    ]);
    expect(out[0]).toEqual({ type: 'tool_use', id: 'tu_2', name: 'create_event', input: {} });
  });

  it('handles mixed text-then-tool responses in order', async () => {
    const out = await collect([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Deleting it.' } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_3', name: 'delete_event' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"event_id":"x","scope":"all"}' } },
      { type: 'content_block_stop' },
    ]);
    expect(out.map(e => e.type)).toEqual(['text', 'tool_use', 'done']);
  });
});
