import { describe, it, expect } from 'vitest';
import { toPendingActions, settleHead, appendUserText } from '../actionQueue';
import type { ApiMessage, PendingAction, ToolResultBlock } from '../actionQueue';
import type { WireToolUse } from '../wire';

const toolUses: WireToolUse[] = [
  { type: 'tool_use', id: 'tu_1', name: 'delete_event', input: { event_id: 'a', scope: 'all' } },
  { type: 'tool_use', id: 'tu_2', name: 'delete_event', input: { event_id: 'b', scope: 'all' } },
  { type: 'tool_use', id: 'tu_3', name: 'not_a_real_tool', input: {} },
];

describe('toPendingActions', () => {
  it('maps every tool_use block to a PendingAction in order', () => {
    const actions = toPendingActions(toolUses);
    expect(actions.map(a => a.toolUseId)).toEqual(['tu_1', 'tu_2', 'tu_3']);
    expect(actions[0].toolName).toBe('delete_event');
    expect(actions[0].input).toEqual({ event_id: 'a', scope: 'all' });
  });

  it('labels via the tool registry, falling back to the tool name', () => {
    const actions = toPendingActions(toolUses);
    expect(actions[0].displayLabel).not.toBe('delete_event'); // registry label
    expect(actions[2].displayLabel).toBe('not_a_real_tool');  // unknown tool
  });
});

describe('settleHead', () => {
  const queue = toPendingActions(toolUses);

  it('holds results (no flush) while actions remain', () => {
    const step1 = settleHead(queue, [], 'Done.');
    expect(step1.flushed).toBeNull();
    expect(step1.queue.map(a => a.toolUseId)).toEqual(['tu_2', 'tu_3']);
    expect(step1.results).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'Done.' },
    ]);
  });

  it('flushes one tool_result per tool_use, in order, when the last settles', () => {
    let state: { queue: PendingAction[]; results: ToolResultBlock[] } = { queue, results: [] };
    const texts = ['Done.', 'Cancelled by user.', 'Done.'];
    let flushed: ToolResultBlock[] | null = null;
    for (const text of texts) {
      const next = settleHead(state.queue, state.results, text);
      flushed = next.flushed;
      state = next;
    }

    expect(flushed).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'Done.' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'Cancelled by user.' },
      { type: 'tool_result', tool_use_id: 'tu_3', content: 'Done.' },
    ]);
    // Held state resets with the flush
    expect(state.queue).toEqual([]);
    expect(state.results).toEqual([]);
  });

  it('flushes immediately for a single-action queue', () => {
    const single = settleHead([queue[0]], [], 'Done.');
    expect(single.flushed).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'Done.' },
    ]);
    expect(single.queue).toEqual([]);
  });

  it('is a no-op on an empty queue', () => {
    const settled = settleHead([], [], 'Done.');
    expect(settled).toEqual({ queue: [], results: [], flushed: null });
  });
});

describe('appendUserText', () => {
  const toolResultMsg: ApiMessage = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Done.' }],
  };

  it('appends a plain user message in the normal case', () => {
    const history: ApiMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(appendUserText(history, 'next')).toEqual([
      ...history,
      { role: 'user', content: 'next' },
    ]);
  });

  it('folds text into a trailing unanswered tool_result message, tool_results first', () => {
    const history: ApiMessage[] = [
      { role: 'user', content: 'delete it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'delete_event', input: {} }] },
      toolResultMsg, // flush stream failed — no assistant reply followed
    ];
    const next = appendUserText(history, 'did that work?');
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'Done.' },
        { type: 'text', text: 'did that work?' },
      ],
    });
  });

  it('does not merge into a trailing string user message', () => {
    const history: ApiMessage[] = [{ role: 'user', content: 'hi' }];
    expect(appendUserText(history, 'again')).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('handles an empty history', () => {
    expect(appendUserText([], 'first')).toEqual([{ role: 'user', content: 'first' }]);
  });
});
