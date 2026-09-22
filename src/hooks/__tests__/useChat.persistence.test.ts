import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BRIEFING_PROMPT, hydrateFromRows, rowsForBriefing, rowsForToolFlush, rowsForUserTurn, saveRows,
} from '../useChat';
import { appendCoachMessages } from '../../lib/api';
import type { StoredCoachMessage } from '../../lib/api';

// The thread's persistence contract (docs/ios/decisions.md D-013, D-025),
// tested at the seam rather than through a rendered hook: this repo has no
// DOM test environment, and the parts that could go wrong are all pure —
// what hydration rebuilds, what each save point stores, and the promise that
// a failed save never reaches the user. See the PR body ("What you left out").

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, appendCoachMessages: vi.fn(async () => ({ ok: true, messages: [] })) };
});

const mockedAppend = vi.mocked(appendCoachMessages);

function row(over: Partial<StoredCoachMessage>): StoredCoachMessage {
  return {
    id: 'r1',
    role: 'user',
    api_content: null,
    display_text: null,
    kind: 'turn',
    created_at: '2026-09-22T12:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  mockedAppend.mockClear();
  mockedAppend.mockResolvedValue({ ok: true, messages: [] });
});

describe('hydrateFromRows — what a reload rebuilds', () => {
  it('splits the two halves: display rows render, api rows replay', () => {
    const { messages, apiMessages } = hydrateFromRows([
      row({ id: 'a', role: 'user', api_content: 'How did last week go?', display_text: 'How did last week go?' }),
      row({ id: 'b', role: 'assistant', api_content: 'Three sessions.', display_text: 'Three sessions.' }),
    ]);
    expect(messages).toEqual([
      { id: 'a', role: 'user', content: 'How did last week go?' },
      { id: 'b', role: 'assistant', content: 'Three sessions.' },
    ]);
    expect(apiMessages).toEqual([
      { role: 'user', content: 'How did last week go?' },
      { role: 'assistant', content: 'Three sessions.' },
    ]);
    // Keys come from the stored ids, which is what lets the render loop stop
    // keying on the array index.
    expect(messages.map(m => m.id)).toEqual(['a', 'b']);
  });

  it('keeps a hidden row out of the thread and in the history', () => {
    const { messages, apiMessages } = hydrateFromRows([
      row({ id: 'a', role: 'user', api_content: BRIEFING_PROMPT, display_text: null }),
      row({ id: 'b', role: 'assistant', api_content: 'Today is a deload.', display_text: 'Today is a deload.' }),
    ]);
    expect(messages).toEqual([{ id: 'b', role: 'assistant', content: 'Today is a deload.' }]);
    expect(apiMessages[0]).toEqual({ role: 'user', content: BRIEFING_PROMPT });
  });

  it('keeps a display-only notice out of the history and in the thread', () => {
    const { messages, apiMessages } = hydrateFromRows([
      row({ id: 'a', role: 'assistant', api_content: null, display_text: 'Sorry, I ran into an error.', kind: 'notice' }),
    ]);
    expect(messages).toHaveLength(1);
    expect(apiMessages).toEqual([]);
  });

  it('folds a text turn back into an unanswered tool_result message', () => {
    // The live path folds these into ONE user message (appendUserText), because
    // a tool_result has to open the user turn after a tool_use. A reload that
    // replayed them as two messages would send an invalid first request.
    const flushed = [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Done.' }];
    const { apiMessages } = hydrateFromRows([
      row({ id: 'a', role: 'assistant', api_content: [{ type: 'tool_use', id: 'tu_1', name: 'delete_event', input: {} }], display_text: null }),
      row({ id: 'b', role: 'user', api_content: flushed, display_text: null }),
      row({ id: 'c', role: 'user', api_content: 'Actually, reschedule it instead.', display_text: 'Actually, reschedule it instead.' }),
    ]);
    expect(apiMessages).toHaveLength(2);
    expect(apiMessages[1]).toEqual({
      role: 'user',
      content: [...flushed, { type: 'text', text: 'Actually, reschedule it instead.' }],
    });
  });
});

describe('what each save point stores', () => {
  it('a completed chat turn stores the plain user text, not the folded message', () => {
    const rows = rowsForUserTurn('Add a run on Friday', 'Added it.', 'Added it.');
    expect(rows).toEqual([
      { role: 'user', api_content: 'Add a run on Friday', display_text: 'Add a run on Friday', kind: 'turn' },
      { role: 'assistant', api_content: 'Added it.', display_text: 'Added it.', kind: 'turn' },
    ]);
  });

  it('a tool-only assistant turn stores its blocks with nothing to render', () => {
    const blocks = [{ type: 'tool_use', id: 'tu_1', name: 'delete_event', input: {} }];
    const [, assistant] = rowsForUserTurn('Drop Friday', blocks, '');
    expect(assistant.api_content).toEqual(blocks);
    expect(assistant.display_text).toBeNull();
  });

  it('a tool_result flush stores model history with nothing to render', () => {
    const flushed = [{ type: 'tool_result' as const, tool_use_id: 'tu_1', content: 'Done.' }];
    const rows = rowsForToolFlush(flushed, 'All set.');
    expect(rows[0]).toEqual({ role: 'user', api_content: flushed, display_text: null, kind: 'turn' });
    expect(rows[1].display_text).toBe('All set.');
  });

  it('Coach\'s Notes stores the synthetic prompt as a hidden row', () => {
    const rows = rowsForBriefing('Here is today.');
    expect(rows[0]).toEqual({
      role: 'user', api_content: BRIEFING_PROMPT, display_text: null, kind: 'turn',
    });
    expect(rows[1].display_text).toBe('Here is today.');
  });
});

describe('saveRows — write-behind, fail-open', () => {
  it('appends to the conversation the caller resolves', async () => {
    const rows = rowsForBriefing('Here is today.');
    await expect(saveRows(async () => 'conv-1', rows)).resolves.toBe(true);
    expect(mockedAppend).toHaveBeenCalledWith('conv-1', rows);
  });

  it('never throws when the save fails — the thread survives it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedAppend.mockRejectedValue(new Error('413 Conversation too large'));
    await expect(saveRows(async () => 'conv-1', rowsForBriefing('x'))).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never throws when the conversation cannot even be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = async () => { throw new Error('offline'); };
    await expect(saveRows(failing, rowsForBriefing('x'))).resolves.toBe(false);
    expect(mockedAppend).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not call the API for an empty batch', async () => {
    await expect(saveRows(async () => 'conv-1', [])).resolves.toBe(false);
    expect(mockedAppend).not.toHaveBeenCalled();
  });
});
