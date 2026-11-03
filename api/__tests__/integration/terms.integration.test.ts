// Integration tests for the clickwrap against the LOCAL Supabase stack. The
// unit tests mock the database, so they cannot see the two properties that
// actually live in Postgres:
//
//   1. The append-only trigger. It has to reject a direct UPDATE or DELETE
//      even from the service-role key, and still allow the DELETE that an
//      account deletion cascades. A blanket ban made accounts undeletable
//      (GoTrue: "Database error deleting user") — the audit log had become
//      undeletable in a way that broke legal/privacy-v1.md §5.
//   2. That deleting the auth user really does empty every table, including
//      phase32_quarantine, which has no foreign key and is swept by hand.
//
// Requires: supabase start + scripts/db-reset-local.sh, then
//   APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Skipped instantly when APEX_LOCAL_SUPABASE is unset.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import accountHandler, { NON_CASCADING_TABLES } from '../../_lib/handlers/account';
import acceptanceHandler from '../../_lib/handlers/termsAcceptance';
import eventsHandler from '../../_lib/handlers/events';
import { TERMS_REQUIRED_BODY } from '../../_lib/legal';
import { PRIVACY_VERSION, TERMS_VERSION } from '../../../src/lib/legal/versions';
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
  // The export streams (res.write per chunk, then res.end).
  const written: Buffer[] = [];
  const res = {
    setHeader: () => res,
    status(code: number) { captured.statusCode = code; return res; },
    json(body: unknown) { captured.body = body; return res; },
    send(body: unknown) { captured.body = body; return res; },
    write(chunk: string | Buffer) { written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
    end() { if (written.length) captured.body = Buffer.concat(written).toString('utf8'); return res; },
  } as unknown as VercelResponse;
  captured.res = res;
  return captured;
}

function makeReq(opts: {
  method: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): VercelRequest {
  return {
    method: opts.method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    query: {},
    body: opts.body,
    cookies: {},
  } as unknown as VercelRequest;
}

describe.skipIf(!RUN)('terms acceptance against the local stack', () => {
  let env: { url: string; anonKey: string; serviceKey: string };
  let admin: SupabaseClient;
  /** A throwaway user, so the shared stack's fixtures are never disturbed. */
  let subject: { token: string; userId: string };
  const EMAIL = 'itest-terms@apex.local';
  /** A second throwaway user, holding an acceptance of an earlier version. */
  const PRIOR_EMAIL = 'itest-terms-prior@apex.local';
  const PASSWORD = 'apex-agent-password';

  async function createSubject(email = EMAIL) {
    // Remove any leftover from an interrupted run before recreating.
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const stale = data?.users.find(u => u.email === email);
    if (stale) await admin.auth.admin.deleteUser(stale.id);

    const { data: created, error } = await admin.auth.admin.createUser({
      email, password: PASSWORD, email_confirm: true,
    });
    if (error || !created.user) throw new Error(`create failed: ${error?.message}`);

    const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const token = (await res.json() as { access_token: string }).access_token;
    return { token, userId: created.user.id };
  }

  beforeAll(async () => {
    env = localSupabaseEnv();
    process.env.VITE_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey;
    admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });
    subject = await createSubject();
  });

  afterAll(async () => {
    if (!RUN || !admin) return;
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
    for (const email of [EMAIL, PRIOR_EMAIL]) {
      const left = data?.users.find(u => u.email === email);
      if (left) await admin.auth.admin.deleteUser(left.id);
    }
  });

  it('gates a real handler behind a real JWT until the user accepts', async () => {
    const blocked = makeRes();
    await eventsHandler(makeReq({ method: 'GET', token: subject.token }), blocked.res);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body).toBe(TERMS_REQUIRED_BODY);

    const accept = makeRes();
    await acceptanceHandler(makeReq({
      method: 'POST',
      token: subject.token,
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'itest/1.0' },
    }), accept.res);
    expect(accept.statusCode).toBe(200);

    const after = makeRes();
    await eventsHandler(makeReq({ method: 'GET', token: subject.token }), after.res);
    expect(after.statusCode, 'past the gate — 400 is the handler\'s own validation').not.toBe(403);
  });

  it('an account that accepted terms-v1 and privacy-v1 is asked again, keeps its export, and one acceptance lets it through', async () => {
    // Every account created before the bump to terms-v2 / privacy-v2 holds
    // exactly this row. Inserted directly as a stand-in for an acceptance made
    // under v1: the append-only trigger refuses UPDATE and DELETE, not INSERT.
    const prior = await createSubject(PRIOR_EMAIL);
    const { error } = await admin.from('terms_acceptances').insert({
      user_id: prior.userId, terms_version: 'terms-v1', privacy_version: 'privacy-v1',
      accepted_at: '2026-10-20T12:00:00.000Z', ip: '192.0.2.1', user_agent: 'itest/v1',
    });
    expect(error).toBeNull();

    const blocked = makeRes();
    await eventsHandler(makeReq({ method: 'GET', token: prior.token }), blocked.res);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body).toBe(TERMS_REQUIRED_BODY);

    // What the web gate and the iPhone app (1.1.0 (561) on) read to raise the
    // prompt and to say what was accepted before.
    const status = makeRes();
    await acceptanceHandler(makeReq({ method: 'GET', token: prior.token }), status.res);
    expect(status.statusCode).toBe(200);
    expect(status.body).toMatchObject({
      accepted: { termsVersion: 'terms-v1', privacyVersion: 'privacy-v1' },
      current: false,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    });

    // Terms section 12: export keeps working while the user decides.
    const exported = makeRes();
    await accountHandler(makeReq({ method: 'GET', token: prior.token }), exported.res);
    expect(exported.statusCode).toBe(200);
    // Against real PostgREST: the key-paged reads and the sign-in record.
    const file = JSON.parse(exported.body as string);
    expect(file.userId).toBe(prior.userId);
    expect(file.account.email).toBe(PRIOR_EMAIL);
    expect(file.data.terms_acceptances.length).toBeGreaterThan(0);

    const accept = makeRes();
    await acceptanceHandler(makeReq({ method: 'POST', token: prior.token }), accept.res);
    expect(accept.statusCode).toBe(200);
    expect(accept.body).toMatchObject({
      accepted: { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
      current: true,
    });

    const after = makeRes();
    await eventsHandler(makeReq({ method: 'GET', token: prior.token }), after.res);
    // Past the gate and answered by the handler itself (its own validation
    // 400s a bare GET), not a 403 or a 503 from the gate.
    expect([200, 400], 'past the gate').toContain(after.statusCode);

    // The v1 row stands beside the new one as the record of what was agreed when.
    const { data } = await admin
      .from('terms_acceptances')
      .select('terms_version, privacy_version')
      .eq('user_id', prior.userId)
      .order('accepted_at', { ascending: true });
    expect(data).toEqual([
      { terms_version: 'terms-v1', privacy_version: 'privacy-v1' },
      { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION },
    ]);
  });

  it('stores the first x-forwarded-for hop, not the proxy', async () => {
    const { data } = await admin
      .from('terms_acceptances')
      .select('ip, user_agent, terms_version, privacy_version')
      .eq('user_id', subject.userId);
    expect(data?.[0]).toMatchObject({
      ip: '203.0.113.7',
      user_agent: 'itest/1.0',
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    });
  });

  it('rejects a direct UPDATE, even from the service-role key', async () => {
    const { error } = await admin
      .from('terms_acceptances')
      .update({ terms_version: 'tampered' })
      .eq('user_id', subject.userId);
    expect(error?.message ?? '').toMatch(/append-only/i);

    const { data } = await admin
      .from('terms_acceptances').select('terms_version').eq('user_id', subject.userId);
    expect(data?.[0].terms_version).toBe(TERMS_VERSION);
  });

  it('rejects a direct DELETE, even from the service-role key', async () => {
    const { error } = await admin
      .from('terms_acceptances').delete().eq('user_id', subject.userId);
    expect(error?.message ?? '').toMatch(/append-only/i);

    const { count } = await admin
      .from('terms_acceptances')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', subject.userId);
    expect(count).toBe(1);
  });

  it('a second acceptance inserts; the first survives untouched', async () => {
    const again = makeRes();
    await acceptanceHandler(makeReq({
      method: 'POST',
      token: subject.token,
      headers: { 'x-forwarded-for': '198.51.100.9', 'user-agent': 'itest/2.0' },
    }), again.res);
    expect(again.statusCode).toBe(200);

    const { data } = await admin
      .from('terms_acceptances')
      .select('ip, user_agent')
      .eq('user_id', subject.userId)
      .order('accepted_at', { ascending: true });
    expect(data).toHaveLength(2);
    expect(data?.[0]).toMatchObject({ ip: '203.0.113.7', user_agent: 'itest/1.0' });
    expect(data?.[1]).toMatchObject({ ip: '198.51.100.9', user_agent: 'itest/2.0' });
  });

  it('deleting the account empties every table, cascade and sweep alike', async () => {
    // A row in each: one that cascades, and one that does not.
    await admin.from('workout_events').insert({
      id: 'itest-terms-evt', user_id: subject.userId, type: 'weights',
      title: 'Delete me', date: '2026-06-15', estimated_duration: 30, difficulty: 2,
    });
    await admin.from(NON_CASCADING_TABLES[0]).insert({
      table_name: 'workout_sessions', user_id: subject.userId, event_id: 'itest-terms-evt',
      stale_date: '2026-06-01', target_date: '2026-06-15', row_data: { probe: true },
    });

    const deleted = makeRes();
    await accountHandler(
      makeReq({ method: 'DELETE', token: subject.token, body: { confirm: 'DELETE' } }),
      deleted.res,
    );
    expect(deleted.statusCode, 'the append-only trigger must not block the cascade').toBe(200);

    for (const table of ['terms_acceptances', 'workout_events', 'profiles', NON_CASCADING_TABLES[0]]) {
      const column = table === 'profiles' ? 'id' : 'user_id';
      const { count } = await admin
        .from(table).select(column, { count: 'exact', head: true }).eq(column, subject.userId);
      expect(count, `${table} still holds rows for a deleted account`).toBe(0);
    }

    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
    expect(data?.users.find(u => u.email === EMAIL)).toBeUndefined();
  });
});
