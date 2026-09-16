import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleMeals as handler } from '../_lib/meals';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceAiMutationCap } from '../_lib/rateLimit';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({
  enforceRateLimit: vi.fn(async () => true),
  enforceAiMutationCap: vi.fn(async () => true),
}));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

// The meals door: what the composer refuses, the server refuses with the
// same words (W10 — the native composer shows the server's sentence
// inline). The fake answers the insert, the update, the fat-split
// pre-read and the audit log, and records what it was asked to write.
interface AdminState {
  current?: Record<string, unknown> | null;
  inserted?: Record<string, unknown>;
  updated?: Record<string, unknown>;
  logged?: Record<string, unknown>;
  reads: number;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      if (table === 'meal_mutations_log') {
        return { insert: async (row: Record<string, unknown>) => { state.logged = row; return { error: null }; } };
      }
      if (table !== 'meals') throw new Error(`unexpected table ${table}`);
      return {
        insert: async (row: Record<string, unknown>) => { state.inserted = row; return { error: null }; },
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => { state.reads += 1; return { data: state.current ?? null, error: null }; },
            }),
          }),
        }),
        update: (row: Record<string, unknown>) => ({
          eq: () => ({
            eq: async () => { state.updated = row; return { error: null }; },
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

const meal = { id: 'meal-1', title: 'Oats', date: '2026-09-08', protein_g: 22, carbs_g: 78, fat_total_g: 12 };

let state: AdminState;
beforeEach(() => {
  state = { reads: 0 };
  mockedAdmin.mockReturnValue(makeAdmin(state));
  vi.mocked(enforceAiMutationCap).mockClear();
});

describe('POST /api/meals', () => {
  it('refuses a negative or non-numeric macro with the composer\'s sentence', async () => {
    for (const [patch, message] of [
      [{ protein_g: -5 }, 'Protein must be a number of at least 0'],
      [{ fat_trans_g: 'zero' }, 'Trans fat must be a number of at least 0'],
      [{ calories: Number.NaN }, 'Calories must be a number of at least 0'],
    ] as const) {
      const { res, captured } = makeRes();
      await handler(makeReq('POST', { body: { ...meal, ...patch, triggered_by: 'user' } }), res);
      expect(captured.statusCode).toBe(400);
      expect(captured.body).toBe(message);
    }
    expect(state.inserted).toBeUndefined();
  });

  it('refuses a fat total below saturated + trans, and lets a blank total through', async () => {
    const bad = makeRes();
    await handler(makeReq('POST', { body: { ...meal, fat_total_g: 5, fat_saturated_g: 4, fat_trans_g: 2, triggered_by: 'user' } }), bad.res);
    expect(bad.captured.statusCode).toBe(400);
    expect(bad.captured.body).toBe("Total fat can't be less than saturated + trans");
    expect(state.inserted).toBeUndefined();

    const blank = makeRes();
    await handler(makeReq('POST', { body: { ...meal, fat_total_g: null, fat_saturated_g: 4, fat_trans_g: 2, triggered_by: 'user' } }), blank.res);
    expect(blank.captured.statusCode).toBe(200);
    expect(blank.captured.body).toEqual({ id: 'meal-1' });
  });

  it('inserts a good meal with user attribution and skips the AI cap', async () => {
    const { res, captured } = makeRes();
    await handler(makeReq('POST', { body: { ...meal, fat_saturated_g: 4, fat_trans_g: 0, triggered_by: 'user' } }), res);
    expect(captured.statusCode).toBe(200);
    expect(state.inserted).toMatchObject({ id: 'meal-1', title: 'Oats', user_id: 'user-123', fat_saturated_g: 4 });
    expect(state.logged).toMatchObject({ operation: 'create', meal_id: 'meal-1', meal_title: 'Oats', triggered_by: 'user' });
    expect(enforceAiMutationCap).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/meals?id=', () => {
  const log = { meal_title: 'Oats', triggered_by: 'user' as const };

  it('judges the fat split as it will exist after the merge', async () => {
    state.current = { fat_total_g: 12, fat_saturated_g: 4, fat_trans_g: 0 };
    const { res, captured } = makeRes();
    // Raising saturated past the stored total is the refusal; the total was not sent.
    await handler(makeReq('PATCH', { query: { id: 'meal-1' }, body: { fields: { fat_saturated_g: 13 }, log } }), res);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toBe("Total fat can't be less than saturated + trans");
    expect(state.updated).toBeUndefined();

    const ok = makeRes();
    await handler(makeReq('PATCH', { query: { id: 'meal-1' }, body: { fields: { fat_saturated_g: 10, fat_trans_g: 2 }, log } }), ok.res);
    expect(ok.captured.statusCode).toBe(200);
    expect(state.updated).toMatchObject({ fat_saturated_g: 10, fat_trans_g: 2 });
  });

  it('404s a fat edit to a meal the caller does not own', async () => {
    state.current = null;
    const { res, captured } = makeRes();
    await handler(makeReq('PATCH', { query: { id: 'meal-9' }, body: { fields: { fat_total_g: 20 }, log } }), res);
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toBe('Meal not found');
  });

  it('skips the pre-read when no fat column is touched, and still refuses a negative macro', async () => {
    const title = makeRes();
    await handler(makeReq('PATCH', { query: { id: 'meal-1' }, body: { fields: { title: 'Overnight oats', protein_g: 25 }, log } }), title.res);
    expect(title.captured.statusCode).toBe(200);
    expect(state.reads).toBe(0);
    expect(state.updated).toMatchObject({ title: 'Overnight oats', protein_g: 25 });
    expect(state.logged).toMatchObject({ operation: 'update', meal_id: 'meal-1', triggered_by: 'user' });

    const negative = makeRes();
    await handler(makeReq('PATCH', { query: { id: 'meal-1' }, body: { fields: { carbs_g: -1 }, log } }), negative.res);
    expect(negative.captured.statusCode).toBe(400);
    expect(negative.captured.body).toBe('Carbs must be a number of at least 0');
  });
});
