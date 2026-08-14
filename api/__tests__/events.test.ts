import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/events';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({
  enforceRateLimit: vi.fn(async () => true),
  enforceAiMutationCap: vi.fn(async () => true),
}));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  inserted?: Record<string, unknown>;
  updated?: Record<string, unknown>;
  logged?: Record<string, unknown>;
  /** Simulate the target row not existing (0-row update/delete). */
  missing?: boolean;
  /** Shape of the row the delete returns — drives the tracked-data purge. */
  isRecurring?: boolean;
  /** Tables the delete purged, and the ids it matched on. */
  purged: { table: string; eventIds: string[] }[];
}

function makeAdmin(state: AdminState) {
  const affected = () => ({
    data: state.missing ? [] : [{ id: 'evt-1', is_recurring: state.isRecurring ?? false }],
    error: null,
  });
  return {
    from(table: string) {
      return {
        insert: async (row: Record<string, unknown>) => {
          if (table === 'workout_events') state.inserted = row;
          if (table === 'event_mutations_log') state.logged = row;
          return { error: null };
        },
        update: (row: Record<string, unknown>) => ({
          eq: () => ({
            eq: () => ({
              select: async () => {
                if (!state.missing) state.updated = row;
                return affected();
              },
            }),
          }),
        }),
        // One node for both delete shapes: the event delete filters by
        // id + user_id then selects; the tracked-data purge filters by
        // user_id then matches event_id with .in().
        delete: () => {
          const node = {
            eq: () => node,
            in: async (_column: string, eventIds: string[]) => {
              state.purged.push({ table, eventIds });
              return { error: null };
            },
            select: async () => affected(),
          };
          return node;
        },
      };
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, body?: unknown, query?: Record<string, string>): VercelRequest {
  return { method, headers: {}, body, query: query ?? {} } as unknown as VercelRequest;
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
  state = { purged: [] };
  mockedAdmin.mockReturnValue(makeAdmin(state));
});

describe('POST /api/events — field allowlist', () => {
  const base = { id: 'evt-1', type: 'strength', title: 'Bench', date: '2026-07-24' };

  it('400s on a smuggled column, naming it, and inserts nothing', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { ...base, is_template_source: true }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('is_template_source');
    expect(state.inserted).toBeUndefined();
  });

  it('rejects user_id in the body rather than trusting it', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { ...base, user_id: 'someone-else' }), res);
    expect(statusCode()).toBe(400);
    expect(state.inserted).toBeUndefined();
  });

  it('inserts exactly the allowed fields plus the verified user_id', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { ...base, triggered_by: 'user' }), res);
    expect(statusCode()).toBe(200);
    expect(state.inserted).toEqual({ ...base, user_id: 'user-123' });
    expect(state.logged).toMatchObject({ triggered_by: 'user', operation: 'create' });
  });

  it('treats an invalid triggered_by as unlabeled instead of logging it', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { ...base, triggered_by: 'admin' }), res);
    expect(statusCode()).toBe(200);
    expect(state.logged).not.toHaveProperty('triggered_by');
  });

  it('rejects an id that could inject ICS lines into the calendar feed', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { ...base, id: 'evil\r\nATTENDEE:mailto:x@y.z' }), res);
    expect(statusCode()).toBe(400);
    expect(state.inserted).toBeUndefined();
  });

  it('rejects an oversized id', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { ...base, id: 'a'.repeat(200) }), res);
    expect(statusCode()).toBe(400);
    expect(state.inserted).toBeUndefined();
  });
});

describe('PATCH /api/events — field allowlist', () => {
  const log = { event_title: 'Bench', triggered_by: 'user' };

  it('400s on a smuggled patch column and updates nothing', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(
      makeReq('PATCH', { fields: { title: 'x', ics_token: 'steal' }, log }, { id: 'evt-1' }),
      res,
    );
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('ics_token');
    expect(state.updated).toBeUndefined();
  });

  it('rejects id/user_id as patch fields', async () => {
    const { res, statusCode } = makeRes();
    await handler(
      makeReq('PATCH', { fields: { id: 'other', user_id: 'someone-else' }, log }, { id: 'evt-1' }),
      res,
    );
    expect(statusCode()).toBe(400);
    expect(state.updated).toBeUndefined();
  });

  it('applies a clean patch', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { fields: { title: 'Incline Bench' }, log }, { id: 'evt-1' }), res);
    expect(statusCode()).toBe(200);
    expect(state.updated).toMatchObject({ title: 'Incline Bench' });
    expect(state.updated).toHaveProperty('updated_at');
  });

  it("404s on someone else's (or a mistyped) id without writing an audit entry", async () => {
    state.missing = true;
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { fields: { title: 'x' }, log }, { id: 'not-mine' }), res);
    expect(statusCode()).toBe(404);
    expect(state.logged).toBeUndefined();
  });
});

describe('DELETE /api/events — existence check', () => {
  it('404s on a 0-row delete without writing an audit entry', async () => {
    state.missing = true;
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { log: { event_title: 'x', triggered_by: 'user' } }, { id: 'not-mine' }), res);
    expect(statusCode()).toBe(404);
    expect(state.logged).toBeUndefined();
  });

  it('deletes and logs when the row exists', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { log: { event_title: 'Bench', triggered_by: 'user' } }, { id: 'evt-1' }), res);
    expect(statusCode()).toBe(200);
    expect(state.logged).toMatchObject({ operation: 'delete' });
  });

  it('purges what a one-off workout logged — sets, cardio, session, completion', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { log: { event_title: 'Bench', triggered_by: 'user' } }, { id: 'evt-1' }), res);
    expect(statusCode()).toBe(200);
    expect(state.purged.map(p => p.table).sort()).toEqual([
      'activity_streams',
      'workout_cardio_logs',
      'workout_completions',
      'workout_sessions',
      'workout_set_logs',
    ]);
    // Exact ids only: `_` is a LIKE wildcard and event ids may contain one,
    // so a prefix match could reach a neighbouring event's rows.
    expect(state.purged.every(p => p.eventIds.length === 1 && p.eventIds[0] === 'evt-1')).toBe(true);
  });

  it('keeps logged history when a whole recurring series is deleted', async () => {
    state.isRecurring = true;
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { log: { event_title: 'Weekly squat', triggered_by: 'user' } }, { id: 'evt-1' }), res);
    expect(statusCode()).toBe(200);
    expect(state.purged, 'past sessions of a series really happened').toEqual([]);
  });

  it('purges nothing when the event was not the caller’s to delete', async () => {
    state.missing = true;
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { log: { event_title: 'x', triggered_by: 'user' } }, { id: 'not-mine' }), res);
    expect(statusCode()).toBe(404);
    expect(state.purged).toEqual([]);
  });
});
