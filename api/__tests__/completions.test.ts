import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/completions';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface UpsertOptions { onConflict?: string; ignoreDuplicates?: boolean }

interface AdminState {
  upserted?: Record<string, unknown>;
  logged?: Record<string, unknown>;
  logOptions?: UpsertOptions;
  /** Every row workout_completion_log actually holds, in insert order. */
  log: Record<string, unknown>[];
}

/** Stands in for the phase-43 unique index on (user_id, client_toggle_id):
 *  a NULL id never conflicts, which is what keeps an op queued by an older
 *  app build writing exactly as it did before. */
function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      return {
        upsert: async (row: Record<string, unknown>, options?: UpsertOptions) => {
          if (table === 'workout_completions') state.upserted = row;
          if (table === 'workout_completion_log') {
            state.logOptions = options;
            const id = row.client_toggle_id;
            const duplicate = id != null && options?.ignoreDuplicates === true
              && state.log.some(r => r.user_id === row.user_id && r.client_toggle_id === id);
            if (!duplicate) {
              state.log.push(row);
              state.logged = row;
            }
          }
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
  state = { log: [] };
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
  client_toggle_id: '5f3a6f1c-8c2e-4a6b-9d3f-2b7c1e4a9d55',
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

describe('POST /api/completions — replay', () => {
  async function post(body: unknown) {
    const { res, statusCode } = makeRes();
    await handler(makeReq(body), res);
    return statusCode();
  }

  // The iOS tracker queues the .completion op durably and replays it until
  // the server ACKs, so the same payload arrives twice whenever a response is
  // lost. workout_completion_log is append-only, so the second one used to
  // land as a second audit row and double-count the workout.
  it('logs one row for two identical calls', async () => {
    expect(await post({ completionRow, logRow })).toBe(200);
    expect(await post({ completionRow, logRow })).toBe(200);
    expect(state.log).toHaveLength(1);
    expect(state.log[0]).toMatchObject({ user_id: 'user-123', event_id: 'evt-1', action: 'complete' });
    expect(state.logOptions).toEqual({
      onConflict: 'user_id,client_toggle_id',
      ignoreDuplicates: true,
    });
  });

  // …while genuinely toggling the same occurrence off and on again is three
  // separate toggles, three ids, and three rows of history.
  it('keeps every genuine toggle, including a second complete', async () => {
    await post({ completionRow, logRow });
    await post({
      completionRow: { ...completionRow, is_completed: false, completed_at: null },
      logRow: { ...logRow, action: 'uncomplete', client_toggle_id: '1d2c3b4a-5e6f-4071-8293-a4b5c6d7e8f9' },
    });
    await post({ completionRow, logRow: { ...logRow, client_toggle_id: '9a8b7c6d-5e4f-4321-8fed-cba987654321' } });
    expect(state.log.map(r => r.action)).toEqual(['complete', 'uncomplete', 'complete']);
  });

  // An op queued by a build from before the column sends no id: NULLs never
  // conflict, so it keeps the old at-least-once behaviour rather than being
  // silently collapsed into an unrelated row.
  it('does not dedupe rows without an id', async () => {
    const { client_toggle_id: _omitted, ...legacy } = logRow;
    expect(await post({ completionRow, logRow: legacy })).toBe(200);
    expect(await post({ completionRow, logRow: legacy })).toBe(200);
    expect(state.log).toHaveLength(2);
    expect(state.log[0]).not.toHaveProperty('client_toggle_id');
  });

  it('400s on a client_toggle_id that is not a UUID, and writes no log row', async () => {
    expect(await post({ completionRow, logRow: { ...logRow, client_toggle_id: "'; drop" } })).toBe(400);
    expect(state.log).toHaveLength(0);
  });
});
