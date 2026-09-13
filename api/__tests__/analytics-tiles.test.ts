import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/analyticsTiles';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';
import { draftFromSpec, emptyChartDraft, specFromDraft, type ChartDraft } from '../../src/lib/analytics/draft';
import type { ChartSpec } from '../../src/lib/analytics/spec';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  /** Rows a select() answers, keyed by table. */
  rows: Record<string, unknown[]>;
  /** Filters the select chains applied, keyed by table. */
  selectFilters: Record<string, Record<string, unknown>>;
  upserted?: Record<string, unknown>;
  updates: Array<{ row: Record<string, unknown>; filters: Record<string, unknown> }>;
  deleteFilters?: Record<string, unknown>;
  deleteCount: number;
}

// Minimal chainable fake covering exactly the query shapes the handler uses.
function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      return {
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(col: string, val: unknown) { filters[col] = val; return chain; },
            order() { return chain; },
            then(resolve: (v: { data: unknown[]; error: null }) => void) {
              state.selectFilters[table] = filters;
              resolve({ data: state.rows[table] ?? [], error: null });
            },
          };
          return chain;
        },
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

/** A draft the web would save: the mileage tile as the builder holds it. */
function validDraft(): ChartDraft {
  const draft = emptyChartDraft();
  draft.title = 'Weekly mileage';
  draft.series[0].measure = 'distance';
  return draft;
}

function freshState(): AdminState {
  return { rows: {}, selectFilters: {}, updates: [], deleteCount: 1 };
}

beforeEach(() => {
  mockedAdmin.mockReset();
  vi.mocked(enforceRateLimit).mockClear();
});

describe('GET /api/analytics-tiles (W9 — the native dashboard read)', () => {
  it('lists the caller\'s tiles in y,x order with the draft each spec unfolds to, plus the picker options', async () => {
    const state = freshState();
    state.rows.analytics_tiles = [
      { id: 'tile-a', user_id: 'user-123', spec: VALID_SPEC, x: 0, y: 0, w: 6, h: 4, created_at: 'c', updated_at: '2026-09-11T10:00:00Z' },
      { id: 'tile-b', user_id: 'user-123', spec: { version: 1, title: 'Old tile', series: [] }, x: 0, y: 4, w: 12, h: 2, created_at: 'c', updated_at: null },
    ];
    state.rows.exercise_definitions = [{ category: 'strength' }, { category: 'cardio' }, { category: 'strength' }, { category: null }];
    state.rows.workout_events = [{ title: ' Soccer night ' }, { title: 'Soccer night' }, { title: '' }];
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    const out = body() as { tiles: Array<Record<string, unknown>>; options: unknown };
    expect(out.tiles).toHaveLength(2);
    expect(out.tiles[0]).toEqual({
      id: 'tile-a', title: 'Weekly mileage', spec: VALID_SPEC, draft: draftFromSpec(VALID_SPEC as ChartSpec),
      layout: { x: 0, y: 0, w: 6, h: 4 }, updatedAt: '2026-09-11T10:00:00Z',
    });
    // A stored spec that no longer validates keeps its title and carries no draft.
    expect(out.tiles[1]).toEqual({ id: 'tile-b', title: 'Old tile', spec: null, draft: null, layout: { x: 0, y: 4, w: 12, h: 2 }, updatedAt: null });
    expect(out.options).toEqual({ categories: ['cardio', 'strength'], otherWorkoutTitles: ['Soccer night'] });
    // Never another user's rows, never a user_id in the response.
    expect(state.selectFilters.analytics_tiles).toEqual({ user_id: 'user-123' });
    expect(state.selectFilters.workout_events).toEqual({ user_id: 'user-123', sport: 'other' });
    expect(JSON.stringify(out)).not.toContain('user_id');
  });

  it('charges the reads bucket for GET and writes for every mutation', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(freshState()));
    await handler(makeReq('GET'), makeRes().res);
    expect(vi.mocked(enforceRateLimit).mock.calls.at(-1)![3]).toBe('reads');
    await handler(makeReq('POST', { id: 'tile-abc', spec: VALID_SPEC }), makeRes().res);
    expect(vi.mocked(enforceRateLimit).mock.calls.at(-1)![3]).toBe('writes');
    await handler(makeReq('DELETE', undefined, { id: 'tile-abc' }), makeRes().res);
    expect(vi.mocked(enforceRateLimit).mock.calls.at(-1)![3]).toBe('writes');
  });
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

describe('POST /api/analytics-tiles { draft } (W9 — the native builder\'s Save)', () => {
  it('converts the draft with the web\'s own specFromDraft, upserts the row and answers the saved tile', async () => {
    const state = freshState();
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    const draft = validDraft();
    await handler(makeReq('POST', { id: 'tile-abc', draft, layout: { x: 0, y: 8, w: 12, h: 4 } }), res);
    expect(statusCode()).toBe(200);
    const spec = (specFromDraft(draft) as { spec: ChartSpec }).spec;
    expect(state.upserted).toEqual({
      id: 'tile-abc', spec, x: 0, y: 8, w: 12, h: 4, user_id: 'user-123', updated_at: expect.any(String),
    });
    expect(body()).toEqual({
      ok: true, id: 'tile-abc',
      tile: { id: 'tile-abc', title: 'Weekly mileage', spec, draft: draftFromSpec(spec), layout: { x: 0, y: 8, w: 12, h: 4 }, updatedAt: expect.any(String) },
    });
  });

  it('defaults the layout when none is sent and fills a partial one', async () => {
    const state = freshState();
    mockedAdmin.mockReturnValue(makeAdmin(state));
    await handler(makeReq('POST', { id: 'tile-abc', draft: validDraft() }), makeRes().res);
    expect(state.upserted).toMatchObject({ x: 0, y: 0, w: 6, h: 4 });
    await handler(makeReq('POST', { id: 'tile-abc', draft: validDraft(), layout: { h: 6 } }), makeRes().res);
    expect(state.upserted).toMatchObject({ x: 0, y: 0, w: 6, h: 6 });
  });

  it('answers 200 ok:false with the web\'s pre-save text for a blank title, writing nothing', async () => {
    const state = freshState();
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    const draft = validDraft();
    draft.title = '   ';
    await handler(makeReq('POST', { id: 'tile-abc', draft }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ ok: false, problem: 'Give the tile a title' });
    expect(state.upserted).toBeUndefined();
  });

  it('answers 200 ok:false with chartDraftProblem\'s text when the draft would not build', async () => {
    const state = freshState();
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    const draft = validDraft();
    draft.series[0].measure = 'max-grade';   // needs a grade scale
    await handler(makeReq('POST', { id: 'tile-abc', draft }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ ok: false, problem: 'Max grade needs a grade scale — grades only order within one scale.' });
    expect(state.upserted).toBeUndefined();
  });

  it('400s a draft that is not an object, a bad layout, a non-draft shape, or a body carrying both spec and draft', async () => {
    for (const body of [
      { id: 'tile-abc', draft: 'nope' },
      { id: 'tile-abc', draft: validDraft(), layout: { w: 13 } },
      { id: 'tile-abc', draft: validDraft(), layout: 'wide' },
      { id: 'tile-abc', draft: { title: 'No series here' } },
      { id: 'tile-abc', draft: validDraft(), spec: VALID_SPEC },
      { id: 'bad id!', draft: validDraft() },
    ]) {
      const state = freshState();
      mockedAdmin.mockReturnValue(makeAdmin(state));
      const { res, statusCode } = makeRes();
      await handler(makeReq('POST', body), res);
      expect(statusCode(), JSON.stringify(body).slice(0, 60)).toBe(400);
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
  it('405s PUT before touching auth or the limiter', async () => {
    mockedAdmin.mockReturnValue(makeAdmin(freshState()));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PUT'), res);
    expect(statusCode()).toBe(405);
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });
});
