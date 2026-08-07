import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/completions';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  upserted?: Record<string, unknown>;
  logged?: Record<string, unknown>;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      return {
        upsert: async (row: Record<string, unknown>) => {
          if (table === 'workout_completions') state.upserted = row;
          return { error: null };
        },
        insert: async (row: Record<string, unknown>) => {
          if (table === 'workout_completion_log') state.logged = row;
          return { error: null };
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
  state = {};
  mockedAdmin.mockReturnValue(makeAdmin(state));
});

const completionRow = {
  event_id: 'evt-1',
  event_date: '2026-08-07',
  event_type: 'weights',
  event_title: 'Bench',
  duration_minutes: 60,
  is_completed: true,
  completed_at: '2026-08-07T10:00:00Z',
  updated_at: '2026-08-07T10:00:00Z', // client clock — must be re-stamped
};

const logRow = {
  event_id: 'evt-1',
  event_date: '2026-08-07',
  event_type: 'weights',
  event_title: 'Bench',
  duration_minutes: 60,
  action: 'complete',
};

describe('POST /api/completions — row allowlist', () => {
  it('400s on a smuggled log column (backdating), naming it, and writes nothing', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ completionRow, logRow: { ...logRow, forged_column: 'x' } }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('forged_column');
    expect(state.upserted).toBeUndefined();
    expect(state.logged).toBeUndefined();
  });

  it('silently drops server-stamped fields and re-stamps updated_at itself', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({
      completionRow,
      logRow: { ...logRow, logged_at: '1999-01-01T00:00:00Z', user_id: 'someone-else' },
    }), res);
    expect(statusCode()).toBe(200);
    // logged_at never taken from the request — the DB default stamps it
    expect(state.logged).not.toHaveProperty('logged_at');
    expect(state.logged).toMatchObject({ user_id: 'user-123' });
    // updated_at re-stamped server-side, not the client's clock
    expect(state.upserted?.updated_at).not.toBe(completionRow.updated_at);
    expect(state.upserted).toMatchObject({ user_id: 'user-123', event_id: 'evt-1' });
  });

  it('400s on an action outside complete/uncomplete', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ completionRow, logRow: { ...logRow, action: 'fabricate' } }), res);
    expect(statusCode()).toBe(400);
    expect(state.logged).toBeUndefined();
  });

  it('400s when identity fields are missing', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ completionRow: { is_completed: true }, logRow }), res);
    expect(statusCode()).toBe(400);
  });
});
