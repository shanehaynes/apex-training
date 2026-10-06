import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assistantApiContent, BRIEFING_PROMPT, briefingOutcome, EMPTY_BRIEFING_MESSAGE, followUpWithTools, historyForTurn,
  hydrateFromRows, MAX_CONFIRM_ROUNDS, noticeRow, rowsForBriefing, rowsForUserTurn, saveRows, turnOutcome, turnRow,
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

  it('shows a pinned session by its display line and replays its hidden text (D-C08)', () => {
    // What sendMessage(content, ctx, { display }) stores: api_content is the
    // text the model read, display_text the short line the thread showed.
    const hidden = 'I opened the workout "Leg day" on 2026-06-22 (occurrence id w1) from the calendar…';
    const { messages, apiMessages } = hydrateFromRows([
      row({ id: 'a', role: 'user', api_content: hidden, display_text: 'Asked about: Leg day, Mon Jun 22' }),
      row({ id: 'b', role: 'assistant', api_content: 'Here is what I see.', display_text: 'Here is what I see.' }),
    ]);
    expect(messages[0]).toEqual({ id: 'a', role: 'user', content: 'Asked about: Leg day, Mon Jun 22' });
    expect(apiMessages[0]).toEqual({ role: 'user', content: hidden });
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

  it('a user row can show one thing and say another: the display override is a shown row, not a hidden one', () => {
    // sendMessage's third argument: turnRow('user', content, display). Unlike
    // the briefing (display null → hidden), the line is shown and the text
    // is what the model reads.
    const stored = turnRow('user', 'hidden text the model reads', 'Asked about: Leg day, Mon Jun 22');
    expect(stored).toEqual({
      role: 'user', api_content: 'hidden text the model reads', display_text: 'Asked about: Leg day, Mon Jun 22', kind: 'turn',
    });
    expect(stored.display_text).not.toBeNull();
  });

  it('a tool-only assistant turn stores its blocks with nothing to render', () => {
    const blocks = [{ type: 'tool_use', id: 'tu_1', name: 'delete_event', input: {} }];
    const [, assistant] = rowsForUserTurn('Drop Friday', blocks, '');
    expect(assistant.api_content).toEqual(blocks);
    expect(assistant.display_text).toBeNull();
  });

  it('a tool_result flush stores model history with nothing to render, then the reply', () => {
    const flushed = [{ type: 'tool_result' as const, tool_use_id: 'tu_1', content: 'Done.' }];
    const base: ApiMessage[] = [
      { role: 'user', content: 'Drop Friday' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'delete_event', input: {} }] },
      { role: 'user', content: flushed },
    ];
    const { rows, history, reply } = turnOutcome(base, [turnRow('user', flushed, null)], { text: 'All set.', toolUses: [], rounds: [{ text: 'All set.', reads: [] }], notices: [] });
    expect(rows).toEqual([
      { role: 'user', api_content: flushed, display_text: null, kind: 'turn' },
      { role: 'assistant', api_content: 'All set.', display_text: 'All set.', kind: 'turn' },
    ]);
    expect(history).toEqual([...base, { role: 'assistant', content: 'All set.' }]);
    expect(reply).toEqual({ content: 'All set.' });
  });

  it('Coach\'s Notes stores the synthetic prompt as a hidden row', () => {
    const rows = rowsForBriefing('Here is today.');
    expect(rows[0]).toEqual({
      role: 'user', api_content: BRIEFING_PROMPT, display_text: null, kind: 'turn',
    });
    expect(rows[1].display_text).toBe('Here is today.');
  });

  it('a briefing with text is a turn: shown, replayed, stored', () => {
    const out = briefingOutcome('Rest day. Walk.');
    expect(out.display).toBe('Rest day. Walk.');
    expect(out.apiMessages).toEqual([
      { role: 'user', content: BRIEFING_PROMPT },
      { role: 'assistant', content: 'Rest day. Walk.' },
    ]);
    expect(out.rows).toEqual(rowsForBriefing('Rest day. Walk.'));
  });

  it('an empty briefing (a blank account) is a notice, not an empty bubble', () => {
    for (const text of ['', '  \n']) {
      const out = briefingOutcome(text);
      expect(out.display).toBe(EMPTY_BRIEFING_MESSAGE);
      // No history: an empty assistant turn would make the next request invalid.
      expect(out.apiMessages).toEqual([]);
      expect(out.rows).toEqual([noticeRow(EMPTY_BRIEFING_MESSAGE)]);
    }
    // And a reload shows the same notice, with nothing replayed.
    const { messages, apiMessages } = hydrateFromRows([
      row({ id: 'n', role: 'assistant', api_content: null, display_text: EMPTY_BRIEFING_MESSAGE, kind: 'notice' }),
    ]);
    expect(messages).toEqual([{ id: 'n', role: 'assistant', content: EMPTY_BRIEFING_MESSAGE }]);
    expect(apiMessages).toEqual([]);
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

  it('hands back the structured content a read carried, in a server round and in a held result alike', () => {
    const document = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'doctrine text' }, title: 'Periodization', citations: { enabled: true } };
    const doctrine = (id: string): WireRead => ({
      use: { type: 'tool_use', id, name: 'read_doctrine', input: { topic: 'periodization' } },
      label: 'Doctrine: Periodization',
      result: { text: 'doctrine text', isError: false, content: [document] },
    });
    const write = { type: 'tool_use' as const, id: 'tu_w', name: 'delete_event', input: { event_id: 'a', scope: 'all', event_title: 'Leg day' } };
    const { serverMessages, heldResults } = historyForTurn(
      [{ text: '', reads: [doctrine('tu_1')] }, { text: 'Dropping it.', reads: [doctrine('tu_2')] }],
      [write],
    );
    // The model was handed the document, not a string, in both places.
    expect(serverMessages[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [document] }] });
    expect(heldResults).toEqual([{ type: 'tool_result', tool_use_id: 'tu_2', content: [document] }]);
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

// ─── turnOutcome: one response, both arrival points ──────────────────────────

const stored = (rows: NewCoachMessage[]): StoredCoachMessage[] =>
  rows.map((r, i) => ({ ...r, id: `r${i}`, created_at: '2026-10-06T16:28:00Z' }));

describe('turnOutcome — what a response changes', () => {
  const user: ApiMessage[] = [{ role: 'user', content: 'Make a strength regimen' }];
  const write = { type: 'tool_use' as const, id: 'tu_w1', name: 'create_exercise_definition', input: { name: 'Farmer Carry' } };

  it('a text-only reply: a string assistant message, two rows, a bubble, an empty queue', () => {
    const out = turnOutcome(user, [turnRow('user', 'hi', 'hi')], { text: 'Hello.', toolUses: [], rounds: [{ text: 'Hello.', reads: [] }], notices: [] });
    expect(out.history).toEqual([...user, { role: 'assistant', content: 'Hello.' }]);
    expect(out.rows).toEqual([turnRow('user', 'hi', 'hi'), turnRow('assistant', 'Hello.', 'Hello.')]);
    expect(out.reply).toEqual({ content: 'Hello.' });
    expect(out.pendingActions).toEqual([]);
    expect(out.heldResults).toEqual([]);
  });

  it('a write reply opens the confirm queue and stores the blocks', () => {
    const out = turnOutcome(user, [turnRow('user', 'x', 'x')], { text: 'Adding it.', toolUses: [write], rounds: [{ text: 'Adding it.', reads: [] }], notices: [] });
    expect(out.pendingActions).toEqual(toPendingActions([write]));
    expect(out.rows[1].api_content).toEqual([{ type: 'text', text: 'Adding it.' }, write]);
    expect(out.rows[1].display_text).toBe('Adding it.');
    const { flushed } = settleHead(out.pendingActions, out.heldResults, 'Added.');
    expectApiValid([...out.history, { role: 'user', content: flushed! }]);
  });

  it('a confirmed flush, tools on: reads, then a second write opens a new queue (the 2026-10-06 case)', () => {
    // The production turn: the coach added an exercise to the library and
    // meant to schedule the workout that uses it next. With tools on for the
    // follow-up, step two is a card, not a sentence.
    const flushed = [{ type: 'tool_result' as const, tool_use_id: 'tu_w1', content: 'Added "Farmer Carry".' }];
    const base: ApiMessage[] = [
      ...user,
      { role: 'assistant', content: [{ type: 'text', text: 'First the exercise.' }, write] },
      { role: 'user', content: flushed },
    ];
    const createEvent = { type: 'tool_use' as const, id: 'tu_w2', name: 'create_event', input: { title: 'Strength A', date: '2026-10-12' } };
    const stream = {
      text: 'Now the sessions.',
      toolUses: [createEvent],
      rounds: [
        { text: '', reads: [read('tu_r1', 'get_schedule', { start_date: '2026-10-12', end_date: '2026-11-05' }, 'Checked: schedule')] },
        { text: 'Now the sessions.', reads: [] },
      ],
      notices: [],
    };
    const flushRow = turnRow('user', flushed, null);
    const out = turnOutcome(base, [flushRow], stream);

    expect(out.rows).toEqual([
      flushRow,
      turnRow('assistant', [{ type: 'tool_use', id: 'tu_r1', name: 'get_schedule', input: { start_date: '2026-10-12', end_date: '2026-11-05' } }], null),
      turnRow('user', [{ type: 'tool_result', tool_use_id: 'tu_r1', content: 'result tu_r1' }], null),
      turnRow('assistant', [{ type: 'text', text: 'Now the sessions.' }, createEvent], 'Now the sessions.'),
    ]);
    expect(out.reply).toEqual({ content: 'Now the sessions.', reads: ['Checked: schedule'] });
    expect(out.pendingActions).toHaveLength(1);
    expect(out.pendingActions[0].toolName).toBe('create_event');
    // The history ends on the open write; the second flush answers it and
    // the turn stays valid.
    const { flushed: second } = settleHead(out.pendingActions, out.heldResults, 'Created.');
    expectApiValid([...out.history, { role: 'user', content: second! }]);

    // A reload rebuilds the same history and pins the chip to the reply.
    const all = stored([turnRow('user', 'Make a strength regimen', 'Make a strength regimen'), turnRow('assistant', base[1].content, 'First the exercise.'), ...out.rows]);
    const { messages, apiMessages } = hydrateFromRows(all);
    expect(apiMessages).toEqual(out.history);
    expect(messages.at(-1)).toMatchObject({ id: 'r5', role: 'assistant', content: 'Now the sessions.' });
    // The wire's label is gone; the stored tool_use names the chip.
    expect(messages.at(-1)?.reads).toHaveLength(1);
  });

  it('a follow-up with no text and no tool: only the flush row, and the next text folds into it', () => {
    const flushed = [{ type: 'tool_result' as const, tool_use_id: 'tu_w1', content: 'Cancelled by user.' }];
    const base: ApiMessage[] = [...user, { role: 'assistant', content: [write] }, { role: 'user', content: flushed }];
    const flushRow = turnRow('user', flushed, null);
    const out = turnOutcome(base, [flushRow], { text: '', toolUses: [], rounds: [{ text: '', reads: [] }], notices: [] });
    expect(out.rows).toEqual([flushRow]);
    expect(out.history).toEqual(base);
    expect(out.reply).toBeNull();
    expectApiValid(appendUserText(out.history, 'ok, something else'));
    expect(hydrateFromRows(stored([turnRow('user', 'Make a strength regimen', 'Make a strength regimen'), turnRow('assistant', [write], null), ...out.rows])).apiMessages).toEqual(base);
  });

  it('reads answered by silence after a flush: a display-only row, the next text folds', () => {
    const flushed = [{ type: 'tool_result' as const, tool_use_id: 'tu_w1', content: 'Done.' }];
    const base: ApiMessage[] = [...user, { role: 'assistant', content: [write] }, { role: 'user', content: flushed }];
    const out = turnOutcome(base, [turnRow('user', flushed, null)], {
      text: 'Checking.', toolUses: [], rounds: [{ text: 'Checking.', reads: [read('tu_r1', 'get_prs', {}, 'Checked: PRs (all time)')] }], notices: [],
    });
    expect(out.rows.at(-1)).toEqual(turnRow('assistant', null, 'Checking.'));
    expect(out.history.at(-1)?.role).toBe('user');
    expectApiValid(appendUserText(out.history, 'and?'));
  });

  it('notices trail the reply as notice rows', () => {
    const out = turnOutcome(user, [turnRow('user', 'x', 'x')], { text: 'Partial.', toolUses: [], rounds: [{ text: 'Partial.', reads: [] }], notices: ['The coach stopped after the lookup limit for one message.'] });
    expect(out.notices).toHaveLength(1);
    expect(out.rows.at(-1)).toEqual(noticeRow('The coach stopped after the lookup limit for one message.'));
  });
});

describe('followUpWithTools — the chain and its cap', () => {
  it('chat chains under the cap only', () => {
    expect(MAX_CONFIRM_ROUNDS).toBe(3);
    expect(followUpWithTools('chat', 0)).toBe(true);
    expect(followUpWithTools('chat', 2)).toBe(true);
    expect(followUpWithTools('chat', 3)).toBe(false);
  });

  it('the auto-apply panels never chain', () => {
    for (const mode of ['builder', 'planner', 'analytics'] as const) expect(followUpWithTools(mode, 0)).toBe(false);
  });
});
