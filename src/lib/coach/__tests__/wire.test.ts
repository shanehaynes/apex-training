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

// ─── The sight loop's events ─────────────────────────────────────────────────

describe('createWireCollector — server-side reads', () => {
  const read = (id: string, name: string, input: Record<string, unknown>, label: string): ChatWireEvent =>
    ({ type: 'tool_read', id, name, input, label });
  const result = (id: string, text: string, isError = false): ChatWireEvent =>
    ({ type: 'tool_read_result', id, text, isError });

  it('keeps the structured content of a result when the server sends one', () => {
    const collector = createWireCollector();
    const document = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'doctrine text' }, title: 'Periodization', citations: { enabled: true } };
    collector.push(line(read('tu_d', 'read_doctrine', { topic: 'periodization' }, 'Doctrine: Periodization')));
    collector.push(line({ type: 'tool_read_result', id: 'tu_d', text: 'doctrine text', isError: false, content: [document] }));
    collector.end();
    expect(collector.reads[0].result).toEqual({ text: 'doctrine text', isError: false, content: [document] });
  });

  it('keeps every read with its label and result, in arrival order, and never as a tool_use', () => {
    const collector = createWireCollector();
    collector.push(line(read('tu_1', 'get_prs', { scope: 'all' }, 'Checked: PRs (all time)')));
    collector.push(line(read('tu_2', 'read_doctrine', { topic: 'strength' }, 'Doctrine: Strength for the mountain athlete')));
    collector.push(line(result('tu_1', '{"prs":[]}')));
    collector.push(line(result('tu_2', 'doctrine text', true)));
    collector.push(line({ type: 'done' }));
    collector.end();

    expect(collector.toolUses).toEqual([]);
    expect(collector.reads).toEqual([
      { use: { type: 'tool_use', id: 'tu_1', name: 'get_prs', input: { scope: 'all' } }, label: 'Checked: PRs (all time)', result: { text: '{"prs":[]}', isError: false } },
      { use: { type: 'tool_use', id: 'tu_2', name: 'read_doctrine', input: { topic: 'strength' } }, label: 'Doctrine: Strength for the mountain athlete', result: { text: 'doctrine text', isError: true } },
    ]);
  });

  it('splits the turn into rounds at each answered set of reads, keeping each round\'s text exact', () => {
    const onText = vi.fn();
    const collector = createWireCollector(onText);
    collector.push(line({ type: 'text', delta: 'Checking.' }));
    collector.push(line(read('tu_1', 'get_exercise_history', { exercise_name: 'Deadlift' }, 'Checked: Deadlift history')));
    collector.push(line(result('tu_1', 'history')));
    // The model read again without speaking.
    collector.push(line(read('tu_2', 'get_prs', { scope: 'all' }, 'Checked: PRs (all time)')));
    collector.push(line(result('tu_2', 'prs')));
    collector.push(line({ type: 'text', delta: 'Up 10 lb ' }));
    collector.push(line({ type: 'text', delta: 'since June.' }));
    collector.push(line({ type: 'done' }));
    collector.end();

    expect(collector.rounds).toEqual([
      { text: 'Checking.', reads: [expect.objectContaining({ label: 'Checked: Deadlift history' })] },
      { text: '', reads: [expect.objectContaining({ label: 'Checked: PRs (all time)' })] },
      { text: 'Up 10 lb since June.', reads: [] },
    ]);
    // The display text joins the rounds with a blank line; the running
    // total the stream shows is the same string.
    expect(collector.text).toBe('Checking.\n\nUp 10 lb since June.');
    expect(onText).toHaveBeenLastCalledWith('Checking.\n\nUp 10 lb since June.');
  });

  it('a mixed final round keeps its reads and the writes together', () => {
    const collector = createWireCollector();
    collector.push(line({ type: 'text', delta: 'Clearing it.' }));
    collector.push(line(read('tu_r', 'get_prs', { scope: 'all' }, 'Checked: PRs (all time)')));
    collector.push(line(result('tu_r', 'prs')));
    collector.push(line({ type: 'tool_use', id: 'tu_w', name: 'delete_event', input: { event_id: 'a' } }));
    collector.push(line({ type: 'done' }));
    collector.end();

    expect(collector.rounds).toHaveLength(1);
    expect(collector.rounds[0].text).toBe('Clearing it.');
    expect(collector.rounds[0].reads.map(r => r.use.id)).toEqual(['tu_r']);
    expect(collector.toolUses).toEqual([{ type: 'tool_use', id: 'tu_w', name: 'delete_event', input: { event_id: 'a' } }]);
  });

  it('collects notices and citations without touching the text', () => {
    const collector = createWireCollector();
    collector.push(line({ type: 'text', delta: 'Base first.' }));
    collector.push(line({ type: 'citation', citedText: 'Aerobic base comes first.', documentTitle: 'The aerobic base' }));
    collector.push(line({ type: 'notice', message: 'Stopped after the lookup limit.' }));
    collector.end();

    expect(collector.text).toBe('Base first.');
    expect(collector.citations).toEqual([{ citedText: 'Aerobic base comes first.', documentTitle: 'The aerobic base' }]);
    expect(collector.notices).toEqual(['Stopped after the lookup limit.']);
  });

  it('reports the chips so far each time a read starts, for the live panel', () => {
    const onRead = vi.fn();
    const collector = createWireCollector(undefined, onRead);
    collector.push(line(read('tu_1', 'get_prs', {}, 'Checked: PRs (all time)')));
    collector.push(line(read('tu_2', 'get_schedule', {}, 'Checked: schedule')));
    collector.push(line(result('tu_1', 'x')));
    collector.end();
    expect(onRead).toHaveBeenNthCalledWith(1, ['Checked: PRs (all time)']);
    expect(onRead).toHaveBeenNthCalledWith(2, ['Checked: PRs (all time)', 'Checked: schedule']);
    expect(onRead).toHaveBeenCalledTimes(2);
  });

  it('a turn with no reads is one round holding all the text', () => {
    const collector = createWireCollector();
    collector.push(line({ type: 'text', delta: 'Hello' }));
    collector.push(line({ type: 'done' }));
    collector.end();
    expect(collector.rounds).toEqual([{ text: 'Hello', reads: [] }]);
    expect(collector.reads).toEqual([]);
    expect(collector.notices).toEqual([]);
  });
});
