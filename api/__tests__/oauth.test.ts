import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import metadataHandler from '../_lib/handlers/oauthMetadata';
import registerHandler from '../_lib/handlers/oauthRegister';
import authorizeHandler from '../_lib/handlers/oauthAuthorize';
import approveHandler from '../_lib/handlers/oauthApprove';
import tokenHandler from '../_lib/handlers/oauthToken';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { resolveMcpToken, sha256hex } from '../_lib/mcp/tokens';
import { parseFormBody, publicOrigin, redirectUriMatches, sha256base64url } from '../_lib/oauth/common';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);

// ── In-memory supabase covering the chains the OAuth handlers use ─────────────

type Row = Record<string, unknown>;

function makeDb(seed: Record<string, Row[]> = {}) {
  let idc = 0;
  const tables: Record<string, Row[]> = { oauth_clients: [], oauth_codes: [], mcp_tokens: [], ...seed };
  const db = {
    from(table: string) {
      const rows = () => tables[table];
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'insert' | 'update' = 'select';
      let insertRows: Row[] = [];
      let patch: Row | null = null;
      let countMode = false;
      const match = (r: Row) => filters.every(f => f(r));
      const finish = () => {
        if (op === 'insert') {
          const withIds = insertRows.map(r => ({ id: `row-${++idc}`, ...r }));
          rows().push(...withIds);
          return { data: withIds, error: null };
        }
        if (op === 'update') {
          const hit = rows().filter(match);
          for (const r of hit) Object.assign(r, patch);
          return { data: hit, error: null };
        }
        if (countMode) return { count: rows().filter(match).length, error: null };
        return { data: rows().filter(match), error: null };
      };
      const api: Record<string, unknown> = {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          if (opts?.head) countMode = true;
          return api;
        },
        eq: (k: string, v: unknown) => {
          filters.push(r => r[k] === v);
          return api;
        },
        is: (k: string, v: unknown) => {
          filters.push(r => (v === null ? r[k] == null : r[k] === v));
          return api;
        },
        // resolveMcpToken's expiry clause: "expires_at.is.null,expires_at.gt.<iso>"
        or: (expr: string) => {
          const gt = expr.match(/expires_at\.gt\.(.+)$/)?.[1];
          filters.push(r => r.expires_at == null || (gt !== undefined && String(r.expires_at) > gt));
          return api;
        },
        order: () => api,
        insert: (data: Row | Row[]) => {
          op = 'insert';
          insertRows = Array.isArray(data) ? data : [data];
          return api;
        },
        update: (p: Row) => {
          op = 'update';
          patch = p;
          return api;
        },
        maybeSingle: async () => ({ data: rows().find(match) ?? null, error: null }),
        single: async () => ({ data: rows().find(match) ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(finish()).then(resolve),
      };
      return api;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  return { db, tables };
}

function makeReq(method: string, opts: { body?: unknown; query?: Record<string, string>; host?: string } = {}): VercelRequest {
  return {
    method,
    headers: { host: opts.host ?? 'apex.test', 'x-forwarded-proto': 'https' },
    body: opts.body,
    query: opts.query ?? {},
  } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
    end() { return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload, headers };
}

let tables: Record<string, Row[]>;

beforeEach(() => {
  const made = makeDb();
  tables = made.tables;
  mockedAdmin.mockReturnValue(made.db);
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('oauth/common helpers', () => {
  it('matches loopback redirect URIs on any port, exact otherwise', () => {
    expect(redirectUriMatches('http://127.0.0.1:3000/cb', 'http://127.0.0.1:53187/cb')).toBe(true);
    expect(redirectUriMatches('http://localhost/cb', 'http://localhost:8080/cb')).toBe(true);
    expect(redirectUriMatches('https://claude.ai/cb', 'https://claude.ai/cb')).toBe(true);
    expect(redirectUriMatches('https://claude.ai/cb', 'https://claude.ai:444/cb')).toBe(false);
    expect(redirectUriMatches('https://claude.ai/cb', 'https://evil.example/cb')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1/other')).toBe(false);
  });

  it('parses urlencoded, JSON-string, and object bodies', () => {
    expect(parseFormBody('grant_type=authorization_code&code=abc')).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
    });
    expect(parseFormBody('{"grant_type":"refresh_token"}')).toEqual({ grant_type: 'refresh_token' });
    expect(parseFormBody({ a: 'b', n: 1 })).toEqual({ a: 'b' });
  });
});

// A connector stores issuer/endpoints/resource at registration time, so these
// must not follow the host that served the request — a Vercel deployment URL
// would pin the client to one frozen build.
describe('publicOrigin', () => {
  const saved = process.env.VITE_PUBLIC_ORIGIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.VITE_PUBLIC_ORIGIN;
    else process.env.VITE_PUBLIC_ORIGIN = saved;
  });

  it('falls back to the request host when unset (local dev, e2e)', () => {
    delete process.env.VITE_PUBLIC_ORIGIN;
    expect(publicOrigin(makeReq('GET', { host: 'apex.test' }))).toBe('https://apex.test');
  });

  it('pins to the configured origin regardless of the serving host', () => {
    process.env.VITE_PUBLIC_ORIGIN = 'https://apex.example.com';
    const preview = makeReq('GET', { host: 'apex-training-abc123-owner.vercel.app' });
    expect(publicOrigin(preview)).toBe('https://apex.example.com');
  });

  it('keeps only the origin, dropping any path or trailing slash', () => {
    process.env.VITE_PUBLIC_ORIGIN = 'https://apex.example.com/app/';
    expect(publicOrigin(makeReq('GET'))).toBe('https://apex.example.com');
  });

  it('falls back rather than emitting a malformed issuer', () => {
    process.env.VITE_PUBLIC_ORIGIN = 'not-a-url';
    expect(publicOrigin(makeReq('GET', { host: 'apex.test' }))).toBe('https://apex.test');
    process.env.VITE_PUBLIC_ORIGIN = 'ftp://apex.example.com';
    expect(publicOrigin(makeReq('GET', { host: 'apex.test' }))).toBe('https://apex.test');
  });

  it('stamps the configured origin through the discovery documents', async () => {
    process.env.VITE_PUBLIC_ORIGIN = 'https://apex.example.com';
    const { res, body } = makeRes();
    await metadataHandler(makeReq('GET', { query: { kind: 'server' }, host: 'apex-training-abc123-owner.vercel.app' }), res);
    expect(body()).toMatchObject({
      issuer: 'https://apex.example.com',
      authorization_endpoint: 'https://apex.example.com/api/oauth-authorize',
      token_endpoint: 'https://apex.example.com/api/oauth-token',
      registration_endpoint: 'https://apex.example.com/api/oauth-register',
    });
  });
});

// ── Discovery ─────────────────────────────────────────────────────────────────

describe('/api/oauth-metadata', () => {
  it('serves protected-resource metadata pointing at this origin', async () => {
    const { res, body } = makeRes();
    await metadataHandler(makeReq('GET', { query: { kind: 'resource' } }), res);
    expect(body()).toMatchObject({
      resource: 'https://apex.test/api/mcp',
      authorization_servers: ['https://apex.test'],
    });
  });

  it('serves authorization-server metadata with PKCE + DCR endpoints', async () => {
    const { res, body } = makeRes();
    await metadataHandler(makeReq('GET', { query: { kind: 'server' } }), res);
    expect(body()).toMatchObject({
      issuer: 'https://apex.test',
      authorization_endpoint: 'https://apex.test/api/oauth-authorize',
      token_endpoint: 'https://apex.test/api/oauth-token',
      registration_endpoint: 'https://apex.test/api/oauth-register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});

// ── Full flow ─────────────────────────────────────────────────────────────────

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'test-verifier-string-of-sufficient-length-12345';
const CHALLENGE = sha256base64url(VERIFIER);

async function registerClient(): Promise<string> {
  const { res, body, statusCode } = makeRes();
  await registerHandler(
    makeReq('POST', { body: { client_name: 'Claude', redirect_uris: [REDIRECT] } }),
    res,
  );
  expect(statusCode()).toBe(201);
  return (body() as { client_id: string }).client_id;
}

async function mintCode(clientId: string): Promise<string> {
  const { res, body, statusCode } = makeRes();
  await approveHandler(
    makeReq('POST', {
      body: {
        decision: 'approve',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        state: 'xyz',
      },
    }),
    res,
  );
  expect(statusCode()).toBe(200);
  const url = new URL((body() as { redirect_to: string }).redirect_to);
  expect(url.searchParams.get('state')).toBe('xyz');
  return url.searchParams.get('code')!;
}

describe('register → authorize → approve → token → use', () => {
  it('registers a public client via DCR', async () => {
    const clientId = await registerClient();
    expect(clientId).toMatch(/^mcp_/);
    expect(tables.oauth_clients).toHaveLength(1);
  });

  it('rejects non-loopback http redirect URIs at registration', async () => {
    const { res, statusCode } = makeRes();
    await registerHandler(
      makeReq('POST', { body: { redirect_uris: ['http://evil.example/cb'] } }),
      res,
    );
    expect(statusCode()).toBe(400);
  });

  it('authorize hands a valid request to the SPA consent page', async () => {
    const clientId = await registerClient();
    const { res, statusCode, headers } = makeRes();
    await authorizeHandler(
      makeReq('GET', {
        query: {
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: CHALLENGE,
          code_challenge_method: 'S256',
          state: 'xyz',
          resource: 'https://apex.test/api/mcp',
        },
      }),
      res,
    );
    expect(statusCode()).toBe(302);
    const loc = new URL(headers.Location);
    expect(loc.origin + loc.pathname).toBe('https://apex.test/connect');
    expect(loc.searchParams.get('client_id')).toBe(clientId);
    expect(loc.searchParams.get('code_challenge')).toBe(CHALLENGE);
    expect(loc.searchParams.get('client_name')).toBe('Claude');
  });

  it('authorize 400s (never redirects) on an unregistered redirect_uri', async () => {
    const clientId = await registerClient();
    const { res, statusCode, headers } = makeRes();
    await authorizeHandler(
      makeReq('GET', {
        query: { response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: CHALLENGE, code_challenge_method: 'S256' },
      }),
      res,
    );
    expect(statusCode()).toBe(400);
    expect(headers.Location).toBeUndefined();
  });

  it('authorize redirects back with an error when PKCE is missing', async () => {
    const clientId = await registerClient();
    const { res, statusCode, headers } = makeRes();
    await authorizeHandler(
      makeReq('GET', { query: { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's1' } }),
      res,
    );
    expect(statusCode()).toBe(302);
    const loc = new URL(headers.Location);
    expect(loc.origin).toBe('https://claude.ai');
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s1');
  });

  it('approve mints a hashed one-shot code bound to the JWT user', async () => {
    const clientId = await registerClient();
    const code = await mintCode(clientId);
    expect(tables.oauth_codes).toHaveLength(1);
    expect(tables.oauth_codes[0]).toMatchObject({
      user_id: 'user-123',
      client_id: clientId,
      code_hash: sha256hex(code),
    });
    expect(tables.oauth_codes[0].consumed_at ?? null).toBeNull();
  });

  it('deny returns an access_denied redirect and mints nothing', async () => {
    const clientId = await registerClient();
    const { res, body } = makeRes();
    await approveHandler(
      makeReq('POST', {
        body: { decision: 'deny', client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, state: 's2' },
      }),
      res,
    );
    const url = new URL((body() as { redirect_to: string }).redirect_to);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(tables.oauth_codes).toHaveLength(0);
  });

  it('exchanges the code for tokens usable at the MCP endpoint, then refreshes', async () => {
    const clientId = await registerClient();
    const code = await mintCode(clientId);

    // Form-encoded body, as real OAuth clients send it.
    const { res, statusCode, body } = makeRes();
    await tokenHandler(
      makeReq('POST', {
        body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT)}&client_id=${clientId}&code_verifier=${VERIFIER}`,
      }),
      res,
    );
    expect(statusCode()).toBe(200);
    const grant = body() as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
    expect(grant.token_type).toBe('Bearer');
    expect(grant.expires_in).toBe(3600);
    expect(grant.access_token).toMatch(/^apx_/);
    expect(grant.refresh_token).toMatch(/^apxr_/);

    // The access token resolves through the unchanged MCP auth path…
    const admin = mockedAdmin();
    const asReq = (token: string) =>
      ({ headers: { authorization: `Bearer ${token}` } }) as unknown as VercelRequest;
    expect(await resolveMcpToken(admin!, asReq(grant.access_token))).toBe('user-123');
    // …and the refresh token does NOT (apxr_ fails the apx_ prefix check).
    expect(await resolveMcpToken(admin!, asReq(grant.refresh_token))).toBeNull();

    // Replayed code → invalid_grant.
    const replay = makeRes();
    await tokenHandler(
      makeReq('POST', {
        body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT)}&client_id=${clientId}&code_verifier=${VERIFIER}`,
      }),
      replay.res,
    );
    expect(replay.statusCode()).toBe(400);
    expect(replay.body()).toMatchObject({ error: 'invalid_grant' });

    // Refresh rotates: new pair issued, old refresh token dies.
    const refresh = makeRes();
    await tokenHandler(
      makeReq('POST', { body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(grant.refresh_token)}&client_id=${clientId}` }),
      refresh.res,
    );
    expect(refresh.statusCode()).toBe(200);
    const rotated = refresh.body() as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(grant.refresh_token);
    expect(await resolveMcpToken(admin!, asReq(rotated.access_token))).toBe('user-123');

    const reuse = makeRes();
    await tokenHandler(
      makeReq('POST', { body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(grant.refresh_token)}&client_id=${clientId}` }),
      reuse.res,
    );
    expect(reuse.statusCode()).toBe(400);
    expect(reuse.body()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a wrong PKCE verifier', async () => {
    const clientId = await registerClient();
    const code = await mintCode(clientId);
    const { res, statusCode, body } = makeRes();
    await tokenHandler(
      makeReq('POST', {
        body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT)}&client_id=${clientId}&code_verifier=WRONG`,
      }),
      res,
    );
    expect(statusCode()).toBe(400);
    expect(body()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects an expired code', async () => {
    const clientId = await registerClient();
    const code = await mintCode(clientId);
    tables.oauth_codes[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const { res, statusCode, body } = makeRes();
    await tokenHandler(
      makeReq('POST', {
        body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT)}&client_id=${clientId}&code_verifier=${VERIFIER}`,
      }),
      res,
    );
    expect(statusCode()).toBe(400);
    expect(body()).toMatchObject({ error: 'invalid_grant' });
  });
});
