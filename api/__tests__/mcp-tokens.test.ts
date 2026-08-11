import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/mcpTokens';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { sha256hex } from '../_lib/mcp/tokens';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  inserted?: Record<string, unknown>;
  revoked?: boolean;
  activeCount: number;
  listRows: Array<Record<string, unknown>>;
  /** Simulate revoking a token that isn't yours / doesn't exist. */
  missing?: boolean;
}

function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      expect(table).toBe('mcp_tokens');
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['eq', 'is', 'order']) builder[m] = chain;
      builder.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) {
          // Active-count query resolves via await on the builder.
          builder.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ count: state.activeCount, error: null }).then(resolve);
          return builder;
        }
        builder.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: state.listRows, error: null }).then(resolve);
        // insert(...).select('id').single()
        builder.single = async () => ({ data: { id: 'tok-1' }, error: null });
        return builder;
      };
      builder.insert = (row: Record<string, unknown>) => {
        state.inserted = row;
        return builder;
      };
      builder.update = () => {
        state.revoked = !state.missing;
        builder.select = () => ({
          // update chain resolves with affected rows
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: state.missing ? [] : [{ id: 'tok-1' }], error: null }).then(resolve),
        });
        return builder;
      };
      return builder;
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
  state = { activeCount: 0, listRows: [] };
  mockedAdmin.mockReturnValue(makeAdmin(state));
});

describe('POST /api/mcp-tokens — mint', () => {
  it('returns an apx_ plaintext token once and stores only its hash + last4', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { name: 'Claude Desktop' }), res);
    expect(statusCode()).toBe(200);

    const { token } = body() as { id: string; token: string };
    expect(token).toMatch(/^apx_[A-Za-z0-9_-]{43}$/);

    expect(state.inserted).toMatchObject({
      user_id: 'user-123',
      name: 'Claude Desktop',
      token_hash: sha256hex(token),
      token_last4: token.slice(-4),
    });
    // The plaintext never lands in the row.
    expect(Object.values(state.inserted!)).not.toContain(token);
  });

  it('rejects a blank name', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('POST', { name: '   ' }), res);
    expect(statusCode()).toBe(400);
    expect(state.inserted).toBeUndefined();
  });

  it('caps active tokens', async () => {
    state.activeCount = 10;
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('POST', { name: 'One more' }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('limit');
    expect(state.inserted).toBeUndefined();
  });
});

describe('GET /api/mcp-tokens — list', () => {
  it('returns display metadata only (the select never includes the hash)', async () => {
    state.listRows = [
      { id: 'tok-1', name: 'Claude', token_last4: 'a1b2', created_at: 'x', last_used_at: null, revoked_at: null },
    ];
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    const { tokens } = body() as { tokens: Array<Record<string, unknown>> };
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toHaveProperty('token_hash');
  });
});

describe('DELETE /api/mcp-tokens — revoke', () => {
  it('revokes an owned token', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', undefined, { id: 'tok-1' }), res);
    expect(statusCode()).toBe(200);
    expect(state.revoked).toBe(true);
  });

  it("404s on another user's (or unknown) token id", async () => {
    state.missing = true;
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', undefined, { id: 'not-mine' }), res);
    expect(statusCode()).toBe(404);
  });

  it('400s without an id', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE'), res);
    expect(statusCode()).toBe(400);
  });
});
