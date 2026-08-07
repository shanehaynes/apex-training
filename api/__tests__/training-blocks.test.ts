import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleTrainingBlocks as handler } from '../_lib/trainingBlocks';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { requireUser } from '../_lib/auth';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({
  enforceRateLimit: vi.fn(async () => true),
  enforceAiMutationCap: vi.fn(async () => true),
}));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedRequireUser = vi.mocked(requireUser);

interface PgError { code?: string; message: string }

interface AdminState {
  inserted?: Record<string, unknown>;
  /** Rows from a ?batch=1 multi-row insert. */
  insertedBatch?: Record<string, unknown>[];
  updated?: Record<string, unknown>;
  logged?: Record<string, unknown>;
  /** Every mutation-log row, in order — a batch writes one per block. */
  loggedAll?: Record<string, unknown>[];
  deletedFilters?: string[];
  updatedFilters?: string[];
  insertError?: PgError;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      return {
        insert: (row: Record<string, unknown> | Record<string, unknown>[]) => {
          if (table === 'block_mutations_log') {
            state.logged = row as Record<string, unknown>;
            (state.loggedAll ??= []).push(row as Record<string, unknown>);
            return Promise.resolve({ error: null });
          }
          // A batch insert passes an array and awaits .select() directly; a
          // single insert passes an object and chains .single().
          if (Array.isArray(row)) {
            state.insertedBatch = row;
            const result = state.insertError
              ? { data: null, error: state.insertError }
              : { data: row.map((_, i) => ({ id: `blk-${i + 1}` })), error: null };
            return { select: async () => result };
          }
          state.inserted = row;
          return {
            select: () => ({
              single: async () =>
                state.insertError
                  ? { data: null, error: state.insertError }
                  : { data: { id: 'blk-generated' }, error: null },
            }),
          };
        },
        update: (row: Record<string, unknown>) => ({
          eq: (_c1: string, v1: string) => ({
            eq: async (_c2: string, v2: string) => {
              state.updated = row;
              state.updatedFilters = [v1, v2];
              return { error: null };
            },
          }),
        }),
        delete: () => ({
          eq: (_c1: string, v1: string) => ({
            eq: async (_c2: string, v2: string) => {
              state.deletedFilters = [v1, v2];
              return { error: null };
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

const validBlock = {
  name: 'Fall Aerobic Foundation',
  intent: 'Build the base',
  phase: 'base',
  start_date: '2026-03-02',
  end_date_exclusive: '2026-04-27',
  weekly_targets: { cardioMinutes: 420 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockImplementation(async () => 'user-123');
});

describe('POST', () => {
  it('stamps user_id from the verified JWT and returns the generated id', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();

    await handler(makeReq('POST', { ...validBlock, triggered_by: 'user' }), res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ id: 'blk-generated' });
    expect(state.inserted).toMatchObject({ ...validBlock, user_id: 'user-123' });
    expect(state.logged).toMatchObject({
      user_id: 'user-123',
      operation: 'create',
      resource: 'block',
      resource_id: 'blk-generated',
      triggered_by: 'user',
    });
  });

  // The tenancy guard: the service-role client bypasses RLS, so a body-supplied
  // user_id must never reach the insert.
  it('rejects a body-supplied user_id instead of honouring it', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();

    await handler(makeReq('POST', { ...validBlock, user_id: 'someone-else' }), res);

    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('user_id');
    expect(state.inserted).toBeUndefined();
  });

  it('rejects unknown columns', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode, body } = makeRes();

    await handler(makeReq('POST', { ...validBlock, sneaky: 1 }), res);

    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('sneaky');
  });

  // pickAllowed guards column names; it cannot see inside a JSONB value.
  it('rejects a malformed weekly_targets bag', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode, body } = makeRes();

    await handler(makeReq('POST', { ...validBlock, weekly_targets: { cardioMins: 300 } }), res);

    expect(statusCode()).toBe(400);
    expect(String(body())).toMatch(/Unknown weekly target/);
  });

  it('requires a name', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { ...validBlock, name: '   ' }), res);
    expect(statusCode()).toBe(400);
  });

  // A user-correctable conflict must not surface as a 500.
  it('maps the overlap exclusion violation (23P01) to 409', async () => {
    mockedAdmin.mockReturnValue(
      makeAdmin({ insertError: { code: '23P01', message: 'conflicting key value' } }),
    );
    const { res, statusCode, body } = makeRes();

    await handler(makeReq('POST', validBlock), res);

    expect(statusCode()).toBe(409);
    expect(String(body())).toMatch(/overlaps an existing block/);
  });

  it('maps a CHECK violation (23514) to 400', async () => {
    mockedAdmin.mockReturnValue(
      makeAdmin({ insertError: { code: '23514', message: 'training_blocks_mon_start' } }),
    );
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', validBlock), res);
    expect(statusCode()).toBe(400);
  });

  it('still 500s on an unrecognised database error', async () => {
    mockedAdmin.mockReturnValue(
      makeAdmin({ insertError: { code: '08006', message: 'connection failure' } }),
    );
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', validBlock), res);
    expect(statusCode()).toBe(500);
  });

  it('routes ?resource=objective to the objectives allowlist', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();

    await handler(
      makeReq('POST', { name: 'Liberty Ridge', target_date: '2027-06-15', discipline: 'alpine' }, { resource: 'objective' }),
      res,
    );

    expect(statusCode()).toBe(200);
    expect(state.inserted).toMatchObject({ name: 'Liberty Ridge', discipline: 'alpine', user_id: 'user-123' });
    expect(state.logged).toMatchObject({ resource: 'objective' });
  });

  it('rejects block columns sent to the objective resource', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { name: 'X', weekly_targets: {} }, { resource: 'objective' }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('weekly_targets');
  });
});

describe('PATCH and DELETE', () => {
  it('filters on both id and user_id', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();

    await handler(
      makeReq('PATCH', { fields: { name: 'Renamed' }, log: { resource_name: 'Renamed', triggered_by: 'user' } }, { id: 'blk-1' }),
      res,
    );

    expect(statusCode()).toBe(200);
    expect(state.updatedFilters).toEqual(['blk-1', 'user-123']);
    expect(state.updated).toMatchObject({ name: 'Renamed' });
  });

  it('deletes scoped to the caller', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();

    await handler(makeReq('DELETE', { log: { resource_name: 'Fall Base' } }, { id: 'blk-1' }), res);

    expect(statusCode()).toBe(200);
    expect(state.deletedFilters).toEqual(['blk-1', 'user-123']);
    expect(state.logged).toMatchObject({ operation: 'delete', resource_id: 'blk-1' });
  });

  it('requires an id', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { fields: {}, log: { resource_name: 'x' } }), res);
    expect(statusCode()).toBe(400);
  });

  it('rejects unknown columns on PATCH', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode, body } = makeRes();
    await handler(
      makeReq('PATCH', { fields: { user_id: 'x' }, log: { resource_name: 'x' } }, { id: 'blk-1' }),
      res,
    );
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('user_id');
  });
});

describe('auth and method guards', () => {
  it('does not touch the database when the JWT is missing', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    mockedRequireUser.mockImplementation(async () => null);
    const { res } = makeRes();

    await handler(makeReq('POST', validBlock), res);

    expect(state.inserted).toBeUndefined();
  });

  it('405s on an unsupported method', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PUT', {}, { id: 'blk-1' }), res);
    expect(statusCode()).toBe(405);
  });

  it('500s when the admin client is unconfigured', async () => {
    mockedAdmin.mockReturnValue(null as never);
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', validBlock), res);
    expect(statusCode()).toBe(500);
  });
});

// ── Batch insert (?batch=1) ──────────────────────────────────────────────────
// A training cycle is several blocks that only make sense together. The batch
// path exists so the non-overlap exclusion constraint can reject the whole set
// atomically instead of stranding the ones that already landed.

describe('POST ?batch=1', () => {
  const cycleRows = [
    { ...validBlock, name: 'Spring · Build 1', start_date: '2026-03-02', end_date_exclusive: '2026-03-23' },
    { ...validBlock, name: 'Spring · Recovery 1', start_date: '2026-03-23', end_date_exclusive: '2026-03-30' },
  ];

  it('inserts every row in one statement and stamps user_id on each', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();

    await handler(
      makeReq('POST', { rows: cycleRows, log: { resource_name: 'Spring', triggered_by: 'user' } }, { batch: '1' }),
      res,
    );

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ ids: ['blk-1', 'blk-2'] });
    expect(state.insertedBatch).toHaveLength(2);
    expect(state.insertedBatch!.every(r => r.user_id === 'user-123')).toBe(true);
    // The single-row path must not have run.
    expect(state.inserted).toBeUndefined();
  });

  it('writes one mutation-log row per created block', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res } = makeRes();

    await handler(
      makeReq('POST', { rows: cycleRows, log: { resource_name: 'Spring', triggered_by: 'user' } }, { batch: '1' }),
      res,
    );

    expect(state.loggedAll).toHaveLength(2);
    expect(state.loggedAll!.map(r => r.resource_name)).toEqual(['Spring · Build 1', 'Spring · Recovery 1']);
    expect(state.loggedAll!.every(r => r.operation === 'create' && r.triggered_by === 'user')).toBe(true);
  });

  it('turns an overlap (23P01) into a 409, not a 500', async () => {
    const state: AdminState = { insertError: { code: '23P01', message: 'conflicting key value' } };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();

    await handler(makeReq('POST', { rows: cycleRows }, { batch: '1' }), res);

    expect(statusCode()).toBe(409);
    expect(String(body())).toContain('overlaps');
    expect(state.loggedAll).toBeUndefined();
  });

  it('rejects unknown columns, naming the offending row', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();

    await handler(
      makeReq('POST', { rows: [cycleRows[0], { ...cycleRows[1], sneaky: 1 }] }, { batch: '1' }),
      res,
    );

    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('Row 2');
    expect(String(body())).toContain('sneaky');
    expect(state.insertedBatch).toBeUndefined();
  });

  it('rejects a body-supplied user_id', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();

    await handler(
      makeReq('POST', { rows: [{ ...cycleRows[0], user_id: 'someone-else' }] }, { batch: '1' }),
      res,
    );

    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('user_id');
    expect(state.insertedBatch).toBeUndefined();
  });

  it('rejects a row with no name', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode, body } = makeRes();

    await handler(makeReq('POST', { rows: [{ ...cycleRows[0], name: '  ' }] }, { batch: '1' }), res);

    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('Row 1');
  });

  it('rejects malformed weekly_targets inside a row', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode } = makeRes();

    await handler(
      makeReq('POST', { rows: [{ ...cycleRows[0], weekly_targets: { cardioMinutes: -5 } }] }, { batch: '1' }),
      res,
    );

    expect(statusCode()).toBe(400);
  });

  it('rejects an empty batch', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({}));
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { rows: [] }, { batch: '1' }), res);
    expect(statusCode()).toBe(400);
  });

  it('caps the batch size', async () => {
    const state: AdminState = {};
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();

    await handler(
      makeReq('POST', { rows: Array.from({ length: 25 }, () => cycleRows[0]) }, { batch: '1' }),
      res,
    );

    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('24');
    expect(state.insertedBatch).toBeUndefined();
  });
});
