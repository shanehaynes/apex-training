import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../events';
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
}

function makeAdmin(state: AdminState) {
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
            eq: async () => {
              state.updated = row;
              return { error: null };
            },
          }),
        }),
        delete: () => ({
          eq: () => ({ eq: async () => ({ error: null }) }),
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
  state = {};
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
});
