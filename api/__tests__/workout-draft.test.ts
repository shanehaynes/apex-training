import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/workoutDraft';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceAiMutationCap, enforceRateLimit } from '../_lib/rateLimit';
import * as events from '../_lib/services/events';
import { detachInstance } from '../_lib/services/eventInstances';
import { upsertTemplate } from '../_lib/services/templates';
import { recordCompletion } from '../_lib/services/completions';
import { quickCompletePlan } from '../_lib/trackerSession';
import { fetchAllPages } from '../_lib/pagination';
import { emptyDraft, type WorkoutDraft } from '../../src/lib/builder/draft';
import type { WorkoutEventRow } from '../../src/lib/db/types';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({
  enforceRateLimit: vi.fn(async () => true),
  enforceAiMutationCap: vi.fn(async () => true),
}));
vi.mock('../_lib/services/events.js', () => ({
  createEvent: vi.fn(async (_s: unknown, _u: unknown, row: { id: string }) => ({ ok: true, value: { id: row.id } })),
  updateEvent: vi.fn(async () => ({ ok: true, value: undefined })),
}));
vi.mock('../_lib/services/eventInstances.js', () => ({
  detachInstance: vi.fn(async (_s: unknown, _u: unknown, _t: unknown, row: { id: string }) => ({ ok: true, value: { id: row.id } })),
}));
vi.mock('../_lib/services/templates.js', () => ({
  upsertTemplate: vi.fn(async (_s: unknown, _u: unknown, row: { id: string }) => ({ ok: true, value: { id: row.id } })),
}));
vi.mock('../_lib/services/completions.js', () => ({ recordCompletion: vi.fn(async () => ({ ok: true, value: undefined })) }));
vi.mock('../_lib/trackerSession.js', () => ({ quickCompletePlan: vi.fn(async () => ({ ok: true, value: undefined })) }));
vi.mock('../_lib/mcp/data.js', () => ({
  fetchDefinitionRows: vi.fn(async () => [
    { id: 'pull-up', canonical_name: 'Pull-up', category: 'strength', aliases: [], muscle_groups: [], equipment: [], is_unilateral: false },
    { id: 'pistol-squat', canonical_name: 'Pistol Squat', category: 'strength', aliases: [], muscle_groups: [], equipment: [], is_unilateral: true },
  ]),
}));
vi.mock('../_lib/pagination.js', () => ({ fetchAllPages: vi.fn(async () => []) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

/** The one base row the ownership lookup can find (null → 404). */
let baseRow: Partial<WorkoutEventRow> | null;

function makeAdmin() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: baseRow, error: null }),
  };
  return { from: () => chain } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown, method = 'POST'): VercelRequest {
  return { method, headers: {}, query: {}, body } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader() { return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload };
}

const TODAY = '2026-09-08';
const seriesRow: Partial<WorkoutEventRow> = {
  id: 'evt-weekly', user_id: 'user-123', title: 'Bench', type: 'weights', date: '2026-09-01', start_time: '17:30',
  end_time: null, estimated_duration: 60, difficulty: 3, description: '', subtitle: 'Heavy',
  warmup: [], exercises: [], cooldown: [], tags: [], equipment: [], location: null, cover_image_url: null,
  cardio_targets: null, climbing_targets: null, source: null, sport: null, template_id: 'wt-bench',
  scoring_type: 'strength', time_cap_minutes: null, is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU',
  recurring_frequency: null, recurring_days: null, recurring_end_date: null,
};
const oneOffRow: Partial<WorkoutEventRow> = { ...seriesRow, id: 'evt-solo', date: '2026-09-10', is_recurring: false, recurrence_rule: null };

function draft(overrides: Partial<WorkoutDraft> = {}): WorkoutDraft {
  return { ...emptyDraft('2026-09-10', 'Leg day'), ...overrides };
}

async function post(body: unknown) {
  const { res, statusCode, body: out } = makeRes();
  await handler(makeReq(body), res);
  return { status: statusCode(), body: out() as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  baseRow = null;
  mockedAdmin.mockReturnValue(makeAdmin());
});

describe('POST /api/workout-draft — request shape', () => {
  it('405s non-POST', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({}, 'GET'), res);
    expect(statusCode()).toBe(405);
  });

  it('400s on a missing draft, a bad today, or a malformed action before touching anything', async () => {
    const cases: [unknown, string][] = [
      [{ today: TODAY, action: { kind: 'create' } }, 'draft must be an object'],
      [{ draft: 'x', today: TODAY, action: { kind: 'create' } }, 'draft must be an object'],
      [{ draft: draft(), today: '09/08/2026', action: { kind: 'create' } }, 'today must be a YYYY-MM-DD date'],
      [{ draft: draft(), today: TODAY }, 'Unknown action'],
      [{ draft: draft(), today: TODAY, action: { kind: 'delete' } }, 'Unknown action'],
      [{ draft: draft(), today: TODAY, action: { kind: 'update' } }, 'Missing eventId'],
      [{ draft: draft(), today: TODAY, action: { kind: 'detach', eventId: 'evt-weekly' } }, 'occurrenceDate must be a YYYY-MM-DD date'],
    ];
    for (const [body, text] of cases) {
      const out = await post(body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.body).toBe(text);
    }
    expect(events.createEvent).not.toHaveBeenCalled();
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  it('uses the writes bucket and never the AI mutation cap', async () => {
    await post({ draft: draft(), today: TODAY, action: { kind: 'create' } });
    expect(vi.mocked(enforceRateLimit).mock.calls[0][3]).toBe('writes');
    expect(enforceAiMutationCap).not.toHaveBeenCalled();
  });

  it('400s on a draft the pure functions cannot read', async () => {
    const out = await post({ draft: { title: 42 }, today: TODAY, action: { kind: 'create' } });
    expect(out.status).toBe(400);
    expect(out.body).toBe('draft is not a valid draft');
  });
});

describe('POST /api/workout-draft — the web\'s validate(), as ok:false on 200', () => {
  it('reports the draft problems in the web\'s order with the web\'s texts', async () => {
    const cases: [Partial<WorkoutDraft>, string][] = [
      [{ title: '  ' }, 'Give the workout a title'],
      [{ duration: '0' }, 'Duration must be a positive number of minutes'],
      [{ scoringType: 'amrap', timeCap: '' }, 'AMRAP needs a time cap in minutes'],
      [{ repeat: { enabled: true, days: [], interval: '1', until: '' } }, 'Pick at least one day to repeat on'],
      [{ repeat: { enabled: true, days: ['MO'], interval: '0', until: '' } }, 'Repeat interval must be at least 1'],
      // 2026-09-10 is a Thursday; the anchor snaps to Monday the 14th, past the end date.
      [{ repeat: { enabled: true, days: ['MO'], interval: '1', until: '2026-09-12' } }, 'The repeat end date is before the first occurrence'],
    ];
    for (const [overrides, problem] of cases) {
      const out = await post({ draft: draft(overrides), today: TODAY, action: { kind: 'create' } });
      expect(out.status, problem).toBe(200);
      expect(out.body).toEqual({ ok: false, problem });
    }
    expect(upsertTemplate).not.toHaveBeenCalled();
    expect(events.createEvent).not.toHaveBeenCalled();
  });

  it('keys unilateral violations by entry id, and accepts a per-side count', async () => {
    const lists = (reps: string) => ({
      warmup: [], cooldown: [],
      exercises: [{ id: 'pistol-1', name: 'Pistol Squat', category: 'strength' as const, definitionId: 'pistol-squat', reps }],
    });
    const bad = await post({ draft: draft({ lists: lists('5') }), today: TODAY, action: { kind: 'create' } });
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, problem: 'Per-side counts needed for unilateral exercises' });
    expect((bad.body.violations as Record<string, string>)['pistol-1']).toMatch(/each side/);
    expect(events.createEvent).not.toHaveBeenCalled();

    const good = await post({ draft: draft({ lists: lists('5 each side') }), today: TODAY, action: { kind: 'create' } });
    expect(good.body).toMatchObject({ ok: true });
  });
});

describe('POST /api/workout-draft — create', () => {
  it('upserts the template first, then inserts the event referencing it, user-attributed', async () => {
    const out = await post({
      draft: draft({ tags: 'legs, heavy', startTime: '06:30', endTime: '07:30' }), today: TODAY, action: { kind: 'create' },
    });
    expect(out.status).toBe(200);

    const [, userId, templateRow] = vi.mocked(upsertTemplate).mock.calls[0];
    expect(userId).toBe('user-123');
    expect(templateRow).toMatchObject({ title: 'Leg day', type: 'weights', scoring_type: 'strength', tags: ['legs', 'heavy'], archived_at: null });
    expect(templateRow.id).toMatch(/^wt-[0-9a-f-]{36}$/);

    const [, , eventRow, triggeredBy] = vi.mocked(events.createEvent).mock.calls[0];
    expect(triggeredBy).toBe('user');
    expect(eventRow).toMatchObject({
      title: 'Leg day', type: 'weights', date: '2026-09-10', start_time: '6:30 AM', end_time: '7:30 AM',
      template_id: templateRow.id, scoring_type: 'strength', is_recurring: false, recurrence_rule: null,
    });
    expect(eventRow.id).toMatch(/^ai-[0-9a-f-]{36}$/);

    expect(out.body).toMatchObject({
      ok: true, action: 'create', id: eventRow.id, templateId: templateRow.id, date: '2026-09-10',
      completedOnCreate: false, isRecurring: false,
    });
    expect(out.body.event).toMatchObject({ id: eventRow.id, title: 'Leg day', startTime: '6:30 AM', templateId: templateRow.id });
    // The template upsert precedes the event insert.
    expect(vi.mocked(upsertTemplate).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(events.createEvent).mock.invocationCallOrder[0]);
  });

  it('resolves template identity: the draft\'s id, else a case-insensitive title match, else a fresh id', async () => {
    vi.mocked(fetchAllPages).mockResolvedValueOnce([{
      id: 'wt-existing', user_id: 'user-123', title: 'LEG DAY', type: 'weights', sport: null, scoring_type: 'strength',
      time_cap_minutes: null, estimated_duration: 60, difficulty: 3, description: '', warmup: null, exercises: [], cooldown: null,
      location: null, tags: [], equipment: null, cardio_targets: null, climbing_targets: null, archived_at: '2026-01-01T00:00:00Z',
      created_at: 'x', updated_at: 'x',
    }]);
    let out = await post({ draft: draft({ title: '  leg   day ' }), today: TODAY, action: { kind: 'create' } });
    expect(out.body).toMatchObject({ templateId: 'wt-existing' });
    // Reapplying an archived title revives it.
    expect(vi.mocked(upsertTemplate).mock.calls[0][2]).toMatchObject({ id: 'wt-existing', archived_at: null });

    out = await post({ draft: draft({ templateId: 'wt-picked' }), today: TODAY, action: { kind: 'create' } });
    expect(out.body).toMatchObject({ templateId: 'wt-picked' });
  });

  it('retro-logs a one-off on a past date: completion + plan-filled session; never a series', async () => {
    let out = await post({ draft: draft({ date: '2026-09-07' }), today: TODAY, action: { kind: 'create' } });
    expect(out.body).toMatchObject({ completedOnCreate: true });
    expect(recordCompletion).toHaveBeenCalledTimes(1);
    expect(quickCompletePlan).toHaveBeenCalledTimes(1);
    expect(vi.mocked(events.createEvent).mock.calls[0][2]).toMatchObject({ date: '2026-09-07' });

    vi.clearAllMocks();
    out = await post({
      draft: draft({ date: '2026-09-07', repeat: { enabled: true, days: ['MO'], interval: '1', until: '' } }),
      today: TODAY, action: { kind: 'create' },
    });
    expect(out.body).toMatchObject({ completedOnCreate: false, isRecurring: true });
    expect(recordCompletion).not.toHaveBeenCalled();
    expect(quickCompletePlan).not.toHaveBeenCalled();
  });

  it('snaps a repeating anchor forward to the first selected weekday and serialises the rule', async () => {
    // 2026-09-10 is a Thursday.
    const out = await post({
      draft: draft({ repeat: { enabled: true, days: ['WE', 'MO'], interval: '2', until: '2026-12-31' } }),
      today: TODAY, action: { kind: 'create' },
    });
    expect(vi.mocked(events.createEvent).mock.calls[0][2]).toMatchObject({
      date: '2026-09-14', is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231',
    });
    expect(out.body).toMatchObject({ date: '2026-09-14', isRecurring: true });
  });

  it('maps a template or event service failure onto its status', async () => {
    vi.mocked(upsertTemplate).mockResolvedValueOnce({ ok: false, status: 500, message: 'Failed to save template' });
    let out = await post({ draft: draft(), today: TODAY, action: { kind: 'create' } });
    expect(out.status).toBe(500);
    expect(out.body).toBe('Failed to save template');
    expect(events.createEvent).not.toHaveBeenCalled();

    vi.mocked(events.createEvent).mockResolvedValueOnce({ ok: false, status: 500, message: 'Failed to create event' });
    out = await post({ draft: draft(), today: TODAY, action: { kind: 'create' } });
    expect(out.status).toBe(500);
    expect(out.body).toBe('Failed to create event');
  });
});

describe('POST /api/workout-draft — update', () => {
  it('404s an event the caller does not own, without writing', async () => {
    const out = await post({ draft: draft(), today: TODAY, action: { kind: 'update', eventId: 'evt-weekly__2026-09-15' } });
    expect(out.status).toBe(404);
    expect(events.updateEvent).not.toHaveBeenCalled();
  });

  it('patches a one-off with its schedule and clears an unset sport explicitly', async () => {
    baseRow = oneOffRow;
    const out = await post({
      draft: draft({ title: 'Bench, lighter', startTime: '07:00', date: '2026-09-12' }), today: TODAY,
      action: { kind: 'update', eventId: 'evt-solo' },
    });
    expect(out.status).toBe(200);
    const [, , id, fields, log] = vi.mocked(events.updateEvent).mock.calls[0];
    expect(id).toBe('evt-solo');
    expect(fields).toMatchObject({ title: 'Bench, lighter', date: '2026-09-12', start_time: '7:00 AM', sport: null });
    // An unset time is omitted, not cleared — the web's eventFieldsToRow drops undefined keys.
    expect(fields).not.toHaveProperty('end_time');
    expect(log).toMatchObject({ event_title: 'Bench, lighter', event_date: '2026-09-12', triggered_by: 'user' });
    expect(out.body).toMatchObject({ ok: true, action: 'update', id: 'evt-solo', date: '2026-09-12', isRecurring: false });
    expect(out.body.event).toMatchObject({ id: 'evt-solo', title: 'Bench, lighter', subtitle: 'Heavy', templateId: 'wt-bench' });
  });

  it('patches a series without its schedule (the anchor must not follow the opened occurrence)', async () => {
    baseRow = seriesRow;
    const out = await post({
      draft: draft({ title: 'Bench', date: '2026-09-15', startTime: '07:00' }), today: TODAY,
      action: { kind: 'update', eventId: 'evt-weekly__2026-09-15' },
    });
    const [, , id, fields] = vi.mocked(events.updateEvent).mock.calls[0];
    expect(id).toBe('evt-weekly');
    expect(fields).not.toHaveProperty('date');
    expect(fields).not.toHaveProperty('start_time');
    expect(fields).not.toHaveProperty('recurrence_rule');
    // The response event keeps the anchor date and the series flag.
    expect(out.body).toMatchObject({ id: 'evt-weekly', date: '2026-09-01', isRecurring: true });
  });

  it('rewrites the series pattern only when the weekly picker is on', async () => {
    baseRow = seriesRow;
    await post({
      draft: draft({ repeat: { enabled: true, days: ['TU', 'TH'], interval: '1', until: '' } }), today: TODAY,
      action: { kind: 'update', eventId: 'evt-weekly' },
    });
    expect(vi.mocked(events.updateEvent).mock.calls[0][3]).toMatchObject({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
  });
});

describe('POST /api/workout-draft — detach', () => {
  it('400s when the event is not recurring', async () => {
    baseRow = oneOffRow;
    const out = await post({ draft: draft(), today: TODAY, action: { kind: 'detach', eventId: 'evt-solo', occurrenceDate: '2026-09-10' } });
    expect(out.status).toBe(400);
    expect(out.body).toBe('Only a recurring workout has an occurrence to detach');
    expect(detachInstance).not.toHaveBeenCalled();
  });

  it('inserts a never-recurring standalone keyed at the occurrence\'s generated date, repeat forced off', async () => {
    baseRow = seriesRow;
    const out = await post({
      draft: draft({ title: 'Bench (deload)', date: '2026-09-16', repeat: { enabled: true, days: ['MO'], interval: '1', until: '' } }),
      today: TODAY, action: { kind: 'detach', eventId: 'evt-weekly__2026-09-15', occurrenceDate: '2026-09-15' },
    });
    expect(out.status).toBe(200);
    const [, , target, row] = vi.mocked(detachInstance).mock.calls[0];
    expect(target).toEqual({ eventId: 'evt-weekly', date: '2026-09-15', eventTitle: 'Bench (deload)', triggeredBy: 'user' });
    expect(row).toMatchObject({ title: 'Bench (deload)', date: '2026-09-16', is_recurring: false, recurrence_rule: null, subtitle: 'Heavy', template_id: 'wt-bench' });
    expect(row.id).toMatch(/^ai-[0-9a-f-]{36}$/);
    expect(row.id).not.toContain('__');
    expect(out.body).toMatchObject({
      ok: true, action: 'detach', id: row.id, detachedFrom: 'evt-weekly', occurrenceDate: '2026-09-15', date: '2026-09-16', isRecurring: false,
    });
  });

  it('keys the anchor occurrence on the date the client supplies (the id carries none)', async () => {
    baseRow = seriesRow;
    await post({ draft: draft(), today: TODAY, action: { kind: 'detach', eventId: 'evt-weekly', occurrenceDate: '2026-08-25' } });
    expect(vi.mocked(detachInstance).mock.calls[0][2]).toMatchObject({ eventId: 'evt-weekly', date: '2026-08-25' });
  });
});
