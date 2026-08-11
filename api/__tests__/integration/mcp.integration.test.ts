// MCP endpoint integration tests against the LOCAL Supabase stack — real
// token mint through the handler, real hash lookup, real tool queries with
// per-user scoping. Proves the PAT auth path end to end (the unit tests mock
// resolveMcpToken).
//
// Requires: supabase start + scripts/db-reset-local.sh, then
//   APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Skipped entirely when APEX_LOCAL_SUPABASE is unset.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import mcpHandler from '../../_lib/handlers/mcp';
import mcpTokensHandler from '../../_lib/handlers/mcpTokens';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../../scripts/lib/localEnv.mjs';

const RUN = !!process.env.APEX_LOCAL_SUPABASE;

interface CapturedResponse {
  statusCode: number;
  body: unknown;
  res: VercelResponse;
}

function makeRes(): CapturedResponse {
  const captured: CapturedResponse = { statusCode: 200, body: undefined, res: undefined as never };
  const res = {
    setHeader: () => res,
    status(code: number) { captured.statusCode = code; return res; },
    json(body: unknown) { captured.body = body; return res; },
    send(body: unknown) { captured.body = body; return res; },
    write: () => true,
    end: () => res,
  } as unknown as VercelResponse;
  captured.res = res;
  return captured;
}

function makeReq(opts: {
  method: string;
  token?: string;
  query?: Record<string, string>;
  body?: unknown;
}): VercelRequest {
  return {
    method: opts.method,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    query: opts.query ?? {},
    body: opts.body,
    cookies: {},
  } as unknown as VercelRequest;
}

const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: '2.0', id, method, params });

describe.skipIf(!RUN)('MCP endpoint against the local stack', () => {
  let env: { url: string; anonKey: string; serviceKey: string };
  let agent: { token: string; userId: string };
  let admin: SupabaseClient;
  let patToken: string;
  let patId: string;

  async function signIn(email: string, password: string) {
    const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`sign-in failed for ${email}: ${await res.text()}`);
    const data = await res.json() as { access_token: string; user: { id: string } };
    return { token: data.access_token, userId: data.user.id };
  }

  beforeAll(async () => {
    env = localSupabaseEnv();
    process.env.VITE_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey;

    agent = await signIn('agent@apex.local', 'apex-agent-password');
    admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });
    await admin.from('mcp_tokens').delete().eq('user_id', agent.userId);
  });

  afterAll(async () => {
    if (!RUN) return;
    await admin.from('mcp_tokens').delete().eq('user_id', agent.userId);
  });

  it('mints a PAT via the Supabase-JWT-authed handler', async () => {
    const captured = makeRes();
    await mcpTokensHandler(
      makeReq({ method: 'POST', token: agent.token, body: { name: 'itest' } }),
      captured.res,
    );
    expect(captured.statusCode).toBe(200);
    const body = captured.body as { id: string; token: string };
    expect(body.token).toMatch(/^apx_/);
    patToken = body.token;
    patId = body.id;

    // Only the hash landed in the row.
    const { data } = await admin.from('mcp_tokens').select('token_hash, token_last4').eq('id', patId).single();
    expect(data!.token_hash).not.toContain(patToken);
    expect(patToken.endsWith(data!.token_last4 as string)).toBe(true);
  });

  it('401s without a token and with a Supabase JWT (wrong credential type)', async () => {
    const a = makeRes();
    await mcpHandler(makeReq({ method: 'POST', body: rpc('ping') }), a.res);
    expect(a.statusCode).toBe(401);

    const b = makeRes();
    await mcpHandler(makeReq({ method: 'POST', token: agent.token, body: rpc('ping') }), b.res);
    expect(b.statusCode).toBe(401);
  });

  it('drives initialize → tools/list → tools/call with the minted PAT', async () => {
    const init = makeRes();
    await mcpHandler(makeReq({ method: 'POST', token: patToken, body: rpc('initialize', { protocolVersion: '2025-06-18' }) }), init.res);
    expect(init.statusCode).toBe(200);
    expect(init.body).toMatchObject({ result: { protocolVersion: '2025-06-18' } });

    const list = makeRes();
    await mcpHandler(makeReq({ method: 'POST', token: patToken, body: rpc('tools/list') }), list.res);
    const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools).toHaveLength(8);

    const call = makeRes();
    await mcpHandler(
      makeReq({
        method: 'POST',
        token: patToken,
        body: rpc('tools/call', { name: 'get_schedule', arguments: { start_date: '2026-06-01', end_date: '2026-06-30' } }),
      }),
      call.res,
    );
    expect(call.statusCode).toBe(200);
    const result = (call.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as { workouts: unknown[] };
    expect(Array.isArray(payload.workouts)).toBe(true);
  });

  it('stamped last_used_at on first use', async () => {
    // The stamp is fire-and-forget; give it a beat.
    await new Promise(r => setTimeout(r, 250));
    const { data } = await admin.from('mcp_tokens').select('last_used_at').eq('id', patId).single();
    expect(data!.last_used_at).not.toBeNull();
  });

  it('401s after revocation', async () => {
    const revoke = makeRes();
    await mcpTokensHandler(makeReq({ method: 'DELETE', token: agent.token, query: { id: patId } }), revoke.res);
    expect(revoke.statusCode).toBe(200);

    const after = makeRes();
    await mcpHandler(makeReq({ method: 'POST', token: patToken, body: rpc('ping') }), after.res);
    expect(after.statusCode).toBe(401);
  });
});
