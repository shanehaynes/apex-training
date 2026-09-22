import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/coachConversations';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { enforceRateLimit } from '../_lib/rateLimit';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedLimit = vi.mocked(enforceRateLimit);

const CONVERSATION_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-8888-4777-8666-555555555555';

const CONVERSATION = {
  id: CONVERSATION_ID,
  mode: 'chat',
  title: null,
  created_at: '2026-09-22T11:00:00Z',
  updated_at: '2026-09-22T12:00:00Z',
};

// ── A fake service-role client that records what the handler asked for ───────
//
// The point of every assertion below is the same one: no query leaves this
// handler without .eq('user_id', <the JWT's user>). The fake records each
// chain's table, operation, filters and payload so a missing scope is a
// failing test rather than a cross-account read in production.

interface Call {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  filters: Record<string, unknown>;
  payload?: unknown;
}

type Result = { data: unknown; error: { message: string } | null; count?: number };

let calls: Call[] = [];
let results: Record<string, Result> = {};

function makeAdmin() {
  return {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: {} };
      calls.push(call);
      const settle = () =>
        Promise.resolve(results[`${table}:${call.op}`] ?? { data: [], error: null, count: 0 });
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.insert = (rows: unknown) => { call.op = 'insert'; call.payload = rows; return b; };
      b.update = (patch: unknown) => { call.op = 'update'; call.payload = patch; return b; };
      b.delete = () => { call.op = 'delete'; return b; };
      b.eq = (col: string, value: unknown) => { call.filters[col] = value; return b; };
      b.order = () => b;
      b.limit = () => b;
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

/** Every chain against `table` with this operation. */
function callsFor(table: string, op: Call['op']): Call[] {
  return calls.filter(c => c.table === table && c.op === op);
}

beforeEach(() => {
  calls = [];
  results = {};
  mockedAdmin.mockReturnValue(makeAdmin());
  mockedLimit.mockClear();
  mockedLimit.mockResolvedValue(true);
});

describe('/api/coach-conversations — method guard and throttle', () => {
  it('refuses a method it does not implement', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('PUT'), res);
    expect(statusCode()).toBe(405);
    expect(calls).toEqual([]);
  });

  it('charges the conversations bucket, not reads or writes', async () => {
    const { res } = makeRes();
    await handler(makeReq('GET', { query: { mode: 'chat' } }), res);
    expect(mockedLimit).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'user-123', 'conversations',
    );
  });

  it('touches nothing when the caller is over the limit', async () => {
    mockedLimit.mockResolvedValue(false);
    const { res } = makeRes();
    await handler(makeReq('GET', { query: { mode: 'chat' } }), res);
    expect(calls).toEqual([]);
  });
});

describe('GET — list and load', () => {
  it('lists this user\'s threads for one mode', async () => {
    results['coach_conversations:select'] = { data: [CONVERSATION], error: null };
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET', { query: { mode: 'chat' } }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ conversations: [CONVERSATION] });
    expect(callsFor('coach_conversations', 'select')[0].filters)
      .toEqual({ user_id: 'user-123', mode: 'chat' });
  });

  it('rejects a mode outside the closed set', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET', { query: { mode: 'sideways' } }), res);
    expect(statusCode()).toBe(400);
    expect(calls).toEqual([]);
  });

  it('loads a thread\'s messages, scoping both queries by user_id', async () => {
    const row = {
      id: 'm1', role: 'assistant', api_content: 'hi', display_text: 'hi',
      kind: 'turn', created_at: '2026-09-22T12:00:00Z',
    };
    results['coach_conversations:select'] = { data: CONVERSATION, error: null };
    results['coach_messages:select'] = { data: [row], error: null };
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET', { query: { id: CONVERSATION_ID } }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ conversation: CONVERSATION, messages: [row] });
    expect(callsFor('coach_conversations', 'select')[0].filters)
      .toEqual({ id: CONVERSATION_ID, user_id: 'user-123' });
    expect(callsFor('coach_messages', 'select')[0].filters)
      .toEqual({ conversation_id: CONVERSATION_ID, user_id: 'user-123' });
  });

  it('answers 404 for a thread this user does not own, and reads no messages', async () => {
    results['coach_conversations:select'] = { data: null, error: null };
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET', { query: { id: OTHER_ID } }), res);
    expect(statusCode()).toBe(404);
    expect(callsFor('coach_messages', 'select')).toEqual([]);
  });

  it('rejects a malformed id before it reaches Postgres', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET', { query: { id: 'not-a-uuid' } }), res);
    expect(statusCode()).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('POST { mode } — create', () => {
  it('stamps the JWT user id and ignores one in the body', async () => {
    results['coach_conversations:insert'] = { data: CONVERSATION, error: null };
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { body: { mode: 'builder', user_id: 'someone-else' } }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ conversation: CONVERSATION });
    expect(callsFor('coach_conversations', 'insert')[0].payload)
      .toEqual({ user_id: 'user-123', mode: 'builder', title: null });
  });

  it('rejects a mode outside the closed set', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { body: { mode: 'sideways' } }), res);
    expect(statusCode()).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('POST { id, messages } — append', () => {
  const MESSAGES = [
    { role: 'user', api_content: 'How did last week go?', display_text: 'How did last week go?' },
    { role: 'assistant', api_content: 'Three sessions.', display_text: 'Three sessions.', kind: 'turn' },
  ];

  function ownedAndEmpty() {
    results['coach_conversations:select'] = { data: { id: CONVERSATION_ID }, error: null };
    results['coach_messages:select'] = { data: null, error: null, count: 4 };
    results['coach_messages:insert'] = { data: [], error: null };
  }

  it('stamps every row with the JWT user id and the conversation, and bumps updated_at', async () => {
    ownedAndEmpty();
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { body: { id: CONVERSATION_ID, messages: MESSAGES } }), res);
    expect(statusCode()).toBe(200);
    const inserted = callsFor('coach_messages', 'insert')[0].payload as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(2);
    expect(inserted.every(r => r.user_id === 'user-123')).toBe(true);
    expect(inserted.every(r => r.conversation_id === CONVERSATION_ID)).toBe(true);
    // kind defaults rather than being required of the client.
    expect(inserted[0].kind).toBe('turn');
    const bump = callsFor('coach_conversations', 'update')[0];
    expect(bump.filters).toEqual({ id: CONVERSATION_ID, user_id: 'user-123' });
    expect(bump.payload).toHaveProperty('updated_at');
  });

  it('stores a hidden row — display_text null, api_content kept', async () => {
    ownedAndEmpty();
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', {
      body: {
        id: CONVERSATION_ID,
        messages: [{ role: 'user', api_content: 'Give me my coaching briefing for today.', display_text: null }],
      },
    }), res);
    expect(statusCode()).toBe(200);
    const inserted = callsFor('coach_messages', 'insert')[0].payload as Array<Record<string, unknown>>;
    expect(inserted[0].display_text).toBeNull();
    expect(inserted[0].api_content).toBe('Give me my coaching briefing for today.');
  });

  it('refuses a row with neither half', async () => {
    ownedAndEmpty();
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', {
      body: { id: CONVERSATION_ID, messages: [{ role: 'user', api_content: null, display_text: null }] },
    }), res);
    expect(statusCode()).toBe(400);
    expect(callsFor('coach_messages', 'insert')).toEqual([]);
  });

  it('refuses a role the table would reject anyway', async () => {
    ownedAndEmpty();
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', {
      body: { id: CONVERSATION_ID, messages: [{ role: 'system', api_content: 'x', display_text: 'x' }] },
    }), res);
    expect(statusCode()).toBe(400);
  });

  it('413s a batch past the 400 KB body cap', async () => {
    ownedAndEmpty();
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', {
      body: {
        id: CONVERSATION_ID,
        messages: [{ role: 'user', api_content: 'x'.repeat(400_001), display_text: 'big' }],
      },
    }), res);
    expect(statusCode()).toBe(413);
    expect(body()).toBe('Conversation too large');
    expect(callsFor('coach_messages', 'insert')).toEqual([]);
  });

  it('413s once the thread would pass 80 messages', async () => {
    results['coach_conversations:select'] = { data: { id: CONVERSATION_ID }, error: null };
    results['coach_messages:select'] = { data: null, error: null, count: 79 };
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { body: { id: CONVERSATION_ID, messages: MESSAGES } }), res);
    expect(statusCode()).toBe(413);
    expect(callsFor('coach_messages', 'insert')).toEqual([]);
  });

  it('404s an append to a thread this user does not own, and inserts nothing', async () => {
    results['coach_conversations:select'] = { data: null, error: null };
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { body: { id: OTHER_ID, messages: MESSAGES } }), res);
    expect(statusCode()).toBe(404);
    expect(callsFor('coach_messages', 'insert')).toEqual([]);
    expect(callsFor('coach_conversations', 'select')[0].filters)
      .toEqual({ id: OTHER_ID, user_id: 'user-123' });
  });
});

describe('PATCH — rename', () => {
  it('scopes the update by user_id', async () => {
    results['coach_conversations:update'] = { data: { ...CONVERSATION, title: 'Deload week' }, error: null };
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { body: { id: CONVERSATION_ID, title: '  Deload week  ' } }), res);
    expect(statusCode()).toBe(200);
    const call = callsFor('coach_conversations', 'update')[0];
    expect(call.filters).toEqual({ id: CONVERSATION_ID, user_id: 'user-123' });
    expect(call.payload).toEqual({ title: 'Deload week' });
  });

  it('404s a rename of a thread this user does not own', async () => {
    results['coach_conversations:update'] = { data: null, error: null };
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { body: { id: OTHER_ID, title: 'Mine now' } }), res);
    expect(statusCode()).toBe(404);
  });
});

describe('DELETE', () => {
  it('scopes the delete by user_id', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('DELETE', { body: { id: CONVERSATION_ID } }), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ ok: true });
    expect(callsFor('coach_conversations', 'delete')[0].filters)
      .toEqual({ id: CONVERSATION_ID, user_id: 'user-123' });
  });

  it('rejects a malformed id', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { body: { id: 'nope' } }), res);
    expect(statusCode()).toBe(400);
    expect(calls).toEqual([]);
  });
});
