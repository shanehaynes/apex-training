import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../workout-sessions';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  upserts: Record<string, Record<string, unknown>[]>;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      return {
        upsert: async (rows: Record<string, unknown>[] | Record<string, unknown>) => {
          state.upserts[table] = Array.isArray(rows) ? rows : [rows];
          return { error: null };
        },
        update: () => ({
          eq: () => ({ eq: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }) }),
        }),
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
  state = { upserts: {} };
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
