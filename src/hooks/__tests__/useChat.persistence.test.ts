import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assistantApiContent, BRIEFING_PROMPT, historyForTurn, hydrateFromRows, noticeRow, rowsForBriefing, rowsForToolFlush,
  rowsForUserTurn, saveRows, turnRow,
} from '../useChat';
import { appendCoachMessages } from '../../lib/api';
import type { NewCoachMessage, StoredCoachMessage } from '../../lib/api';
import { appendUserText, settleHead, toPendingActions } from '../../lib/coach/actionQueue';
import type { ApiMessage } from '../../lib/coach/actionQueue';
import type { WireRead, WireRound } from '../../lib/coach/wire';

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

// ─── The sight loop: what a read turn stores and replays ─────────────────────

function read(id: string, name: string, input: Record<string, unknown>, label: string, text = `result ${id}`, isError = false): WireRead {
  return { use: { type: 'tool_use', id, name, input }, label, result: { text, isError } };
}

/** The API's rule for a transcript: user/assistant alternate; every
 *  tool_use in an assistant message is answered, first thing, in the next
 *  user message; a user message that opens with tool_results follows an
 *  assistant message with exactly those tool_uses. */
function expectApiValid(messages: ApiMessage[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    expect(m.role).toBe(i % 2 === 0 ? 'user' : 'assistant');
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const uses = m.content.filter(b => b.type === 'tool_use').map(b => (b as { id: string }).id);
    if (uses.length === 0) continue;
    const next = messages[i + 1];
    expect(next?.role).toBe('user');
    const content = next.content as Array<{ type: string; tool_use_id?: string }>;
    expect(Array.isArray(content)).toBe(true);
    const results = content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id);
    expect(results.sort()).toEqual([...uses].sort());
    // tool_results lead the message.
    expect(content.slice(0, results.length).every(b => b.type === 'tool_result')).toBe(true);
  }
}

describe('historyForTurn — the read loop as API messages', () => {
  const twoRounds: WireRound[] = [
    { text: 'Checking.', reads: [read('tu_1', 'get_exercise_history', { exercise_name: 'Deadlift' }, 'Checked: Deadlift history')] },
    { text: '', reads: [
      read('tu_2', 'get_prs', { scope: 'all' }, 'Checked: PRs (all time)'),
      read('tu_3', 'read_doctrine', { topic: 'strength' }, 'Doctrine: Strength', 'doctrine text'),
    ] },
    { text: 'Up 10 lb since June.', reads: [] },
  ];

  it('a two-round read turn becomes two hidden assistant/user pairs and a final text reply, all API-valid', () => {
    const { serverMessages, finalContent, heldResults, chips } = historyForTurn(twoRounds, []);
    expect(serverMessages).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'tu_1', name: 'get_exercise_history', input: { exercise_name: 'Deadlift' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result tu_1' }] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_2', name: 'get_prs', input: { scope: 'all' } },
        { type: 'tool_use', id: 'tu_3', name: 'read_doctrine', input: { topic: 'strength' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_2', content: 'result tu_2' },
        { type: 'tool_result', tool_use_id: 'tu_3', content: 'doctrine text' },
      ] },
    ]);
    expect(finalContent).toEqual([{ type: 'text', text: 'Up 10 lb since June.' }]);
    expect(assistantApiContent(finalContent)).toBe('Up 10 lb since June.');
    expect(heldResults).toEqual([]);
    expect(chips).toEqual(['Checked: Deadlift history', 'Checked: PRs (all time)', 'Doctrine: Strength']);

    const history: ApiMessage[] = [
      ...appendUserText([], 'how is my deadlift?'),
      ...serverMessages,
      { role: 'assistant', content: assistantApiContent(finalContent) },
    ];
    expectApiValid(history);
    // And so is the next turn on top of it.
    expectApiValid(appendUserText(history, 'thanks'));
  });

  it('marks a failed read is_error on its tool_result', () => {
    const rounds: WireRound[] = [
      { text: '', reads: [read('tu_1', 'get_schedule', { start_date: 'x' }, 'Checked: schedule', 'start_date must be YYYY-MM-DD', true)] },
      { text: 'Which week?', reads: [] },
    ];
    expect(historyForTurn(rounds, []).serverMessages[1]).toEqual({
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'start_date must be YYYY-MM-DD', is_error: true }],
    });
  });

  it('a mixed response keeps its reads in the final message and holds their results for the write flush', () => {
    const rounds: WireRound[] = [
      { text: 'Checking.', reads: [read('tu_1', 'get_prs', { scope: 'all' }, 'Checked: PRs (all time)')] },
      { text: 'Clearing it.', reads: [read('tu_2', 'get_schedule', {}, 'Checked: schedule')] },
    ];
    const write = { type: 'tool_use' as const, id: 'tu_w', name: 'delete_event', input: { event_id: 'a', scope: 'all', event_title: 'Leg day' } };
    const { serverMessages, finalContent, heldResults } = historyForTurn(rounds, [write]);
    expect(serverMessages).toHaveLength(2);
    expect(finalContent).toEqual([
      { type: 'text', text: 'Clearing it.' },
      { type: 'tool_use', id: 'tu_2', name: 'get_schedule', input: {} },
      write,
    ]);
    expect(heldResults).toEqual([{ type: 'tool_result', tool_use_id: 'tu_2', content: 'result tu_2' }]);

    // The confirm flow, exactly as useChat runs it: the held read results
    // seed the queue's results, the write's result joins them, and the one
    // flushed message answers every tool_use of the final assistant message.
    const { flushed } = settleHead(toPendingActions([write]), heldResults, 'Done.');
    const history: ApiMessage[] = [
      { role: 'user', content: 'drop leg day' },
      ...serverMessages,
      { role: 'assistant', content: assistantApiContent(finalContent) },
      { role: 'user', content: flushed! },
    ];
    expectApiValid(history);
    expect(flushed!.map(b => b.tool_use_id)).toEqual(['tu_2', 'tu_w']);
  });

  it('reads answered by silence leave no final message: the next user text folds into the tool_results', () => {
    const rounds: WireRound[] = [{ text: 'Looking.', reads: [read('tu_1', 'get_prs', {}, 'Checked: PRs (all time)')] }];
    const { serverMessages, finalContent } = historyForTurn(rounds, []);
    expect(serverMessages).toHaveLength(2);
    expect(finalContent).toEqual([]);
    const history = appendUserText([{ role: 'user', content: 'hi' }, ...serverMessages], 'and my squat?');
    expect(history).toHaveLength(3);
    expect(history[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'result tu_1' },
      { type: 'text', text: 'and my squat?' },
    ]);
    expectApiValid(history);
  });

  it('a turn without reads is the pre-loop shape: no server messages, the text as the final content', () => {
    const { serverMessages, finalContent, heldResults, chips } = historyForTurn([{ text: 'Hello.', reads: [] }], []);
    expect(serverMessages).toEqual([]);
    expect(finalContent).toEqual([{ type: 'text', text: 'Hello.' }]);
    expect(heldResults).toEqual([]);
    expect(chips).toEqual([]);
  });
});

describe('a read turn, stored and reloaded', () => {
  it('replays the hidden rounds as history and pins their chips to the reply', () => {
    const rounds: WireRound[] = [
      { text: 'Checking.', reads: [read('tu_1', 'get_exercise_history', { exercise_name: 'Deadlift' }, 'Checked: Deadlift history')] },
      { text: 'Up 10 lb.', reads: [] },
    ];
    const { serverMessages, finalContent } = historyForTurn(rounds, []);
    // What sendMessage persists, in order.
    const rows: NewCoachMessage[] = [
      turnRow('user', 'how is my deadlift?', 'how is my deadlift?'),
      ...serverMessages.map(m => turnRow(m.role, m.content, null)),
      turnRow('assistant', assistantApiContent(finalContent), 'Checking.\n\nUp 10 lb.'),
    ];
    const stored = rows.map((r, i) => ({ ...r, id: `r${i}`, created_at: '2026-09-26T12:00:00Z' }));
    const { messages, apiMessages } = hydrateFromRows(stored);

    expect(messages).toEqual([
      { id: 'r0', role: 'user', content: 'how is my deadlift?' },
      // The wire's label is gone; the stored tool_use names the chip.
      { id: 'r3', role: 'assistant', content: 'Checking.\n\nUp 10 lb.', reads: ['Checked: exercise history'] },
    ]);
    expect(apiMessages).toEqual([
      { role: 'user', content: 'how is my deadlift?' },
      ...serverMessages,
      { role: 'assistant', content: 'Up 10 lb.' },
    ]);
    expectApiValid(apiMessages);
  });

  it('keeps chips with their own turn when it ended in reads and silence', () => {
    const rows = [
      row({ id: 'a', role: 'user', api_content: 'hi', display_text: 'hi' }),
      row({ id: 'b', role: 'assistant', api_content: [{ type: 'tool_use', id: 'tu_1', name: 'get_prs', input: {} }], display_text: null }),
      row({ id: 'c', role: 'user', api_content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'x' }], display_text: null }),
      row({ id: 'd', role: 'user', api_content: 'and?', display_text: 'and?' }),
      row({ id: 'e', role: 'assistant', api_content: 'Here.', display_text: 'Here.' }),
    ];
    const { messages, apiMessages } = hydrateFromRows(rows);
    expect(messages.at(-1)).toEqual({ id: 'e', role: 'assistant', content: 'Here.' });
    expectApiValid(apiMessages);
  });

  it('a notice row shows and never replays', () => {
    const notice = noticeRow('The coach stopped after the lookup limit for one message.');
    expect(notice).toEqual({ role: 'assistant', api_content: null, display_text: 'The coach stopped after the lookup limit for one message.', kind: 'notice' });
    const { messages, apiMessages } = hydrateFromRows([{ ...notice, id: 'n', created_at: '2026-09-26T12:00:00Z' }]);
    expect(messages).toHaveLength(1);
    expect(apiMessages).toEqual([]);
  });
});
