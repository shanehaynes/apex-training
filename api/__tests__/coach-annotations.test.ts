import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/coachAnnotations';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedLimit = vi.mocked(enforceRateLimit);

const NOTE_ID = '11111111-2222-4333-8444-555555555555';
const BLOCK_ID = '99999999-8888-4777-8666-555555555555';

const DAY_NOTE = {
  id: NOTE_ID,
  target_kind: 'day',
  target_id: '2026-09-08',
  body: 'Deload this week — load ratio 1.4.',
  severity: 'caution',
  created_by: 'coach',
  created_at: '2026-09-07T08:00:00Z',
  dismissed_at: null,
};

// ── A fake service-role client that records what the handler asked for ───────
//
// Same posture as coach-conversations.test.ts: no query leaves this handler
// without .eq('user_id', <the JWT's user>), and the fake records each chain's
// table, operation, filters and payload so a missing scope is a failing test
// rather than a cross-account read in production.

interface Call {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  filters: Record<string, unknown>;
  payload?: unknown;
}

type Result = { data: unknown; error: { message: string } | null };

let calls: Call[] = [];
let results: Result[] = [];

function makeAdmin() {
  return {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: {} };
      calls.push(call);
      const settle = () => Promise.resolve(results.shift() ?? { data: [], error: null });
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.insert = (rows: unknown) => { call.op = 'insert'; call.payload = rows; return b; };
      b.update = (patch: unknown) => { call.op = 'update'; call.payload = patch; return b; };
      b.delete = () => { call.op = 'delete'; return b; };
      b.eq = (col: string, value: unknown) => { call.filters[col] = value; return b; };
      b.in = (col: string, value: unknown) => { call.filters[`${col} in`] = value; return b; };
      b.is = (col: string, value: unknown) => { call.filters[`${col} is`] = value; return b; };
      b.gte = (col: string, value: unknown) => { call.filters[`${col} >=`] = value; return b; };
      b.lte = (col: string, value: unknown) => { call.filters[`${col} <=`] = value; return b; };
      b.maybeSingle = settle;
      b.single = settle;
      b.then = (resolve: (v: Result) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject);
      return b;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(
  method: string,
  { query = {}, body }: { query?: Record<string, string>; body?: unknown } = {},
): VercelRequest {
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

beforeEach(() => {
  calls = [];
  results = [];
  mockedAdmin.mockReturnValue(makeAdmin());
  mockedLimit.mockClear();
  mockedLimit.mockResolvedValue(true);
});

describe('/api/coach-annotations — method guard and throttle', () => {
  it('refuses a method it does not implement', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH'), res);
    expect(statusCode()).toBe(405);
    expect(calls).toEqual([]);
  });

  it('charges reads for a GET and writes for a POST and a DELETE', async () => {
    await handler(makeReq('GET', { query: { from: '2026-08-31', to: '2026-10-04' } }), makeRes().res);
    expect(mockedLimit).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'user-123', 'reads');
    await handler(makeReq('POST', { body: { target_kind: 'day', target_id: '2026-09-08', body: 'x' } }), makeRes().res);
    expect(mockedLimit).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'user-123', 'writes');
    await handler(makeReq('DELETE', { body: { id: NOTE_ID } }), makeRes().res);
    expect(mockedLimit).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'user-123', 'writes');
  });

  it('touches nothing when the caller is over the limit', async () => {
    mockedLimit.mockResolvedValue(false);
    await handler(makeReq('GET', { query: { from: '2026-08-31', to: '2026-10-04' } }), makeRes().res);
    expect(calls).toEqual([]);
  });
});

describe('GET ?from=&to= — the visible range', () => {
  it('runs one scoped day-range query and one scoped event/block query, and concatenates them', async () => {
    const blockNote = { ...DAY_NOTE, id: BLOCK_ID, target_kind: 'block', target_id: BLOCK_ID };
    results = [{ data: [DAY_NOTE], error: null }, { data: [blockNote], error: null }];
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET', { query: { from: '2026-08-31', to: '2026-10-04' } }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ annotations: [DAY_NOTE, blockNote] });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      table: 'coach_annotations',
      op: 'select',
      filters: {
        user_id: 'user-123',
        target_kind: 'day',
        'dismissed_at is': null,
        'target_id >=': '2026-08-31',
        'target_id <=': '2026-10-04',
      },
    });
    expect(calls[1]).toMatchObject({
      table: 'coach_annotations',
      op: 'select',
      filters: { user_id: 'user-123', 'target_kind in': ['event', 'block'], 'dismissed_at is': null },
    });
  });

  it.each<{ query: Record<string, string>; why: string }>([
    { query: {}, why: 'both bounds missing' },
    { query: { from: '2026-08-31' }, why: 'to missing' },
    { query: { from: '2026-8-31', to: '2026-10-04' }, why: 'from not zero-padded' },
    { query: { from: '2026-02-30', to: '2026-03-04' }, why: 'from not a real day' },
    { query: { from: '2026-10-04', to: '2026-08-31' }, why: 'range runs backwards' },
    { query: { from: '2025-01-01', to: '2026-06-01' }, why: 'range wider than a year' },
  ])('rejects $query ($why) before any query', async ({ query }) => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET', { query }), res);
    expect(statusCode()).toBe(400);
    expect(calls).toEqual([]);
  });

  it('accepts the widest range it allows', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET', { query: { from: '2026-01-01', to: '2027-01-02' } }), res);
    expect(statusCode()).toBe(200);
  });

  it('answers 500 when either query fails', async () => {
    results = [{ data: [], error: null }, { data: null, error: { message: 'boom' } }];
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET', { query: { from: '2026-08-31', to: '2026-10-04' } }), res);
    expect(statusCode()).toBe(500);
  });
});

describe('POST — create', () => {
  it('inserts the caller\'s row with created_by stamped by the server', async () => {
    results = [{ data: DAY_NOTE, error: null }];
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', {
      body: {
        target_kind: 'day', target_id: '2026-09-08',
        body: '  Deload this week — load ratio 1.4.  ', severity: 'caution',
        // A caller naming the author is ignored, not honoured.
        created_by: 'reflection', user_id: 'someone-else',
      },
    }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ annotation: DAY_NOTE });
    const [insert] = calls;
    expect(insert.op).toBe('insert');
    expect(insert.payload).toEqual({
      user_id: 'user-123',
      target_kind: 'day',
      target_id: '2026-09-08',
      body: 'Deload this week — load ratio 1.4.',
      severity: 'caution',
      created_by: 'coach',
    });
  });

  it('defaults severity to info', async () => {
    results = [{ data: DAY_NOTE, error: null }];
    await handler(makeReq('POST', { body: { target_kind: 'event', target_id: 'w1-mon-stretch__2026-09-07', body: 'Easy tonight.' } }), makeRes().res);
    expect(calls[0].payload).toMatchObject({ severity: 'info', target_kind: 'event', target_id: 'w1-mon-stretch__2026-09-07' });
  });

  it.each<{ body: Record<string, unknown>; why: string }>([
    { body: { target_kind: 'week', target_id: '2026-09-08', body: 'x' }, why: 'kind outside the set' },
    { body: { target_kind: 'day', target_id: 'tomorrow', body: 'x' }, why: 'day id not a date' },
    { body: { target_kind: 'block', target_id: 'base-block', body: 'x' }, why: 'block id not a uuid' },
    { body: { target_kind: 'event', target_id: '', body: 'x' }, why: 'empty event id' },
    { body: { target_kind: 'event', target_id: 'e'.repeat(201), body: 'x' }, why: 'event id too long' },
    { body: { target_kind: 'day', target_id: '2026-09-08', body: '   ' }, why: 'blank body' },
    { body: { target_kind: 'day', target_id: '2026-09-08', body: 'x'.repeat(401) }, why: 'body over 400' },
    { body: { target_kind: 'day', target_id: '2026-09-08', body: 42 }, why: 'body not a string' },
    { body: { target_kind: 'day', target_id: '2026-09-08', body: 'x', severity: 'panic' }, why: 'severity outside the set' },
  ])('rejects a body ($why) before any query', async ({ body }) => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { body }), res);
    expect(statusCode()).toBe(400);
    expect(calls).toEqual([]);
  });

  it('accepts a body of exactly 400 characters and a block uuid', async () => {
    results = [{ data: DAY_NOTE, error: null }];
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { body: { target_kind: 'block', target_id: BLOCK_ID, body: 'x'.repeat(400) } }), res);
    expect(statusCode()).toBe(200);
  });

  it('answers 500 when the insert fails', async () => {
    results = [{ data: null, error: { message: 'boom' } }];
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { body: { target_kind: 'day', target_id: '2026-09-08', body: 'x' } }), res);
    expect(statusCode()).toBe(500);
  });
});

describe('DELETE { id } — dismiss', () => {
  it('stamps dismissed_at on the caller\'s live row only, never deletes', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('DELETE', { body: { id: NOTE_ID } }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const [update] = calls;
    expect(update.op).toBe('update');
    expect(update.payload).toEqual({ dismissed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(update.filters).toEqual({ id: NOTE_ID, user_id: 'user-123', 'dismissed_at is': null });
  });

  it('also takes the id from the query string', async () => {
    await handler(makeReq('DELETE', { query: { id: NOTE_ID } }), makeRes().res);
    expect(calls[0].filters.id).toBe(NOTE_ID);
  });

  it('rejects a non-uuid id before any query', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { body: { id: 'note-1' } }), res);
    expect(statusCode()).toBe(400);
    expect(calls).toEqual([]);
  });

  it('answers 500 when the update fails', async () => {
    results = [{ data: null, error: { message: 'boom' } }];
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { body: { id: NOTE_ID } }), res);
    expect(statusCode()).toBe(500);
  });
});
