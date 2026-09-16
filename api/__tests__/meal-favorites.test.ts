import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleMealFavorites as handler } from '../_lib/mealFavorites';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({
  enforceRateLimit: vi.fn(async () => true),
  enforceAiMutationCap: vi.fn(async () => true),
}));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  rows: Record<string, unknown>[];
  upserted?: Record<string, unknown>;
  deletedFilters?: string[];
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      if (table !== 'meal_favorites') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_c: string, userId: string) => ({
            order: async () => ({ data: state.rows.filter(r => r.user_id === userId), error: null }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => { state.upserted = row; return { error: null }; },
        delete: () => ({
          eq: (_c1: string, v1: string) => ({
            eq: async (_c2: string, v2: string) => { state.deletedFilters = [v1, v2]; return { error: null }; },
          }),
        }),
      };
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, opts: { query?: Record<string, string>; body?: unknown } = {}): VercelRequest {
  return { method, headers: {}, query: opts.query ?? {}, body: opts.body, cookies: {} } as unknown as VercelRequest;
}

function makeRes() {
  const captured: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  const res = {
    setHeader: () => res,
    status(code: number) { captured.statusCode = code; return res; },
    json(body: unknown) { captured.body = body; return res; },
    send(body: unknown) { captured.body = body; return res; },
    end: () => res,
  } as unknown as VercelResponse;
  return { res, captured };
}

const row = (id: string, title: string, userId = 'user-123') => ({
  id, user_id: userId, title, meal_type: 'breakfast', calories: 420, protein_g: 18, carbs_g: 60,
  fiber_g: null, sugar_g: null, fat_total_g: 12, fat_saturated_g: 2, fat_trans_g: null, alcohol_g: null,
  notes: '', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
});

let state: AdminState;
beforeEach(() => {
  state = { rows: [row('fav-1', 'Overnight oats'), row('fav-2', 'Chicken bowl'), row('fav-9', 'Theirs', 'user-999')] };
  mockedAdmin.mockReturnValue(makeAdmin(state));
  vi.mocked(enforceRateLimit).mockClear();
});

describe('GET /api/meal-favorites (W10)', () => {
  it('lists the caller\'s favorites as the app\'s camelCase shape, under the reads bucket', async () => {
    const { res, captured } = makeRes();
    await handler(makeReq('GET'), res);
    expect(captured.statusCode).toBe(200);
    const body = captured.body as { favorites: Array<Record<string, unknown>> };
    expect(body.favorites.map(f => f.id)).toEqual(['fav-1', 'fav-2']);
    expect(body.favorites[0]).toEqual({
      id: 'fav-1', title: 'Overnight oats', mealType: 'breakfast', calories: 420, proteinG: 18, carbsG: 60,
      fiberG: undefined, sugarG: undefined, fatTotalG: 12, fatSaturatedG: 2, fatTransG: undefined, alcoholG: undefined, notes: '',
    });
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'user-123', 'reads');
  });
});

describe('POST and DELETE /api/meal-favorites', () => {
  it('upserts within the caller\'s partition, under the writes bucket', async () => {
    const { res, captured } = makeRes();
    await handler(makeReq('POST', { body: { id: 'fav-3', title: 'Salad', carbs_g: 10 } }), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ id: 'fav-3' });
    expect(state.upserted).toMatchObject({ id: 'fav-3', title: 'Salad', user_id: 'user-123' });
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'user-123', 'writes');
  });

  it('deletes by id within the caller\'s partition', async () => {
    const { res, captured } = makeRes();
    await handler(makeReq('DELETE', { query: { id: 'fav-1' } }), res);
    expect(captured.statusCode).toBe(200);
    expect(state.deletedFilters).toEqual(['fav-1', 'user-123']);
  });
});
