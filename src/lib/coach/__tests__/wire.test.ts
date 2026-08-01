import { describe, it, expect, vi } from 'vitest';
import { createWireCollector } from '../wire';
import type { ChatWireEvent } from '../wire';

function line(event: ChatWireEvent): string {
  return JSON.stringify(event) + '\n';
}

describe('createWireCollector', () => {
  it('accumulates text deltas and reports the running total', () => {
    const onText = vi.fn();
    const collector = createWireCollector(onText);

    collector.push(line({ type: 'text', delta: 'Hel' }));
    collector.push(line({ type: 'text', delta: 'lo' }));
    collector.end();

    expect(collector.text).toBe('Hello');
    expect(onText).toHaveBeenNthCalledWith(1, 'Hel');
    expect(onText).toHaveBeenNthCalledWith(2, 'Hello');
  });

  it('keeps EVERY tool_use event, in arrival order', () => {
    const collector = createWireCollector();

    collector.push(line({ type: 'tool_use', id: 'tu_1', name: 'delete_event', input: { event_id: 'a' } }));
    collector.push(line({ type: 'tool_use', id: 'tu_2', name: 'delete_event', input: { event_id: 'b' } }));
    collector.push(line({ type: 'tool_use', id: 'tu_3', name: 'create_event', input: {} }));
    collector.push(line({ type: 'done' }));
    collector.end();

    expect(collector.toolUses).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'delete_event', input: { event_id: 'a' } },
      { type: 'tool_use', id: 'tu_2', name: 'delete_event', input: { event_id: 'b' } },
      { type: 'tool_use', id: 'tu_3', name: 'create_event', input: {} },
    ]);
  });

  it('reassembles lines split across chunk boundaries', () => {
    const collector = createWireCollector();
    const full = line({ type: 'text', delta: 'abc' }) + line({ type: 'tool_use', id: 'tu_1', name: 'update_event', input: { x: 1 } });

    collector.push(full.slice(0, 10));
    collector.push(full.slice(10, 40));
    collector.push(full.slice(40));
    collector.end();

    expect(collector.text).toBe('abc');
    expect(collector.toolUses).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'update_event', input: { x: 1 } }]);
  });

  it('parses a trailing line with no newline on end()', () => {
    const collector = createWireCollector();

    collector.push(JSON.stringify({ type: 'text', delta: 'tail' }));
    expect(collector.text).toBe('');
    collector.end();

    expect(collector.text).toBe('tail');
  });

  it('ignores blank lines', () => {
    const collector = createWireCollector();
    collector.push('\n  \n');
    collector.end();
    expect(collector.text).toBe('');
    expect(collector.toolUses).toEqual([]);
  });

  it('throws on an error event', () => {
    const collector = createWireCollector();
    expect(() => collector.push(line({ type: 'error', message: 'Chat request failed' })))
      .toThrow('Chat request failed');
  });
});
