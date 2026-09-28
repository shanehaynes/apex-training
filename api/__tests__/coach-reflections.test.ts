import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { LIST_LIMIT } from '../_lib/handlers/coachReflections';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';
import { applyContractEdit } from '../_lib/reflection/contract';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('../_lib/reflection/contract.js', () => ({ applyContractEdit: vi.fn() }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedLimit = vi.mocked(enforceRateLimit);
const mockedApply = vi.mocked(applyContractEdit);

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-8888-4777-8666-555555555555';

const DONE = {
  id: ID,
  user_id: 'user-123',
  day: '2026-09-27',
  status: 'done',
  batch_id: null,
  contract_before: 'Push me on volume.',
  contract_after: 'Push me on volume.\n\nLeave nutrition alone unless I ask.',
  reason: 'You asked twice.',
  memory_proposal_ids: [],
  error: null,
  created_at: '2026-09-28T05:00:00Z',
  completed_at: '2026-09-28T05:00:10Z',
  resolved_at: null,
  resolution: null,
};

// ── A fake service-role client that records what the handler asked for ───────
//
// The coach-annotations posture: no query leaves this handler without
// .eq('user_id', <the JWT's user>), and the fake records each chain's table,
// operation, filters, order and payload so a missing scope is a failing test.

interface Call {
  table: string;
  op: 'select' | 'update';
  filters: Record<string, unknown>;
  orders: Array<[string, unknown]>;
  limit?: number;
  payload?: unknown;
}

type Result = { data: unknown; error: { message: string } | null };

let calls: Call[] = [];
let results: Result[] = [];

function makeAdmin() {
  return {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: {}, orders: [] };
      calls.push(call);
      const settle = () => Promise.resolve(results.shift() ?? { data: [], error: null });
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.update = (patch: unknown) => { call.op = 'update'; call.payload = patch; return b; };
      b.eq = (col: string, value: unknown) => { call.filters[col] = value; return b; };
      b.is = (col: string, value: unknown) => { call.filters[`${col} is`] = value; return b; };
      b.order = (col: string, opts: unknown) => { call.orders.push([col, opts]); return b; };
      b.limit = (n: number) => { call.limit = n; return b; };
      b.maybeSingle = settle;
      b.single = settle;
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => settle().then(resolve, reject);
      return b;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, body?: unknown): VercelRequest {
  return { method, headers: {}, query: {}, body } as unknown as VercelRequest;
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

beforeEach(() => {
  calls = [];
  results = [];
  mockedAdmin.mockReturnValue(makeAdmin());
  mockedLimit.mockClear();
  mockedLimit.mockResolvedValue(true);
  mockedApply.mockReset();
  mockedApply.mockResolvedValue({ ok: true, contract: DONE.contract_after });
});

describe('GET /api/coach-reflections', () => {
  it('lists this user\'s finished reflections, unresolved first, newest first, bounded — on the reads bucket', async () => {
    results.push({ data: [DONE], error: null });
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ reflections: [DONE] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      table: 'coach_reflections', op: 'select',
      filters: { user_id: 'user-123', status: 'done' },
      orders: [['resolved_at', { ascending: true, nullsFirst: true }], ['day', { ascending: false }]],
      limit: LIST_LIMIT,
    });
    expect(mockedLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'user-123', 'reads');
  });

  it('500s a database error without leaking it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    results.push({ data: null, error: { message: 'relation "coach_reflections" does not exist' } });
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(500);
    expect(body()).toBe('Failed to load reflections');
    error.mockRestore();
  });

  it('405s other methods and stops at the rate limit', async () => {
    const a = makeRes();
    await handler(makeReq('DELETE', { id: ID }), a.res);
    expect(a.statusCode()).toBe(405);
    mockedLimit.mockResolvedValueOnce(false);
    const b = makeRes();
    await handler(makeReq('GET'), b.res);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /api/coach-reflections { id, resolution }', () => {
  it('400s a bad id or resolution before reading anything', async () => {
    for (const body of [{}, { id: 'nope', resolution: 'accepted' }, { id: ID }, { id: ID, resolution: 'maybe' }, { id: ID, resolution: true }]) {
      const { res, statusCode } = makeRes();
      await handler(makeReq('POST', body), res);
      expect(statusCode(), JSON.stringify(body)).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect(mockedLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'user-123', 'writes');
  });

  it('accepting writes contract_after through the contract door, checked against contract_before, and stamps the row', async () => {
    results.push({ data: DONE, error: null });
    results.push({ data: { ...DONE, resolved_at: '2026-09-28T09:00:00Z', resolution: 'accepted' }, error: null });
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { id: ID, resolution: 'accepted' }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ reflection: expect.objectContaining({ resolution: 'accepted' }) });
    expect(mockedApply).toHaveBeenCalledWith(expect.anything(), 'user-123', DONE.contract_before, DONE.contract_after);
    expect(calls[0]).toMatchObject({ table: 'coach_reflections', op: 'select', filters: { id: ID, user_id: 'user-123' } });
    expect(calls[1]).toMatchObject({
      table: 'coach_reflections', op: 'update',
      filters: { id: ID, user_id: 'user-123', 'resolved_at is': null },
      payload: { resolution: 'accepted', resolved_at: expect.any(String) },
    });
  });

  it('rejecting stamps only — the contract door is never opened', async () => {
    results.push({ data: DONE, error: null });
    results.push({ data: { ...DONE, resolved_at: '2026-09-28T09:00:00Z', resolution: 'rejected' }, error: null });
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { id: ID, resolution: 'rejected' }), res);
    expect(statusCode()).toBe(200);
    expect(mockedApply).not.toHaveBeenCalled();
    expect(calls[1]).toMatchObject({ op: 'update', payload: { resolution: 'rejected', resolved_at: expect.any(String) } });
  });

  it('a null contract_before is checked as an empty contract', async () => {
    results.push({ data: { ...DONE, contract_before: null }, error: null });
    results.push({ data: { ...DONE, resolution: 'accepted', resolved_at: 'x' }, error: null });
    const { res } = makeRes();
    await handler(makeReq('POST', { id: ID, resolution: 'accepted' }), res);
    expect(mockedApply).toHaveBeenCalledWith(expect.anything(), 'user-123', '', DONE.contract_after);
  });

  it('404s an id that is not this user\'s (the read is scoped), without touching the contract', async () => {
    results.push({ data: null, error: null });
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { id: OTHER_ID, resolution: 'accepted' }), res);
    expect(statusCode()).toBe(404);
    expect(calls[0].filters).toEqual({ id: OTHER_ID, user_id: 'user-123' });
    expect(mockedApply).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('409s a row with no contract edit, one already resolved, and a stale accept the contract door refuses', async () => {
    results.push({ data: { ...DONE, contract_after: null }, error: null });
    const a = makeRes();
    await handler(makeReq('POST', { id: ID, resolution: 'accepted' }), a.res);
    expect(a.statusCode()).toBe(409);
    expect(a.body()).toMatch(/proposed no contract edit/);

    results.push({ data: { ...DONE, status: 'failed' }, error: null });
    const f = makeRes();
    await handler(makeReq('POST', { id: ID, resolution: 'rejected' }), f.res);
    expect(f.statusCode()).toBe(409);

    results.push({ data: { ...DONE, resolved_at: '2026-09-28T09:00:00Z', resolution: 'rejected' }, error: null });
    const b = makeRes();
    await handler(makeReq('POST', { id: ID, resolution: 'accepted' }), b.res);
    expect(b.statusCode()).toBe(409);
    expect(b.body()).toBe('Already rejected');
    expect(mockedApply).not.toHaveBeenCalled();

    results.push({ data: DONE, error: null });
    mockedApply.mockResolvedValueOnce({ ok: false, reason: 'The contract changed since this proposal was made.' });
    const c = makeRes();
    await handler(makeReq('POST', { id: ID, resolution: 'accepted' }), c.res);
    expect(c.statusCode()).toBe(409);
    expect(c.body()).toMatch(/changed since/);
    // Nothing stamped: the athlete can still reject, or re-read and accept a fresh proposal.
    expect(calls.filter(k => k.op === 'update')).toHaveLength(0);
  });

  it('a resolve that lands on zero rows (a racing click) is a 409, not a second resolution', async () => {
    results.push({ data: DONE, error: null });
    results.push({ data: null, error: null });
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { id: ID, resolution: 'rejected' }), res);
    expect(statusCode()).toBe(409);
    expect(body()).toBe('Already resolved');
  });
});
