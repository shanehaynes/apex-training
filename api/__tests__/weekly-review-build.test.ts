import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  buildWeeklyRecap, buildWeeklySystemPrompt, citableDoctrine, computePlanVsDone, doctrineLineOccurs,
  generateWeeklyDocument, parseWeeklyJson, resolveWeek, validateNextWeekItem, validateWeeklyDocument,
  weeklyOutputSchema, WEEKLY_MAX_TOKENS, type ValidationContext, type WeeklyInputs,
} from '../_lib/review/weekly';
import { DOCTRINE_TOPICS, readDoctrine } from '../../src/lib/coach/doctrine';
import { MEMORY_PROPOSALS_MAX, NEXT_WEEK_MAX } from '../../src/lib/review/weekly';
import { computeReviewStats } from '../../src/lib/review/stats';
import { resolveCoachModel } from '../../src/lib/coach/models';
import type { CompletionRow, WorkoutSessionRow } from '../../src/lib/db/types';
import type { WorkoutEvent } from '../../src/types/workout';

// The pure half of the weekly review: the week's numbers, the recap the
// model reads, and the validation that stands between the model's JSON and
// the athlete's screen. Assertions, not snapshots — the recap's wording is
// free to change; what it carries is not.

const TODAY = '2026-09-28'; // Monday
const WINDOW = { start: '2026-09-21', end: '2026-09-27' };
const NEXT = { start: '2026-09-28', end: '2026-10-04' };

const base: WorkoutEvent = {
  id: 'evt', type: 'weights', title: 'Push Day', date: '2026-09-21', startTime: '5:30 PM', estimatedDuration: 60,
  description: '', exercises: [], difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
};
const EVENTS: WorkoutEvent[] = [
  { ...base, id: 'mon-push', date: '2026-09-21', isCompleted: true, completedAt: '2026-09-21T23:00:00Z' },
  { ...base, id: 'wed-run', title: 'Easy run <Z2', type: 'cardio', date: '2026-09-23', estimatedDuration: 45 },
  { ...base, id: 'sat-long__2026-09-26', title: 'Long day', type: 'cardio', date: '2026-09-26', estimatedDuration: 180, isCompleted: true, isRecurring: true },
];
const COMPLETIONS = [
  { event_id: 'mon-push', event_date: '2026-09-21', is_completed: true, duration_minutes: 55, event_title: 'Push Day', event_type: 'weights' },
  { event_id: 'sat-long__2026-09-26', event_date: '2026-09-26', is_completed: true, duration_minutes: 180, event_title: 'Long day', event_type: 'cardio' },
] as unknown as CompletionRow[];
const SESSIONS = [
  { event_id: 'mon-push', event_date: '2026-09-21', total_duration_seconds: 3720, coach_summary: null },
] as unknown as WorkoutSessionRow[];

function inputs(overrides: Partial<WeeklyInputs> = {}): WeeklyInputs {
  const period = { periodType: 'block' as const, startDate: WINDOW.start, endDateExclusive: '2026-09-28', label: 'w', weeksInPeriod: 1 };
  return {
    today: TODAY,
    window: WINDOW,
    nextWeek: NEXT,
    events: EVENTS,
    nextWeekEvents: [{ ...base, id: 'next-push__2026-09-29', date: '2026-09-29', isRecurring: true }],
    knownEventIds: new Set(['mon-push', 'wed-run', 'sat-long__2026-09-26', 'sat-long', 'next-push__2026-09-29', 'next-push']),
    completions: COMPLETIONS,
    sessions: SESSIONS,
    stats: computeReviewStats({ period, completions: COMPLETIONS, sessions: SESSIONS, setLogs: [], cardioLogs: [] }),
    physiology: '<physiology>\nZone minutes …\n</physiology>',
    memories: [{ kind: 'injury', content: 'Left shoulder: no overhead pressing until cleared' }],
    block: null,
    athlete: { goal: 'Rainier in June' },
    libraryNames: ['Bench Press', 'Pull-up'],
    ...overrides,
  };
}

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  window: WINDOW,
  nextWeek: NEXT,
  planVsDone: computePlanVsDone(inputs()),
  knownEventIds: inputs().knownEventIds,
  hasPhysiology: true,
  ...over,
});

/** A line the recovery topic really contains, as the model would copy it. */
const RECOVERY_LINE = 'Prefer the smaller session done to the larger session skipped, in every phase.';

const GOOD_DOC = {
  week: WINDOW,
  planVsDone: { planned: 99, completed: 99, minutesPlanned: 1, minutesDone: 1, misses: [{ eventId: 'wed-run', title: 'x', date: 'x', why: 'The day after a hard session.' }] },
  physiology: { summary: 'Load ratio sat at 1.1; steady.', flags: ['No logged strength work'] },
  doctrine: { topic: 'recovery', line: `- ${RECOVERY_LINE}`, verdict: 'aligned', note: 'You kept the short run short.' },
  memoryProposals: [{ kind: 'preference', content: 'Prefers evening sessions', why: 'Every completed session started after 5 PM.' }],
  nextWeek: [
    { tool: 'create_event', input: { type: 'cardio', title: 'Easy run', date: '2026-09-30', estimated_duration: 40, exercises: [{ name: 'Run', notes: 'Z2' }] }, why: 'Replace the missed run.' },
    { tool: 'update_event', input: { event_id: 'next-push__2026-09-29', event_title: 'Push Day', changes: { estimated_duration: 45 } }, why: 'Shorter after the long day.' },
  ],
  headline: 'You did the big day and skipped the small one.',
};

describe('resolveWeek', () => {
  it('defaults to the ISO week containing today, takes any date inside the named week, rejects garbage', () => {
    expect(resolveWeek(TODAY, undefined)).toEqual(NEXT);
    expect(resolveWeek(TODAY, '')).toEqual(NEXT);
    expect(resolveWeek(TODAY, '2026-09-24')).toEqual(WINDOW);
    expect(resolveWeek(TODAY, '2026-09-27')).toEqual(WINDOW);
    expect(resolveWeek(TODAY, '09/24/2026')).toBeNull();
    expect(resolveWeek(TODAY, '2026-02-30')).toBeNull();
  });
});

describe('computePlanVsDone', () => {
  it('counts the schedule, prefers tracked minutes, and lists only past incomplete sessions as misses', () => {
    const plan = computePlanVsDone(inputs());
    expect(plan.planned).toBe(3);
    expect(plan.completed).toBe(2);
    expect(plan.minutesPlanned).toBe(285);
    // mon-push: 3720 s tracked → 62 min (over the 55-min estimate); sat: no session → 180.
    expect(plan.minutesDone).toBe(242);
    expect(plan.misses).toEqual([{ eventId: 'wed-run', title: 'Easy run Z2', date: '2026-09-23' }]);
  });

  it('does not call a session dated today or later a miss', () => {
    const plan = computePlanVsDone(inputs({ today: '2026-09-23' }));
    expect(plan.misses).toEqual([]);
  });
});

describe('buildWeeklyRecap', () => {
  const recap = buildWeeklyRecap(inputs(), computePlanVsDone(inputs()));

  it('states both weeks with next week\'s dates, and the plan-vs-done numbers', () => {
    expect(recap).toContain('WEEK UNDER REVIEW: Mon Sep 21 – Sun Sep 27, 2026');
    expect(recap).toContain('NEXT WEEK: Mon Sep 28 – Sun Oct 4; its dates, in order: 2026-09-28, 2026-09-29, 2026-09-30, 2026-10-01, 2026-10-02, 2026-10-03, 2026-10-04.');
    expect(recap).toContain('PLANNED: 3 sessions, 285 min · DONE: 2 sessions, 242 min');
  });

  it('lists every session with its bracketed id and state, sanitized', () => {
    expect(recap).toContain('✓ [mon-push] Mon Sep 21 — Push Day (weights, 60 min) at 5:30 PM — done');
    expect(recap).toContain('○ [wed-run] Wed Sep 23 — Easy run Z2 (cardio, 45 min) at 5:30 PM — MISSED');
    expect(recap).not.toContain('<Z2');
    expect(recap).toContain('MISSED (IDs in brackets');
    expect(recap).toContain('[wed-run] Wed Sep 23 — Easy run Z2');
  });

  it('carries next week\'s schedule, the profile, the memory, the physiology panel, the library and the citable doctrine', () => {
    expect(recap).toContain('○ [next-push__2026-09-29] Tue Sep 29 — Push Day (weights, 60 min) at 5:30 PM');
    expect(recap).toContain('Goal: Rainier in June');
    expect(recap).toContain('Left shoulder: no overhead pressing until cleared');
    expect(recap).toContain('<physiology>');
    expect(recap).toContain('Bench Press, Pull-up');
    expect(recap).toContain('### recovery — Recovery, monitoring and load management');
    expect(recap).toContain(RECOVERY_LINE);
  });

  it('says plainly when there is no measured data and nothing scheduled', () => {
    const empty = buildWeeklyRecap(inputs({ physiology: '', events: [], nextWeekEvents: [], libraryNames: [] }), computePlanVsDone(inputs({ events: [] })));
    expect(empty).toContain('no measured data in the last five weeks');
    expect(empty).toContain('Nothing was scheduled this week.');
    expect(empty).toContain('Nothing scheduled yet.');
    expect(empty).not.toContain('<physiology>');
  });
});

describe('the system prompt and output schema', () => {
  it('states the schema, the caps and the safety posture', () => {
    const system = buildWeeklySystemPrompt();
    expect(system).toContain(JSON.stringify(weeklyOutputSchema()));
    expect(system).toContain(`at most ${MEMORY_PROPOSALS_MAX} facts`);
    expect(system).toContain(`at most ${NEXT_WEEK_MAX} concrete changes`);
    expect(system).toContain('You are not a clinician');
    expect(WEEKLY_MAX_TOKENS).toBeGreaterThanOrEqual(3000);
  });

  it('names every doctrine topic and both tools\' fields', () => {
    const schema = weeklyOutputSchema() as { properties: Record<string, { anyOf?: Array<{ properties: { topic: { enum: string[] } } }>; items?: { properties: { input: { properties: Record<string, unknown> } } } }> };
    expect(schema.properties.doctrine.anyOf?.[0].properties.topic.enum).toEqual(DOCTRINE_TOPICS.map(t => t.id));
    const input = schema.properties.nextWeek.items?.properties.input.properties ?? {};
    for (const key of ['type', 'title', 'date', 'estimated_duration', 'exercises', 'event_id', 'event_title', 'changes']) {
      expect(input, key).toHaveProperty(key);
    }
  });
});

describe('doctrine', () => {
  it('cites every topic\'s applies/contradicts tail, which every topic has', () => {
    const text = citableDoctrine();
    for (const t of DOCTRINE_TOPICS) {
      expect(t.text, t.id).toContain('## How the coach applies this');
      expect(text).toContain(`### ${t.id} — ${t.title}`);
    }
  });

  it('finds a quoted line whitespace- and case-folded, refuses an invented or trivial one', () => {
    expect(doctrineLineOccurs('recovery', RECOVERY_LINE)).toBe(true);
    expect(doctrineLineOccurs('recovery', `  prefer THE smaller   session done to the larger session skipped, in every phase. `)).toBe(true);
    expect(doctrineLineOccurs('recovery', '- ' + RECOVERY_LINE)).toBe(true);
    expect(doctrineLineOccurs('recovery', 'Always train through a fever; schedule pressure comes first.')).toBe(false);
    expect(doctrineLineOccurs('recovery', 'the coach')).toBe(false);
    expect(doctrineLineOccurs('no-such-topic', RECOVERY_LINE)).toBe(false);
    expect(readDoctrine('recovery')).toContain(RECOVERY_LINE);
  });
});

describe('parseWeeklyJson', () => {
  it('parses bare JSON, fenced JSON and JSON wrapped in prose; reports bad JSON', () => {
    expect(parseWeeklyJson('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(parseWeeklyJson('```json\n{"a":1}\n```')).toEqual({ value: { a: 1 } });
    expect(parseWeeklyJson('Here is the review:\n{"a":1}\nDone.')).toEqual({ value: { a: 1 } });
    expect(parseWeeklyJson('{"a":')).toMatchObject({ error: expect.any(String) });
    expect(parseWeeklyJson('')).toEqual({ error: 'empty response' });
  });
});

describe('validateNextWeekItem', () => {
  const c = ctx();

  it('keeps a well-formed create_event, cleaned to the schema\'s fields', () => {
    const result = validateNextWeekItem(GOOD_DOC.nextWeek[0], c);
    expect(result).toEqual({
      item: {
        tool: 'create_event',
        input: { type: 'cardio', title: 'Easy run', date: '2026-09-30', estimated_duration: 40, exercises: [{ name: 'Run', notes: 'Z2' }] },
        why: 'Replace the missed run.',
      },
    });
  });

  it('drops a create_event outside next week, without a duration, with a bad type, or with a nameless exercise', () => {
    const good = GOOD_DOC.nextWeek[0].input;
    expect(validateNextWeekItem({ tool: 'create_event', input: { ...good, date: '2026-10-05' }, why: '' }, c)).toMatchObject({ why: expect.stringContaining('outside next week') });
    expect(validateNextWeekItem({ tool: 'create_event', input: { ...good, estimated_duration: undefined }, why: '' }, c)).toMatchObject({ why: expect.stringContaining('estimated_duration') });
    expect(validateNextWeekItem({ tool: 'create_event', input: { ...good, type: 'swim' }, why: '' }, c)).toMatchObject({ why: expect.stringContaining('type') });
    expect(validateNextWeekItem({ tool: 'create_event', input: { ...good, exercises: [{ sets: 3 }] }, why: '' }, c)).toMatchObject({ why: expect.stringContaining('name') });
  });

  it('keeps an update_event that names a known id (by occurrence or base id) with a known change', () => {
    expect(validateNextWeekItem(GOOD_DOC.nextWeek[1], c)).toEqual({
      item: { tool: 'update_event', input: { event_id: 'next-push__2026-09-29', event_title: 'Push Day', changes: { estimated_duration: 45 } }, why: 'Shorter after the long day.' },
    });
    expect(validateNextWeekItem({ tool: 'update_event', input: { event_id: 'next-push', event_title: 'Push Day', changes: { date: '2026-09-30' } }, why: '' }, c)).toHaveProperty('item');
  });

  it('drops an update_event without an id, with an unknown id, or with no known change', () => {
    expect(validateNextWeekItem({ tool: 'update_event', input: { event_title: 'Push Day', changes: { title: 'x' } }, why: '' }, c)).toEqual({ why: 'update_event without an event_id' });
    expect(validateNextWeekItem({ tool: 'update_event', input: { event_id: 'ghost', event_title: 'x', changes: { title: 'x' } }, why: '' }, c)).toMatchObject({ why: expect.stringContaining('unknown event') });
    expect(validateNextWeekItem({ tool: 'update_event', input: { event_id: 'next-push', event_title: 'x', changes: { colour: 'red' } }, why: '' }, c)).toEqual({ why: 'update_event with no known change' });
    expect(validateNextWeekItem({ tool: 'delete_event', input: { event_id: 'next-push' }, why: '' }, c)).toMatchObject({ why: expect.stringContaining('unknown tool') });
  });
});

describe('validateWeeklyDocument', () => {
  it('replaces the model\'s numbers with ours, keeps its reasons by id, and passes a good doctrine line', () => {
    const result = validateWeeklyDocument(GOOD_DOC, ctx());
    expect('document' in result).toBe(true);
    if (!('document' in result)) return;
    const { document, warnings } = result;
    expect(warnings).toEqual([]);
    expect(document.week).toEqual(WINDOW);
    expect(document.planVsDone).toEqual({
      planned: 3, completed: 2, minutesPlanned: 285, minutesDone: 242,
      misses: [{ eventId: 'wed-run', title: 'Easy run Z2', date: '2026-09-23', why: 'The day after a hard session.' }],
    });
    expect(document.doctrine).toEqual({ topic: 'recovery', line: RECOVERY_LINE, verdict: 'aligned', note: 'You kept the short run short.' });
    expect(document.physiology).toEqual({ summary: 'Load ratio sat at 1.1; steady.', flags: ['No logged strength work'] });
    expect(document.memoryProposals).toEqual(GOOD_DOC.memoryProposals);
    expect(document.nextWeek).toHaveLength(2);
    expect(document.headline).toBe('You did the big day and skipped the small one.');
  });

  it('refuses a non-document outright', () => {
    expect(validateWeeklyDocument('nope', ctx())).toEqual({ error: 'the response is not a JSON object' });
    expect(validateWeeklyDocument({ ...GOOD_DOC, headline: '' }, ctx())).toEqual({ error: 'the document has no headline' });
    const { physiology: _p, ...noPhysiology } = GOOD_DOC;
    expect(validateWeeklyDocument(noPhysiology, ctx())).toEqual({ error: 'the document has no physiology section' });
  });

  it('drops an invented doctrine line, an unknown topic and a missing verdict, each with a warning', () => {
    const invented = validateWeeklyDocument({ ...GOOD_DOC, doctrine: { ...GOOD_DOC.doctrine, line: 'Train through every fever, schedule pressure wins.' } }, ctx());
    expect(invented).toMatchObject({ document: { doctrine: null }, warnings: [expect.stringContaining('does not occur in "recovery"')] });
    const topic = validateWeeklyDocument({ ...GOOD_DOC, doctrine: { ...GOOD_DOC.doctrine, topic: 'crossfit' } }, ctx());
    expect(topic).toMatchObject({ document: { doctrine: null }, warnings: [expect.stringContaining('does not exist')] });
    const verdict = validateWeeklyDocument({ ...GOOD_DOC, doctrine: { ...GOOD_DOC.doctrine, verdict: 'meh' } }, ctx());
    expect(verdict).toMatchObject({ document: { doctrine: null }, warnings: [expect.stringContaining('no verdict')] });
    const none = validateWeeklyDocument({ ...GOOD_DOC, doctrine: null }, ctx());
    expect(none).toMatchObject({ document: { doctrine: null }, warnings: ['The coach made no doctrine check this week.'] });
  });

  it('overrides the physiology gloss when the recap carried no panel', () => {
    const result = validateWeeklyDocument(GOOD_DOC, ctx({ hasPhysiology: false }));
    expect(result).toMatchObject({ document: { physiology: { summary: expect.stringContaining('No measured data'), flags: [] } } });
  });

  it('applies the caps and drops bad proposals with warnings, keeping the good ones', () => {
    const proposals = Array.from({ length: MEMORY_PROPOSALS_MAX + 2 }, (_, i) => ({ kind: 'note', content: `fact ${i}`, why: '' }));
    const items = Array.from({ length: NEXT_WEEK_MAX + 1 }, () => GOOD_DOC.nextWeek[0]);
    const result = validateWeeklyDocument({
      ...GOOD_DOC,
      memoryProposals: [{ kind: 'wish', content: 'x', why: '' }, { kind: 'goal', content: '   ', why: '' }, ...proposals],
      nextWeek: [{ tool: 'update_event', input: { event_title: 'no id', changes: { title: 'x' } }, why: '' }, ...items],
    }, ctx());
    expect('document' in result).toBe(true);
    if (!('document' in result)) return;
    expect(result.document.memoryProposals).toHaveLength(MEMORY_PROPOSALS_MAX);
    expect(result.document.nextWeek).toHaveLength(NEXT_WEEK_MAX);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'A memory proposal with an unknown kind was dropped.',
      'An empty memory proposal was dropped.',
      `Memory proposals are capped at ${MEMORY_PROPOSALS_MAX}; one was dropped.`,
      'A next-week proposal was dropped: update_event without an event_id.',
      `Next-week proposals are capped at ${NEXT_WEEK_MAX}; one was dropped.`,
    ]));
  });

  it('bounds and strips model prose so a string can never open a tag', () => {
    const result = validateWeeklyDocument({ ...GOOD_DOC, headline: '<b>Big</b> week '.repeat(40) }, ctx());
    expect(result).toMatchObject({ document: { headline: expect.not.stringContaining('<') } });
    if ('document' in result) expect(result.document.headline.length).toBeLessThanOrEqual(200);
  });
});

// ─── generateWeeklyDocument: the model call, scripted ────────────────────────

interface Scripted { replies: Array<string | Error>; requests: Array<Record<string, unknown>> }

function fakeClient(script: Scripted): Anthropic {
  return {
    messages: {
      stream(request: Record<string, unknown>) {
        script.requests.push(request);
        const next = script.replies.shift();
        return {
          finalMessage: async () => {
            if (next instanceof Error) throw next;
            return { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: next ?? '' }] };
          },
        };
      },
    },
  } as unknown as Anthropic;
}

const opus = resolveCoachModel('claude-opus-5-5');

describe('generateWeeklyDocument', () => {
  it('sends one structured request on the coach model with the recap, and returns the validated document', async () => {
    const script: Scripted = { replies: [JSON.stringify(GOOD_DOC)], requests: [] };
    const result = await generateWeeklyDocument(fakeClient(script), opus, inputs());
    expect(result).toMatchObject({ ok: true, document: { headline: GOOD_DOC.headline }, warnings: [] });
    expect(script.requests).toHaveLength(1);
    const [request] = script.requests;
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: WEEKLY_MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: weeklyOutputSchema() } },
    });
    expect(request.system).toBe(buildWeeklySystemPrompt());
    expect((request.messages as Array<{ role: string; content: string }>)[0].content).toContain('WEEK UNDER REVIEW');
  });

  it('falls back to the prompt-only request when the model rejects the output format', async () => {
    const rejected = Object.assign(new Error('400 output_config.format is not supported on this model'), { status: 400 });
    const script: Scripted = { replies: [rejected, JSON.stringify(GOOD_DOC)], requests: [] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await generateWeeklyDocument(fakeClient(script), resolveCoachModel('claude-haiku-4-5-20251001'), inputs());
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect(script.requests).toHaveLength(2);
    expect(script.requests[0]).toHaveProperty('output_config');
    expect(script.requests[1]).not.toHaveProperty('output_config');
    expect(script.requests[1]).not.toHaveProperty('thinking');
  });

  it('rethrows any other failure', async () => {
    const script: Scripted = { replies: [Object.assign(new Error('401 invalid x-api-key'), { status: 401 })], requests: [] };
    await expect(generateWeeklyDocument(fakeClient(script), opus, inputs())).rejects.toThrow('invalid x-api-key');
  });

  it('retries once with the parse error when the reply is not a document, then reports the failure', async () => {
    const script: Scripted = { replies: ['Sure! Here is your week.', 'still not json'], requests: [] };
    const result = await generateWeeklyDocument(fakeClient(script), opus, inputs());
    expect(result).toEqual({ ok: false, parseError: expect.stringContaining('not valid JSON') });
    expect(script.requests).toHaveLength(2);
    const messages = script.requests[1].messages as Array<{ role: string; content: string }>;
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1].content).toBe('Sure! Here is your week.');
    expect(messages[2].content).toContain('not valid JSON');
  });

  it('accepts the corrected reply on the second round', async () => {
    const script: Scripted = { replies: ['{"headline": ""}', JSON.stringify(GOOD_DOC)], requests: [] };
    const result = await generateWeeklyDocument(fakeClient(script), opus, inputs());
    expect(result.ok).toBe(true);
    expect(script.requests).toHaveLength(2);
    expect((script.requests[1].messages as Array<{ content: string }>)[2].content).toContain('no headline');
  });

  it('skips the correction round once the time budget is spent', async () => {
    const script: Scripted = { replies: ['nope', JSON.stringify(GOOD_DOC)], requests: [] };
    let t = 0;
    const clock = () => { t += 30_000; return t; };
    const result = await generateWeeklyDocument(fakeClient(script), opus, inputs(), clock);
    expect(result.ok).toBe(false);
    expect(script.requests).toHaveLength(1);
  });
});
