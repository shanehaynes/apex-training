import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/workoutTemplates';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  upserted?: Record<string, unknown>;
  upsertOptions?: Record<string, unknown>;
  updated?: Record<string, unknown>;
  /** Rows the archive update matched (0 → 404). */
  count: number;
}

function makeAdmin(state: AdminState) {
  return {
    from() {
      return {
        upsert: async (row: Record<string, unknown>, options: Record<string, unknown>) => {
          state.upserted = row;
          state.upsertOptions = options;
          return { error: null };
        },
        update: (row: Record<string, unknown>) => ({
          eq: () => ({
            eq: async () => {
              if (state.count > 0) state.updated = row;
              return { error: null, count: state.count };
            },
          }),
        }),
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
  state = { count: 1 };
  mockedAdmin.mockReturnValue(makeAdmin(state));
});

const base = { id: 'wt-1', title: 'Push Day', type: 'weights' };

describe('POST /api/workout-templates — upsert', () => {
  it('400s on missing identity fields, a bad id, or a blank title', async () => {
    for (const body of [{ title: 'x', type: 'weights' }, { ...base, id: 'bad id' }, { ...base, title: '  ' }, { id: 'wt-1', title: 'x' }]) {
      const { res, statusCode } = makeRes();
      await handler(makeReq('POST', body), res);
      expect(statusCode(), JSON.stringify(body)).toBe(400);
    }
    expect(state.upserted).toBeUndefined();
  });

  it('rejects an unknown column loudly and upserts nothing', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { ...base, user_id: 'someone-else' }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('user_id');
    expect(state.upserted).toBeUndefined();
  });

  it('upserts on (user_id, id) with the verified user and a fresh updated_at', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { ...base, tags: ['push'] }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ id: 'wt-1' });
    expect(state.upserted).toMatchObject({ ...base, tags: ['push'], user_id: 'user-123' });
    expect(typeof state.upserted!.updated_at).toBe('string');
    expect(state.upsertOptions).toEqual({ onConflict: 'user_id,id' });
  });

  it('re-letters supersets on the way in (a native client need not normalise)', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', {
      ...base,
      exercises: [
        { id: 'a', name: 'Squat', category: 'strength', superset: 'X' },
        { id: 'b', name: 'Pull-up', category: 'strength', superset: 'X' },
        { id: 'c', name: 'Plank', category: 'strength', superset: 'Z' },
      ],
    }), res);
    expect(statusCode()).toBe(200);
    expect((state.upserted!.exercises as Array<{ superset?: string }>).map(e => e.superset)).toEqual(['A', 'A', undefined]);
  });
});

describe('PATCH /api/workout-templates — archive toggle', () => {
  it('400s without an id or with a non-timestamp archived_at', async () => {
    let r = makeRes();
    await handler(makeReq('PATCH', { archived_at: null }), r.res);
    expect(r.statusCode()).toBe(400);
    r = makeRes();
    await handler(makeReq('PATCH', { archived_at: 5 }, { id: 'wt-1' }), r.res);
    expect(r.statusCode()).toBe(400);
    expect(state.updated).toBeUndefined();
  });

  it('archives and restores through the service', async () => {
    let r = makeRes();
    await handler(makeReq('PATCH', { archived_at: '2026-09-08T00:00:00Z' }, { id: 'wt-1' }), r.res);
    expect(r.statusCode()).toBe(200);
    expect(state.updated).toMatchObject({ archived_at: '2026-09-08T00:00:00Z' });
    r = makeRes();
    await handler(makeReq('PATCH', { archived_at: null }, { id: 'wt-1' }), r.res);
    expect(state.updated).toMatchObject({ archived_at: null });
  });

  it("404s on someone else's (or a mistyped) id", async () => {
    state.count = 0;
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { archived_at: null }, { id: 'wt-9' }), res);
    expect(statusCode()).toBe(404);
  });
});
