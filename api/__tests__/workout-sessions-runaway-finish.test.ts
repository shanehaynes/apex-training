import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { TIMESTAMP_WINDOW_BODY } from '../_lib/handlers/workoutSessions';
import { buildBootstrap } from '../_lib/trackerSession';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import type { WorkoutEvent } from '../../src/types/workout';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/services/liveActivity.js', () => ({ endLiveActivities: vi.fn(async () => 0) }));
vi.mock('../_lib/trackerSession.js', async (importOriginal) => ({
  // buildBootstrap stays real (R3 is asserted on it); the finish's event and
  // summary loaders are scripted.
  ...(await importOriginal<typeof import('../_lib/trackerSession.js')>()),
  loadResolvedOccurrence: vi.fn(async () => null),
}));

// docs/specs/tracker-runaway-finish: R3 (the bootstrap's lastLoggedAt) and
// R4 (the finish window reaches back to the session's own start).

const DAY_MS = 86_400_000;

interface State {
  /** The session row the finish reads. */
  startedAt: string;
  /** The occurrence's saved rows, by table, for the bootstrap. */
  saved: Record<string, Array<Record<string, unknown>>>;
  updates: Array<{ table: string; patch: Record<string, unknown> }>;
}

/**
 * A thenable builder over a table: the occurrence's own set and cardio rows
 * answer from `saved`; any query with `.lt` (prior history) and every other
 * table answers empty; `.single()` is the finish's session fetch.
 */
function makeAdmin(state: State) {
  return {
    from(table: string) {
      let history = false;
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'not', 'order', 'range', 'is', 'limit']) b[m] = () => b;
      b.lt = () => { history = true; return b; };
      b.update = (patch: Record<string, unknown>) => { state.updates.push({ table, patch }); return b; };
      b.upsert = () => b;
      b.single = async () => ({ data: { started_at: state.startedAt }, error: null });
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({
        data: history ? [] : state.saved[table] ?? [],
        error: null,
      }).then(resolve);
      return b;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

const makeReq = (body: unknown) => ({ method: 'POST', headers: {}, body, query: {} }) as unknown as VercelRequest;

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

let state: State;
beforeEach(() => {
  state = { startedAt: new Date().toISOString(), saved: {}, updates: [] };
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin(state));
});

const finish = async (finishedAt: string) => {
  const r = makeRes();
  await handler(makeReq({ action: 'finish', eventId: 'evt-1', eventDate: '2026-08-07', autofillRows: [], finishedAt }), r.res);
  return r;
};
const sessionPatch = () => state.updates.find(u => u.table === 'workout_sessions')?.patch;

describe('finish — the window reaches back to the session start (R4)', () => {
  it('accepts a finishedAt older than a week when it is inside the session', async () => {
    const started = Date.now() - 20 * DAY_MS;
    state.startedAt = new Date(started).toISOString();
    const chosen = new Date(started + 28 * 60_000).toISOString();

    const { statusCode, body } = await finish(chosen);

    expect(statusCode()).toBe(200);
    expect(sessionPatch()).toMatchObject({ finished_at: chosen, total_duration_seconds: 28 * 60 });
    expect(body()).toMatchObject({ ok: true, totalDurationSeconds: 28 * 60 });
  });

  it('accepts a finishedAt exactly at a start older than a week', async () => {
    state.startedAt = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const { statusCode } = await finish(state.startedAt);
    expect(statusCode()).toBe(200);
    expect(sessionPatch()).toMatchObject({ total_duration_seconds: 0 });
  });

  it('400s timestamp-out-of-window for a finishedAt before both the week and the start', async () => {
    const started = Date.now() - 20 * DAY_MS;
    state.startedAt = new Date(started).toISOString();

    const { statusCode, body } = await finish(new Date(started - 60_000).toISOString());

    expect(statusCode()).toBe(400);
    expect(body()).toBe(TIMESTAMP_WINDOW_BODY);
    expect(state.updates).toEqual([]);
  });

  it('400s a finishedAt inside the week but before the start, as before', async () => {
    state.startedAt = new Date(Date.now() - 3600_000).toISOString();

    const { statusCode, body } = await finish(new Date(Date.now() - 2 * 3600_000).toISOString());

    expect(statusCode()).toBe(400);
    expect(body()).toBe('finishedAt precedes the session start');
    expect(state.updates).toEqual([]);
  });

  it('still 400s a finishedAt in the future, however old the start', async () => {
    state.startedAt = new Date(Date.now() - 20 * DAY_MS).toISOString();
    const { statusCode, body } = await finish(new Date(Date.now() + 3600_000).toISOString());
    expect(statusCode()).toBe(400);
    expect(body()).toBe(TIMESTAMP_WINDOW_BODY);
  });

  it('keeps the week for a session whose start does not parse', async () => {
    state.startedAt = 'not a time';
    const { statusCode, body } = await finish(new Date(Date.now() - 8 * DAY_MS).toISOString());
    expect(statusCode()).toBe(400);
    expect(body()).toBe(TIMESTAMP_WINDOW_BODY);
  });
});

describe('bootstrap — lastLoggedAt (R3)', () => {
  const event: WorkoutEvent = {
    id: 'evt-1', date: '2026-09-11', type: 'stretching', title: 'Nightly Stretch', estimatedDuration: 29,
    description: '', difficulty: 2, tags: [], isCompleted: false, isRecurring: false,
    exercises: [
      { id: 'hold', name: 'Pigeon', category: 'stretch', sets: 2, duration: '1:00' },
      { id: 'walk', name: 'Walk', category: 'cardio', duration: '10 min' },
    ],
  } as unknown as WorkoutEvent;
  const setRow = (setNumber: number, updatedAt: string, autofilled = false) => ({
    event_id: 'evt-1', event_date: '2026-09-11', section: 'exercise', exercise_id: 'hold', exercise_name: 'Pigeon',
    set_number: setNumber, actual_duration: '1:00', is_autofilled: autofilled, updated_at: updatedAt,
  });

  it('is the latest updated_at among the set and cardio rows the athlete logged', async () => {
    state.saved = {
      workout_set_logs: [
        setRow(1, '2026-09-11T22:31:00+00:00'),
        setRow(2, '2026-09-11T22:46:00+00:00'),
        // A zero-fill from an earlier finish is not a set the athlete logged.
        setRow(3, '2026-09-21T16:18:26+00:00', true),
      ],
      workout_cardio_logs: [{
        event_id: 'evt-1', event_date: '2026-09-11', section: 'exercise', exercise_id: 'walk', exercise_name: 'Walk',
        duration_minutes: 10, is_autofilled: false, updated_at: '2026-09-11T22:40:00+00:00',
      }],
    };
    const boot = await buildBootstrap(getSupabaseAdmin()!, 'user-123', null, event);
    expect(boot.lastLoggedAt).toBe('2026-09-11T22:46:00+00:00');

    // A cardio row later than every set wins.
    state.saved.workout_cardio_logs[0].updated_at = '2026-09-11T22:50:00+00:00';
    expect((await buildBootstrap(getSupabaseAdmin()!, 'user-123', null, event)).lastLoggedAt)
      .toBe('2026-09-11T22:50:00+00:00');
  });

  it('is null with nothing logged', async () => {
    const boot = await buildBootstrap(getSupabaseAdmin()!, 'user-123', null, event);
    expect(boot.lastLoggedAt).toBeNull();
    expect(boot).toHaveProperty('lastLoggedAt', null);
  });
});
