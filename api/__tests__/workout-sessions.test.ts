import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/workoutSessions';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/trackerSession.js', () => ({
  loadResolvedOccurrence: vi.fn(async (_db: unknown, _u: string, eventId: string, eventDate: string) =>
    eventId === 'missing' ? null : {
      id: eventId, date: eventDate, type: 'weights', title: 'Bench', estimatedDuration: 45, description: '',
      difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
      exercises: [
        { id: 'bench', name: 'Bench Press', category: 'strength', sets: 2, reps: '5', weight: '100 lb' },
        { id: 'row', name: 'Easy Row', category: 'cardio', duration: '20 min' },
      ],
    }),
}));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  filters: Record<string, unknown>;
}

interface AdminState {
  upserts: Record<string, Record<string, unknown>[]>;
  updates: UpdateCall[];
}

/**
 * A thenable filter chain: PostgREST builders resolve wherever the caller
 * stops chaining, so `.eq().eq()` and `.eq().eq().eq().is()` both have to be
 * awaitable. Records the filters so a test can assert what a write was
 * scoped to — the user_id/event scoping is the security-relevant part.
 */
function updateChain(call: UpdateCall) {
  const chain = {
    eq(column: string, value: unknown) { call.filters[column] = value; return chain; },
    is(column: string, value: unknown) { call.filters[column] = value; return chain; },
    then<T>(resolve: (r: { error: null }) => T) { return Promise.resolve({ error: null }).then(resolve); },
  };
  return chain;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      return {
        upsert: async (rows: Record<string, unknown>[] | Record<string, unknown>) => {
          state.upserts[table] = Array.isArray(rows) ? rows : [rows];
          return { error: null };
        },
        update: (patch: Record<string, unknown>) => {
          const call: UpdateCall = { table, patch, filters: {} };
          state.updates.push(call);
          return updateChain(call);
        },
        // The finish action's session fetch — a minute-old started_at gives
        // it a sane duration to compute.
        select: () => {
          const chain = {
            eq: () => chain,
            single: async () => ({
              data: { started_at: new Date(Date.now() - 60_000).toISOString() },
              error: null,
            }),
          };
          return chain;
        },
      };
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(body?: unknown): VercelRequest {
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

beforeEach(() => {
  state = { upserts: {}, updates: [] };
  mockedAdmin.mockReturnValue(makeAdmin(state));
});

const setLog = {
  event_id: 'evt-1',
  event_date: '2026-08-07',
  section: 'exercise',
  exercise_id: 'bench',
  exercise_name: 'Bench Press',
  set_number: 1,
  planned_weight: '100 lb',
  planned_reps: '5',
  planned_duration: null,
  actual_weight: '100 lb',
  actual_reps: '5',
  actual_duration: null,
  is_autofilled: false,
};

describe('POST /api/workout-sessions — save row validation', () => {
  it('400s on a smuggled row column, naming the row, and writes nothing', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({
      action: 'save', eventId: 'evt-1', eventDate: '2026-08-07',
      setLogs: [setLog, { ...setLog, set_number: 2, forged: true }],
    }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('setLogs[1]');
    expect(String(body())).toContain('forged');
    expect(state.upserts['workout_set_logs']).toBeUndefined();
  });

  it('silently drops a client-supplied id/user_id and stamps its own', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      action: 'save', eventId: 'evt-1', eventDate: '2026-08-07',
      setLogs: [{ ...setLog, id: 'collide-with-existing', user_id: 'someone-else' }],
    }), res);
    expect(statusCode()).toBe(200);
    const row = state.upserts['workout_set_logs'][0];
    expect(row.id).toBeUndefined();
    expect(row.user_id).toBe('user-123');
    expect(row).toHaveProperty('updated_at');
  });

  it('400s on a row missing its conflict-target identity', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      action: 'save', eventId: 'evt-1', eventDate: '2026-08-07',
      setLogs: [{ ...setLog, section: 'not-a-section' }],
    }), res);
    expect(statusCode()).toBe(400);
  });

  it('caps batch size', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      action: 'save', eventId: 'evt-1', eventDate: '2026-08-07',
      setLogs: Array.from({ length: 501 }, (_, i) => ({ ...setLog, set_number: i })),
    }), res);
    expect(statusCode()).toBe(400);
    expect(state.upserts['workout_set_logs']).toBeUndefined();
  });
});

describe('POST /api/workout-sessions — swap-exercise', () => {
  const swap = {
    action: 'swap-exercise', eventId: 'evt-1', eventDate: '2026-08-07',
    section: 'exercise', exerciseId: 'ring-dips',
    exerciseName: 'Single-Arm Dumbbell Press', definitionId: 'def-db-press',
  };

  it('relabels both log tables, scoped to the caller and this one occurrence', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq(swap), res);
    expect(statusCode()).toBe(200);

    expect(state.updates.map(u => u.table).sort())
      .toEqual(['workout_cardio_logs', 'workout_set_logs']);
    for (const call of state.updates) {
      expect(call.patch).toMatchObject({
        exercise_name: 'Single-Arm Dumbbell Press',
        definition_id: 'def-db-press',
      });
      // Scoped tightly enough that no other day, exercise, or user moves.
      expect(call.filters).toEqual({
        user_id: 'user-123',
        event_id: 'evt-1',
        event_date: '2026-08-07',
        section: 'exercise',
        exercise_id: 'ring-dips',
      });
    }
  });

  it('never touches the planned prescription — only the logs', async () => {
    const { res } = makeRes();
    await handler(makeReq(swap), res);
    expect(state.updates.some(u => u.table === 'workout_events')).toBe(false);
    expect(state.upserts['workout_events']).toBeUndefined();
  });

  it('trims the name and accepts a null definitionId', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ ...swap, exerciseName: '  Push-Up  ', definitionId: null }), res);
    expect(statusCode()).toBe(200);
    expect(state.updates[0].patch).toMatchObject({ exercise_name: 'Push-Up', definition_id: null });
  });

  it('400s on a bad target and writes nothing', async () => {
    const bad: Record<string, unknown>[] = [
      { ...swap, section: 'not-a-section' },
      { ...swap, exerciseId: '' },
      { ...swap, exerciseId: 42 },
      { ...swap, exerciseName: '   ' },
      { ...swap, exerciseName: 'x'.repeat(201) },
      { ...swap, definitionId: { id: 'nope' } },
    ];
    for (const body of bad) {
      state.updates = [];
      const { res, statusCode } = makeRes();
      await handler(makeReq(body), res);
      expect(statusCode(), JSON.stringify(body)).toBe(400);
      expect(state.updates).toHaveLength(0);
    }
  });
});

describe('POST /api/workout-sessions — quick-complete guards', () => {
  it('400s on a non-finite durationSeconds instead of an opaque 500', async () => {
    for (const bad of [Infinity, NaN, -5, 1e20, 'sixty']) {
      const { res, statusCode } = makeRes();
      await handler(makeReq({
        action: 'quick-complete', eventId: 'evt-1', eventDate: '2026-08-07',
        durationSeconds: bad,
      }), res);
      expect(statusCode(), `durationSeconds=${String(bad)}`).toBe(400);
    }
  });

  it('accepts a sane durationSeconds and forces is_autofilled on planned rows', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      action: 'quick-complete', eventId: 'evt-1', eventDate: '2026-08-07',
      durationSeconds: 3600,
      setLogs: [{ ...setLog, is_autofilled: false }],
    }), res);
    expect(statusCode()).toBe(200);
    expect(state.upserts['workout_set_logs'][0].is_autofilled).toBe(true);
  });
});

describe('POST /api/workout-sessions — quick-complete without rows (server-built)', () => {
  it('builds planned rows from the resolved event and stamps the recommended duration', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ action: 'quick-complete', eventId: 'evt-1__2026-08-07', eventDate: '2026-08-07' }), res);
    expect(statusCode()).toBe(200);
    const sets = state.upserts['workout_set_logs'];
    expect(sets.map(r => [r.event_id, r.event_date, r.set_number, r.actual_weight, r.is_autofilled])).toEqual([
      ['evt-1__2026-08-07', '2026-08-07', 1, '100 lb', true],
      ['evt-1__2026-08-07', '2026-08-07', 2, '100 lb', true],
    ]);
    expect(state.upserts['workout_cardio_logs'][0]).toMatchObject({ exercise_id: 'row', duration_minutes: 20, is_autofilled: true });
    const finish = state.updates.find(u => u.table === 'workout_sessions')!;
    expect(finish.patch.total_duration_seconds).toBe(45 * 60);
  });

  it('lets an explicit durationSeconds win over the plan', async () => {
    const { res } = makeRes();
    await handler(makeReq({ action: 'quick-complete', eventId: 'evt-1', eventDate: '2026-08-07', durationSeconds: 600 }), res);
    expect(state.updates.find(u => u.table === 'workout_sessions')!.patch.total_duration_seconds).toBe(600);
  });

  it('404s when the caller owns no such event, writing nothing', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ action: 'quick-complete', eventId: 'missing', eventDate: '2026-08-07' }), res);
    expect(statusCode()).toBe(404);
    expect(state.upserts['workout_sessions']).toBeUndefined();
  });
});

describe('POST /api/workout-sessions — finish score validation', () => {
  const finish = (score?: unknown) => makeReq({
    action: 'finish', eventId: 'evt-1', eventDate: '2026-08-07', autofillRows: [],
    ...(score !== undefined ? { score } : {}),
  });
  const sessionPatch = () => state.updates.find(u => u.table === 'workout_sessions');

  it('finishes without a score exactly as before', async () => {
    const { res, statusCode } = makeRes();
    await handler(finish(), res);
    expect(statusCode()).toBe(200);
    expect(sessionPatch()!.patch.score_type).toBeUndefined();
  });

  it('accepts a for-time score and stamps its columns, caller-scoped', async () => {
    const { res, statusCode } = makeRes();
    await handler(finish({ templateId: 'wt-1', type: 'for-time', timeSeconds: 2492 }), res);
    expect(statusCode()).toBe(200);
    const call = sessionPatch()!;
    expect(call.patch.template_id).toBe('wt-1');
    expect(call.patch.score_type).toBe('for-time');
    expect(call.patch.score_time_seconds).toBe(2492);
    expect(call.filters.user_id).toBe('user-123');
    expect(call.filters.event_id).toBe('evt-1');
  });

  it('accepts an amrap score, defaulting extra reps to 0', async () => {
    const { res, statusCode } = makeRes();
    await handler(finish({ templateId: 'wt-1', type: 'amrap', rounds: 18 }), res);
    expect(statusCode()).toBe(200);
    const call = sessionPatch()!;
    expect(call.patch.score_type).toBe('amrap');
    expect(call.patch.score_rounds).toBe(18);
    expect(call.patch.score_reps).toBe(0);
    expect(call.patch.score_time_seconds).toBeUndefined();
  });

  it('400s before any write on a malformed score', async () => {
    for (const score of [
      { templateId: 'wt-1', type: 'for-time', timeSeconds: -5 },
      { templateId: 'wt-1', type: 'for-time', timeSeconds: 12.5 },
      { templateId: 'wt-1', type: 'amrap', timeSeconds: 100 },
      { templateId: 'bad id!', type: 'for-time', timeSeconds: 100 },
      { templateId: 'wt-1', type: 'emom', rounds: 3 },
      null,
    ]) {
      state.updates = [];
      const { res, statusCode } = makeRes();
      await handler(finish(score), res);
      expect(statusCode(), JSON.stringify(score)).toBe(400);
      expect(state.updates).toEqual([]);
    }
  });
});
