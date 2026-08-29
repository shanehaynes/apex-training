import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/analyticsTiles';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  upserted?: Record<string, unknown>;
  updates: Array<{ row: Record<string, unknown>; filters: Record<string, unknown> }>;
  deleteFilters?: Record<string, unknown>;
  deleteCount: number;
}

// Minimal chainable fake covering exactly the query shapes the handler uses.
function makeAdmin(state: AdminState) {
  return {
    from() {
      return {
        upsert: async (row: Record<string, unknown>) => {
          state.upserted = row;
          return { error: null };
        },
        update: (row: Record<string, unknown>) => {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return chain;
            },
            then(resolve: (v: { error: null }) => void) {
              state.updates.push({ row, filters });
              resolve({ error: null });
            },
          };
          return chain;
        },
        delete: () => ({
          eq: (col: string, val: unknown) => ({
            eq: async (col2: string, val2: unknown) => {
              state.deleteFilters = { [col]: val, [col2]: val2 };
              return { error: null, count: state.deleteCount };
            },
          }),
        }),
      };
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, body?: unknown, query: Record<string, string> = {}): VercelRequest {
  return { method, headers: {}, body, query } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload };
}

const VALID_SPEC = {
  version: 1,
  title: 'Weekly mileage',
  chartType: 'line',
  range: { kind: 'rolling', days: 90 },
  bucket: 'week',
  series: [{ id: 's1', measure: 'distance' }],
};

function freshState(): AdminState {
  return { updates: [], deleteCount: 1 };
}

beforeEach(() => {
  mockedAdmin.mockReset();
});

describe('POST /api/analytics-tiles', () => {
  it('upserts a valid tile stamped with the verified user id', async () => {
    const state = freshState();
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { id: 'tile-abc', spec: VALID_SPEC, x: 0, y: 0, w: 6, h: 4 }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ id: 'tile-abc' });
    expect(state.upserted).toMatchObject({ id: 'tile-abc', user_id: 'user-123', w: 6 });
  });

  it('rejects a body that smuggles user_id or unknown columns', async () => {
    const state = freshState();
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { id: 'tile-abc', spec: VALID_SPEC, user_id: 'someone-else' }), res);
    expect(statusCode()).toBe(400);
    expect(state.upserted).toBeUndefined();
  });

  it('400s malformed specs before any write', async () => {
    for (const spec of [
      undefined,
      'not-an-object',
      { ...VALID_SPEC, version: 2 },
      { ...VALID_SPEC, title: '' },
      { ...VALID_SPEC, series: [] },
      { ...VALID_SPEC, series: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}` })) },
    ]) {
      const state = freshState();
      mockedAdmin.mockReturnValue(makeAdmin(state));
      const { res, statusCode } = makeRes();
      await handler(makeReq('POST', { id: 'tile-abc', spec }), res);
      expect(statusCode()).toBe(400);
      expect(state.upserted).toBeUndefined();
    }
  });

  it('400s layout values outside the grid bounds', async () => {
    for (const layout of [{ w: 0 }, { w: 13 }, { x: -1 }, { h: 2.5 }]) {
      const state = freshState();
      mockedAdmin.mockReturnValue(makeAdmin(state));
      const { res, statusCode } = makeRes();
      await handler(makeReq('POST', { id: 'tile-abc', spec: VALID_SPEC, ...layout }), res);
      expect(statusCode()).toBe(400);
      expect(state.upserted).toBeUndefined();
    }
  });
});

describe('PATCH /api/analytics-tiles — layout commits', () => {
  it('updates each moved tile scoped to the verified user', async () => {
    const state = freshState();
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', {
      layouts: [
        { id: 'tile-a', x: 0, y: 0, w: 6, h: 4 },
        { id: 'tile-b', x: 6, y: 0, w: 6, h: 4 },
      ],
    }), res);
    expect(statusCode()).toBe(200);
    expect(state.updates).toHaveLength(2);
    expect(state.updates[0].filters).toEqual({ user_id: 'user-123', id: 'tile-a' });
    expect(state.updates[0].row).toMatchObject({ x: 0, y: 0, w: 6, h: 4 });
    expect(state.updates[1].filters).toEqual({ user_id: 'user-123', id: 'tile-b' });
  });

  it('400s an incomplete or out-of-bounds layout entry before any write', async () => {
    for (const layouts of [
      [{ id: 'tile-a', x: 0, y: 0, w: 6 }],            // missing h
      [{ id: 'tile-a', x: 0, y: 0, w: 13, h: 4 }],     // w out of bounds
      [{ id: 'bad id!', x: 0, y: 0, w: 6, h: 4 }],     // invalid id
      'not-an-array',
      [],
    ]) {
      const state = freshState();
      mockedAdmin.mockReturnValue(makeAdmin(state));
      const { res, statusCode } = makeRes();
      await handler(makeReq('PATCH', { layouts }), res);
      expect(statusCode()).toBe(400);
      expect(state.updates).toHaveLength(0);
    }
  });
});

describe('DELETE /api/analytics-tiles', () => {
  it('deletes the tile scoped to the verified user', async () => {
    const state = freshState();
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('DELETE', undefined, { id: 'tile-abc' }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ id: 'tile-abc' });
    expect(state.deleteFilters).toEqual({ user_id: 'user-123', id: 'tile-abc' });
  });

  it("404s a tile that isn't in the user's partition", async () => {
    const state = freshState();
    state.deleteCount = 0;
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', undefined, { id: 'tile-forged' }), res);
    expect(statusCode()).toBe(404);
  });
});

describe('method handling', () => {
  it('405s GET — reads go straight to Supabase under RLS', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(freshState()));
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(405);
  });
});
