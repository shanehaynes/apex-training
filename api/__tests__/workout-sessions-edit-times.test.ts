import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/workoutSessions';
import { applyEditTimes, validateEditTimes } from '../_lib/trackerSession';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/services/liveActivity.js', () => ({ endLiveActivities: vi.fn(async () => undefined) }));

// edit-times (rulings R4.1–R4.5) and the phase55 per-set validation in
// prepareLogRows: the bounds are the edit's own, a quick-complete or synced
// session is refused with a reason, the duration is recomputed and mirrored
// onto the completion row, and an out-of-range rpe/attempts/ascent_style is
// a 400 that names the field, never the CHECK's 500.

const NOW = new Date('2026-09-07T12:00:00.000Z');

interface AdminState {
  /** The workout_sessions row maybeSingle() finds; null = no session. */
  session: { finished_at: string | null } | null;
  /** Count of hand-logged (is_autofilled = false) set / cardio rows. */
  performedSets: number;
  performedCardio: number;
  /** provider_activity_imports rows for the occurrence that wrote something. */
  imports: number;
  /** …and "Don't import" rows (mode 'skipped', phase59), which wrote nothing. */
  skippedImports?: number;
  /** Recorded: every update payload, by table. */
  updates: Array<{ table: string; row: Record<string, unknown>; filters: Array<[string, unknown]> }>;
  /** Recorded: every upsert, by table. */
  upserts: Array<{ table: string; rows: unknown }>;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let op: 'select' | 'update' | 'upsert' | 'delete' = 'select';
      let filters: Array<[string, unknown]> = [];
      const count = (): number => {
        if (table === 'workout_set_logs') return state.performedSets;
        if (table === 'workout_cardio_logs') return state.performedCardio;
        if (table === 'provider_activity_imports') {
          const excludesSkips = filters.some(([c, v]) => c === '!mode' && v === 'skipped');
          return state.imports + (excludesSkips ? 0 : state.skippedImports ?? 0);
        }
        return 0;
      };
      const settle = () => {
        if (op === 'select' && table === 'workout_sessions') return { data: state.session, error: null, count: null };
        if (op === 'select') return { data: null, error: null, count: count() };
        return { data: null, error: null, count: null };
      };
      for (const m of ['is', 'in', 'lt', 'not', 'order', 'range', 'limit']) b[m] = () => b;
      b.eq = (column: string, value: unknown) => { filters.push([column, value]); return b; };
      b.neq = (column: string, value: unknown) => { filters.push([`!${column}`, value]); return b; };
      b.select = () => b;
      b.update = (row: Record<string, unknown>) => {
        op = 'update';
        filters = [];
        const entry = { table, row, filters };
        state.updates.push(entry);
        return b;
      };
      b.upsert = (rows: unknown) => { op = 'upsert'; state.upserts.push({ table, rows }); return b; };
      b.delete = () => { op = 'delete'; return b; };
      b.maybeSingle = async () => settle();
      b.single = async () => settle();
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
      return b;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body: unknown): VercelRequest {
  return { method: 'POST', headers: {}, body, query: {} } as unknown as VercelRequest;
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

let state: AdminState;
const OCCURRENCE = { eventId: 'w1-sat-weights__2026-09-07', eventDate: '2026-09-07' };
const GOOD_TIMES = { startedAt: '2026-09-07T07:30:00.000Z', finishedAt: '2026-09-07T08:45:00.000Z' };

beforeEach(() => {
  state = {
    session: { finished_at: '2026-09-07T09:00:00.000Z' },
    performedSets: 3, performedCardio: 0, imports: 0,
    updates: [], upserts: [],
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdmin(state));
});

describe('validateEditTimes — R4.3 bounds, R4.5 any day inside them', () => {
  it('accepts a start on the day before the event and recomputes the duration', () => {
    const result = validateEditTimes(
      { startedAt: '2026-09-06T22:30:00.000Z', finishedAt: '2026-09-06T23:45:00.000Z' }, '2026-09-07', NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.totalDurationSeconds).toBe(75 * 60);
  });

  it('refuses a start earlier than the day before the event', () => {
    const result = validateEditTimes(
      { startedAt: '2026-09-05T23:59:00.000Z', finishedAt: '2026-09-07T08:00:00.000Z' }, '2026-09-07', NOW,
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.message).toMatch(/day before/);
  });

  it('refuses a finish before the start, and one past now + 5 min', () => {
    const backwards = validateEditTimes(
      { startedAt: '2026-09-07T09:00:00.000Z', finishedAt: '2026-09-07T08:00:00.000Z' }, '2026-09-07', NOW,
    );
    expect(backwards).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/after the start/) });

    const future = validateEditTimes(
      { startedAt: '2026-09-07T11:00:00.000Z', finishedAt: '2026-09-07T12:06:00.000Z' }, '2026-09-07', NOW,
    );
    expect(future).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/future/) });

    const skew = validateEditTimes(
      { startedAt: '2026-09-07T11:00:00.000Z', finishedAt: '2026-09-07T12:04:00.000Z' }, '2026-09-07', NOW,
    );
    expect(skew.ok).toBe(true);
  });

  it('refuses anything that is not a timestamp', () => {
    expect(validateEditTimes({ startedAt: 'yesterday', finishedAt: GOOD_TIMES.finishedAt }, '2026-09-07', NOW))
      .toMatchObject({ ok: false, status: 400 });
    expect(validateEditTimes({ startedAt: 1_700_000_000, finishedAt: GOOD_TIMES.finishedAt }, '2026-09-07', NOW))
      .toMatchObject({ ok: false, status: 400 });
    expect(validateEditTimes({ startedAt: undefined, finishedAt: undefined }, '2026-09-07', NOW))
      .toMatchObject({ ok: false, status: 400 });
  });
});

describe('applyEditTimes — R4.1, R4.2, R4.4', () => {
  const run = () => applyEditTimes(makeAdmin(state), 'user-123', OCCURRENCE.eventId, OCCURRENCE.eventDate, GOOD_TIMES, NOW);

  it('is a 404 with no session and a 409 while the session is still running', async () => {
    state.session = null;
    expect(await run()).toMatchObject({ ok: false, status: 404 });
    state.session = { finished_at: null };
    expect(await run()).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/finished/) });
    expect(state.updates).toEqual([]);
  });

  it('refuses a quick-completed session (every row autofilled) and says so', async () => {
    state.performedSets = 0;
    state.performedCardio = 0;
    const result = await run();
    expect(result).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/marked complete/) });
    expect(state.updates).toEqual([]);
  });

  it('a hand-logged cardio row is enough to make the session tracker-logged', async () => {
    state.performedSets = 0;
    state.performedCardio = 1;
    expect((await run()).ok).toBe(true);
  });

  it('refuses a session a synced activity filled and names the sync', async () => {
    state.imports = 1;
    const result = await run();
    expect(result).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/synced activity/) });
    expect(state.updates).toEqual([]);
  });

  it('a declined Health import ("Don\'t import") never locks the times', async () => {
    state.skippedImports = 1;
    expect((await run()).ok).toBe(true);
  });

  it('applies the bounds before writing', async () => {
    const result = await applyEditTimes(makeAdmin(state), 'user-123', OCCURRENCE.eventId, OCCURRENCE.eventDate,
      { startedAt: GOOD_TIMES.finishedAt, finishedAt: GOOD_TIMES.startedAt }, NOW);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(state.updates).toEqual([]);
  });

  it('rewrites the session times and duration, mirrors the minutes onto the completion, touches nothing else', async () => {
    const result = await run();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.totalDurationSeconds).toBe(75 * 60);

    expect(state.updates).toHaveLength(2);
    const [session, completion] = state.updates;
    expect(session.table).toBe('workout_sessions');
    expect(session.row).toEqual({
      started_at: GOOD_TIMES.startedAt,
      finished_at: GOOD_TIMES.finishedAt,
      total_duration_seconds: 75 * 60,
      updated_at: NOW.toISOString(),
    });
    expect(session.filters).toEqual([['user_id', 'user-123'], ['event_id', OCCURRENCE.eventId], ['event_date', OCCURRENCE.eventDate]]);
    expect(completion.table).toBe('workout_completions');
    expect(completion.row).toEqual({ duration_minutes: 75, updated_at: NOW.toISOString() });
    expect(completion.filters).toEqual([['user_id', 'user-123'], ['event_id', OCCURRENCE.eventId], ['event_date', OCCURRENCE.eventDate]]);
    // R4.4: never the score, never the coach's summary.
    for (const u of state.updates) {
      expect(Object.keys(u.row)).not.toEqual(expect.arrayContaining(['coach_summary']));
      expect(Object.keys(u.row).some(k => k.startsWith('score_'))).toBe(false);
    }
  });
});

describe('POST /api/workout-sessions edit-times', () => {
  it('answers the corrected times and duration', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ action: 'edit-times', ...OCCURRENCE, ...GOOD_TIMES }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ ok: true, ...GOOD_TIMES, totalDurationSeconds: 75 * 60 });
  });

  it('passes a refusal through with its reason', async () => {
    state.imports = 1;
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ action: 'edit-times', ...OCCURRENCE, ...GOOD_TIMES }), res);
    expect(statusCode()).toBe(409);
    expect(String(body())).toMatch(/synced activity/);
  });
});

describe('POST /api/workout-sessions save — phase55 row validation', () => {
  const row = (over: Record<string, unknown>) => ({
    event_id: OCCURRENCE.eventId, event_date: OCCURRENCE.eventDate, section: 'exercise',
    exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 1,
    actual_weight: '185', actual_reps: '5', is_autofilled: false,
    ...over,
  });
  const save = async (setLogs: unknown[], extra: Record<string, unknown> = {}) => {
    const r = makeRes();
    await handler(makeReq({ action: 'save', ...OCCURRENCE, setLogs, ...extra }), r.res);
    return r;
  };

  it('is a 400 naming the field for an out-of-range rpe, attempts or ascent_style', async () => {
    for (const [bad, pattern] of [
      [{ rpe: 11 }, /rpe/],
      [{ rpe: 0.5 }, /rpe/],
      [{ rpe: '8' }, /rpe/],
      [{ attempts: -1 }, /attempts/],
      [{ attempts: 1.5 }, /attempts/],
      [{ ascent_style: 'onsight' }, /ascent_style/],
      [{ is_warmup: 'yes' }, /is_warmup/],
    ] as const) {
      const { statusCode, body } = await save([row(bad)]);
      expect(statusCode(), JSON.stringify(bad)).toBe(400);
      expect(String(body())).toMatch(pattern);
    }
    expect(state.upserts).toEqual([]);
  });

  it('accepts in-range metadata and nulls', async () => {
    const { statusCode } = await save([
      row({ rpe: 7.5, is_warmup: true }),
      row({ set_number: 2, rpe: null, attempts: 0, ascent_style: 'flash' }),
      row({ set_number: 3 }),
    ]);
    expect(statusCode()).toBe(200);
    // One upsert per row shape: a batch is sent as the union of its keys,
    // and a key a row omits would arrive as NULL (is_warmup is NOT NULL).
    expect(state.upserts.map(u => (u.rows as unknown[]).length)).toEqual([1, 1, 1]);
  });

  it('writes the session note, trimmed, and clears it on an empty string', async () => {
    await save([], { sessionNote: '  slept badly  ' });
    await save([], { sessionNote: '' });
    const notes = state.updates.filter(u => u.table === 'workout_sessions').map(u => u.row.note);
    expect(notes).toEqual(['slept badly', null]);
  });

  it('refuses a session note that is not a string or is too long', async () => {
    expect((await save([], { sessionNote: 42 })).statusCode()).toBe(400);
    expect((await save([], { sessionNote: 'x'.repeat(2001) })).statusCode()).toBe(400);
    expect(state.updates).toEqual([]);
  });

  it('leaves the note alone when the save does not mention it', async () => {
    await save([row({})]);
    expect(state.updates.filter(u => u.table === 'workout_sessions')).toEqual([]);
  });
});
