import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/coachMemory';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';
import { MEMORY_CONFIRMED_CAP } from '../../src/lib/coach/memory';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedLimit = vi.mocked(enforceRateLimit);

const ID = '11111111-2222-4333-8444-555555555555';

const ROW = {
  id: ID, kind: 'goal', content: 'Rainier June 2027', confidence: null, source_kind: 'chat',
  created_at: '2026-09-27T10:00:00Z', confirmed_at: '2026-09-27T10:00:00Z',
};
const PROPOSED = { ...ROW, id: '22222222-2222-4333-8444-555555555555', confirmed_at: null, source_kind: 'reflection', confidence: 0.7 };

// ── A fake service-role client that records what the handler asked for ───────
// Same shape as coach-conversations.test.ts: the assertion that matters on
// every operation is .eq('user_id', <the JWT's user>).

interface Call {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  filters: Record<string, unknown>;
  /** .is(col, null) and .not(col, 'is', null) predicates, in order. */
  predicates: string[];
  payload?: unknown;
}

type Result = { data: unknown; error: { message: string } | null; count?: number | null };

let calls: Call[] = [];
let results: Record<string, Result> = {};

function makeAdmin() {
  return {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: {}, predicates: [] };
      calls.push(call);
      const settle = () => Promise.resolve(results[`${table}:${call.op}`] ?? { data: [], error: null, count: 0 });
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.insert = (rows: unknown) => { call.op = 'insert'; call.payload = rows; return b; };
      b.update = (patch: unknown) => { call.op = 'update'; call.payload = patch; return b; };
      b.delete = () => { call.op = 'delete'; return b; };
      b.eq = (col: string, value: unknown) => { call.filters[col] = value; return b; };
      b.is = (col: string, value: unknown) => { call.predicates.push(`${col} is ${String(value)}`); return b; };
      b.not = (col: string, op: string, value: unknown) => { call.predicates.push(`${col} not ${op} ${String(value)}`); return b; };
      b.order = () => b;
      b.limit = () => b;
      b.maybeSingle = settle;
      b.single = settle;
      b.then = (resolve: (v: Result) => unknown, reject?: (e: unknown) => unknown) => settle().then(resolve, reject);
      return b;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, { query = {}, body }: { query?: Record<string, string>; body?: unknown } = {}): VercelRequest {
  return { method, headers: {}, query, body } as unknown as VercelRequest;
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

function callsFor(op: Call['op']): Call[] {
  return calls.filter(c => c.table === 'coach_memory' && c.op === op);
}

beforeEach(() => {
  calls = [];
  results = {};
  mockedAdmin.mockReturnValue(makeAdmin());
  mockedLimit.mockClear();
  mockedLimit.mockResolvedValue(true);
});

describe('/api/coach-memory — method guard and throttle', () => {
  it('refuses a method it does not implement', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH'), res);
    expect(statusCode()).toBe(405);
    expect(calls).toEqual([]);
  });

  it('charges reads for GET and writes for everything else, and touches nothing over the limit', async () => {
    await handler(makeReq('GET'), makeRes().res);
    expect(mockedLimit).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'user-123', 'reads');
    await handler(makeReq('POST', { body: { id: ID } }), makeRes().res);
    expect(mockedLimit).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'user-123', 'writes');
    calls = [];
    mockedLimit.mockResolvedValue(false);
    await handler(makeReq('DELETE', { body: { id: ID } }), makeRes().res);
    expect(calls).toEqual([]);
  });
});

describe('GET — the notebook\'s list', () => {
  it('lists this user\'s non-archived, non-superseded rows with a confirmed flag', async () => {
    results['coach_memory:select'] = { data: [ROW, PROPOSED], error: null };
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ memories: [{ ...ROW, confirmed: true }, { ...PROPOSED, confirmed: false }] });
    const [call] = callsFor('select');
    expect(call.filters).toEqual({ user_id: 'user-123' });
    expect(call.predicates).toEqual(['archived_at is null', 'superseded_by is null']);
  });

  it('500s on a database error without leaking it', async () => {
    results['coach_memory:select'] = { data: null, error: { message: 'relation does not exist' } };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(500);
    expect(body()).toBe('Failed to load memory');
    err.mockRestore();
  });
});

describe('POST { id } — confirm a proposal', () => {
  it('sets confirmed_at on this user\'s row and returns it confirmed', async () => {
    results['coach_memory:update'] = { data: { ...PROPOSED, confirmed_at: '2026-09-27T11:00:00Z' }, error: null };
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { body: { id: PROPOSED.id } }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ memory: { ...PROPOSED, confirmed_at: '2026-09-27T11:00:00Z', confirmed: true } });
    const [call] = callsFor('update');
    expect(call.filters).toEqual({ id: PROPOSED.id, user_id: 'user-123' });
    expect(call.predicates).toEqual(['archived_at is null']);
    expect(call.payload).toEqual({ confirmed_at: expect.any(String) });
  });

  it('404s an id that is not this user\'s, 400s a malformed one', async () => {
    results['coach_memory:update'] = { data: null, error: null };
    const a = makeRes();
    await handler(makeReq('POST', { body: { id: ID } }), a.res);
    expect(a.statusCode()).toBe(404);
    const b = makeRes();
    await handler(makeReq('POST', { body: { id: 'not-a-uuid' } }), b.res);
    expect(b.statusCode()).toBe(400);
    expect(callsFor('update')).toHaveLength(1);
  });
});

describe('POST { kind, content } — the athlete adds a fact', () => {
  it('inserts a confirmed, user-sourced row for this user', async () => {
    results['coach_memory:insert'] = { data: { ...ROW, source_kind: 'user' }, error: null };
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { body: { kind: 'goal', content: '  Rainier   June 2027 ' } }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ memory: { ...ROW, source_kind: 'user', confirmed: true } });
    const [count] = callsFor('select');
    expect(count.filters).toEqual({ user_id: 'user-123' });
    expect(count.predicates).toEqual(['confirmed_at not is null', 'archived_at is null', 'superseded_by is null']);
    const [insert] = callsFor('insert');
    expect(insert.payload).toEqual({
      user_id: 'user-123', kind: 'goal', content: 'Rainier June 2027', source_kind: 'user', confirmed_at: expect.any(String),
    });
  });

  it('400s a bad kind, an empty or over-long content; 409s when memory is full', async () => {
    for (const body of [
      { kind: 'wish', content: 'x' },
      { kind: 'goal', content: '   ' },
      { kind: 'goal', content: 'x'.repeat(501) },
      { kind: 'goal' },
      {},
    ]) {
      const { res, statusCode } = makeRes();
      await handler(makeReq('POST', { body }), res);
      expect(statusCode(), JSON.stringify(body)).toBe(400);
    }
    expect(callsFor('insert')).toEqual([]);
    results['coach_memory:select'] = { data: null, error: null, count: MEMORY_CONFIRMED_CAP };
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { body: { kind: 'goal', content: 'one more' } }), res);
    expect(statusCode()).toBe(409);
    expect(callsFor('insert')).toEqual([]);
  });
});

describe('DELETE { id } — forget', () => {
  it('archives this user\'s row, from the body or the query, and never hard-deletes', async () => {
    const a = makeRes();
    await handler(makeReq('DELETE', { body: { id: ID } }), a.res);
    expect(a.statusCode()).toBe(200);
    expect(a.body()).toEqual({ ok: true });
    const b = makeRes();
    await handler(makeReq('DELETE', { query: { id: ID } }), b.res);
    expect(b.statusCode()).toBe(200);
    const updates = callsFor('update');
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.filters).toEqual({ id: ID, user_id: 'user-123' });
      expect(u.payload).toEqual({ archived_at: expect.any(String) });
    }
    expect(callsFor('delete')).toEqual([]);
  });

  it('400s a malformed id', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { body: { id: 'x' } }), res);
    expect(statusCode()).toBe(400);
    expect(calls).toEqual([]);
  });
});
