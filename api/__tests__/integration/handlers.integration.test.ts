// Integration tests against the LOCAL Supabase stack — real GoTrue JWTs
// through requireUser, real RLS, real per-user scoping. This is the only
// layer that can prove cross-user isolation (the unit tests mock auth).
//
// Requires: supabase start + scripts/db-reset-local.sh, then
//   APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Skipped entirely (and instantly) when APEX_LOCAL_SUPABASE is unset, so
// plain `npm test` needs no Docker.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import eventsHandler from '../../events';
import completionsHandler from '../../completions';
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

describe.skipIf(!RUN)('api handlers against the local stack', () => {
  let env: { url: string; anonKey: string; serviceKey: string };
  let agent: { token: string; userId: string };
  let agent2: { token: string; userId: string };
  let admin: SupabaseClient;

  const EVENT_ID = 'itest-event-1';

  async function signIn(email: string, password: string) {
    const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`sign-in failed for ${email}: ${await res.text()}`);
    const data = await res.json();
    return { token: data.access_token as string, userId: data.user.id as string };
  }

  beforeAll(async () => {
    env = localSupabaseEnv();
    // The handlers read these at request time (getSupabaseAdmin).
    process.env.VITE_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey;

    agent = await signIn('agent@apex.local', 'apex-agent-password');
    agent2 = await signIn('agent2@apex.local', 'apex-agent-password');
    admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });

    await admin.from('workout_events').delete().eq('id', EVENT_ID);
  });

  afterAll(async () => {
    if (!RUN) return;
    await admin.from('workout_events').delete().eq('id', EVENT_ID);
    await admin.from('workout_completions').delete().eq('event_id', EVENT_ID);
  });

  it('rejects a request without a bearer token', async () => {
    const captured = makeRes();
    await eventsHandler(makeReq({ method: 'POST', body: { id: 'x', title: 'x' } }), captured.res);
    expect(captured.statusCode).toBe(401);
  });

  it('rejects a garbage token', async () => {
    const captured = makeRes();
    await eventsHandler(makeReq({ method: 'POST', token: 'not-a-jwt', body: { id: 'x', title: 'x' } }), captured.res);
    expect(captured.statusCode).toBe(401);
  });

  it('creates an event stamped with the verified uid, ignoring body user_id', async () => {
    const captured = makeRes();
    await eventsHandler(makeReq({
      method: 'POST',
      token: agent.token,
      body: {
        id: EVENT_ID, type: 'weights', title: 'Integration Test Lift',
        date: '2026-06-15', estimated_duration: 45, difficulty: 3,
        description: '', warmup: [], exercises: [], cooldown: [],
        tags: [], equipment: [], is_recurring: false,
        // A spoofed user_id must be ignored in favor of the JWT's uid.
        user_id: agent2.userId,
      },
    }), captured.res);
    expect(captured.statusCode).toBe(200);

    const { data } = await admin.from('workout_events').select('user_id,title').eq('id', EVENT_ID).single();
    expect(data?.user_id).toBe(agent.userId);
  });

  it('RLS: the owner reads the row, the other user reads nothing', async () => {
    const asUser = (token: string) => createClient(env.url, env.anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const own = await asUser(agent.token).from('workout_events').select('id').eq('id', EVENT_ID);
    expect(own.data?.length).toBe(1);

    const other = await asUser(agent2.token).from('workout_events').select('id').eq('id', EVENT_ID);
    expect(other.data?.length).toBe(0);

    const anon = await createClient(env.url, env.anonKey).from('workout_events').select('id').eq('id', EVENT_ID);
    expect(anon.data?.length ?? 0).toBe(0);
  });

  it('another user cannot patch the event', async () => {
    const captured = makeRes();
    await eventsHandler(makeReq({
      method: 'PATCH',
      token: agent2.token,
      query: { id: EVENT_ID },
      body: { fields: { title: 'Hijacked' }, log: { event_title: 'Hijacked' } },
    }), captured.res);
    // The handler scopes the update by the verified uid — 0 rows affected.
    expect(captured.statusCode).toBe(200);
    const { data } = await admin.from('workout_events').select('title').eq('id', EVENT_ID).single();
    expect(data?.title).toBe('Integration Test Lift');
  });

  it('completions upsert lands for the verified user only', async () => {
    const captured = makeRes();
    await completionsHandler(makeReq({
      method: 'POST',
      token: agent.token,
      body: {
        completionRow: {
          event_id: EVENT_ID, event_date: '2026-06-15', event_type: 'weights',
          event_title: 'Integration Test Lift', duration_minutes: 45,
          is_completed: true, completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        logRow: {
          event_id: EVENT_ID, event_date: '2026-06-15', event_type: 'weights',
          event_title: 'Integration Test Lift', duration_minutes: 45, action: 'complete',
        },
      },
    }), captured.res);
    expect(captured.statusCode).toBe(200);

    const { data } = await admin.from('workout_completions')
      .select('user_id,is_completed').eq('event_id', EVENT_ID).single();
    expect(data?.user_id).toBe(agent.userId);
    expect(data?.is_completed).toBe(true);
  });

  it('the owner deletes the event', async () => {
    const captured = makeRes();
    await eventsHandler(makeReq({
      method: 'DELETE', token: agent.token, query: { id: EVENT_ID },
      body: { log: { event_title: 'Integration Test Lift' } },
    }), captured.res);
    expect(captured.statusCode).toBe(200);

    const { data } = await admin.from('workout_events').select('id').eq('id', EVENT_ID);
    expect(data?.length).toBe(0);
  });
});
