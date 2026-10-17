// Apple Health's daily metrics against the LOCAL Supabase stack (W16 M3b):
// consent per category, piecemeal merging, null clears, body weight that
// never moves backwards — and the Profile weight save landing under the
// CHECK phase59 put on body_weight_source (the M0 review's guard).
//
// Requires: supabase start + scripts/db-reset-local.sh, then
//   APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Skipped entirely when APEX_LOCAL_SUPABASE is unset.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../../scripts/lib/localEnv.mjs';
import acceptanceHandler from '../../_lib/handlers/termsAcceptance';
import providerSyncHandler from '../../_lib/handlers/providerSync';
import dailyMetricsHandler from '../../_lib/handlers/dailyMetrics';
import profileHandler from '../../_lib/handlers/profile';
import { fetchPhysiologyInputs } from '../../_lib/coach/physiology';
import { localDate } from '../../_lib/userTimezone';

const RUN = !!process.env.APEX_LOCAL_SUPABASE;
const TZ = 'America/New_York';

function makeRes() {
  const captured = { statusCode: 200, body: undefined as unknown };
  const res = {
    setHeader: () => res,
    status(code: number) { captured.statusCode = code; return res; },
    json(body: unknown) { captured.body = body; return res; },
    send(body: unknown) { captured.body = body; return res; },
    end: () => res,
  } as unknown as VercelResponse;
  return { captured, res };
}

function makeReq(method: string, token: string, body?: unknown, query: Record<string, string> = {}): VercelRequest {
  return { method, headers: { authorization: `Bearer ${token}` }, query, body, cookies: {} } as unknown as VercelRequest;
}

describe.skipIf(!RUN)('daily metrics against the local stack', () => {
  let admin: SupabaseClient;
  let agent: { token: string; userId: string };
  const today = localDate(TZ);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  async function call(handler: (req: VercelRequest, res: VercelResponse) => Promise<void>, req: VercelRequest) {
    const { captured, res } = makeRes();
    await handler(req, res);
    return captured;
  }
  const post = (days: unknown[]) =>
    call(dailyMetricsHandler, makeReq('POST', agent.token, { provider: 'apple', timezone: TZ, days }));
  const connect = (categories: Record<string, boolean>) =>
    call(providerSyncHandler, makeReq('POST', agent.token, { action: 'connect', provider: 'apple', client: 'ios', timezone: TZ, categories }));
  const profileRow = async () => (await admin.from('profiles')
    .select('body_weight_lb, body_weight_updated_at, body_weight_source').eq('id', agent.userId).single()).data!;

  beforeAll(async () => {
    const env = localSupabaseEnv();
    process.env.VITE_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey;
    admin = createClient(env.url, env.serviceKey);
    const email = `daily-metrics-${Date.now()}@apex.local`;
    const password = 'apex-daily-password';
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !created.user) throw new Error(`user create failed: ${error?.message}`);
    const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    agent = { token: (await res.json() as { access_token: string }).access_token, userId: created.user.id };
    await call(acceptanceHandler, makeReq('POST', agent.token));
  });

  afterAll(async () => {
    if (!admin || !agent) return;
    await admin.from('daily_metrics').delete().eq('user_id', agent.userId);
    await admin.from('provider_connections').delete().eq('user_id', agent.userId);
    const { error } = await admin.auth.admin.deleteUser(agent.userId);
    expect(error).toBeNull();
  });

  it('a Profile weight save lands, stamped as the athlete\'s own', async () => {
    const r = await call(profileHandler, makeReq('PATCH', agent.token, { body_weight_lb: 180 }));
    expect(r.statusCode).toBe(200);
    const row = await profileRow();
    expect(row).toMatchObject({ body_weight_lb: 180, body_weight_source: 'user' });
    expect(row.body_weight_updated_at).not.toBeNull();
  });

  it('refuses without a connection, and without the category each field needs', async () => {
    const before = await post([{ date: yesterday, steps: 9000 }]);
    expect(before.statusCode).toBe(409);
    expect(before.body).toEqual({ error: 'not-connected' });

    await connect({ workoutsRead: true, dailyMetrics: true, bodyMass: false });
    const weight = await post([{ date: yesterday, bodyMassLb: 181, bodyMassAt: `${yesterday}T12:00:00Z` }]);
    expect(weight.statusCode).toBe(409);
    expect(weight.body).toEqual({ error: 'category-off', category: 'bodyMass' });
    // Nothing was written for the refused batch.
    const { count } = await admin.from('daily_metrics').select('date', { count: 'exact', head: true }).eq('user_id', agent.userId);
    expect(count).toBe(0);
  });

  it('a day arrives in pieces: absent fields stay, null clears', async () => {
    expect((await post([{ date: yesterday, steps: 9120 }])).body).toEqual({ ok: true, upserted: 1 });
    expect((await post([{ date: yesterday, sleepMinutes: 432, hrvSdnnMs: 48.5, restingHr: 52 }])).statusCode).toBe(200);
    const { data: merged } = await admin.from('daily_metrics').select('steps, sleep_minutes, hrv_sdnn_ms, resting_hr')
      .eq('user_id', agent.userId).eq('date', yesterday).single();
    expect(merged).toEqual({ steps: 9120, sleep_minutes: 432, hrv_sdnn_ms: 48.5, resting_hr: 52 });

    await post([{ date: yesterday, steps: null }]);
    const { data: cleared } = await admin.from('daily_metrics').select('steps, sleep_minutes')
      .eq('user_id', agent.userId).eq('date', yesterday).single();
    expect(cleared).toEqual({ steps: null, sleep_minutes: 432 });
  });

  it('body weight never moves backwards: an older weigh-in leaves the newer manual entry', async () => {
    await connect({ bodyMass: true });
    const older = await post([{ date: yesterday, bodyMassLb: 185, bodyMassAt: `${yesterday}T06:00:00Z` }]);
    expect(older.body).toEqual({ ok: true, upserted: 1 });
    expect(await profileRow()).toMatchObject({ body_weight_lb: 180, body_weight_source: 'user' });

    const newerAt = new Date(Date.now() + 60_000).toISOString();
    const newer = await post([{ date: today, bodyMassLb: 178.46, bodyMassAt: newerAt }]);
    expect(newer.body).toEqual({ ok: true, upserted: 1, profileBodyWeightLb: 178.46 });
    expect(await profileRow()).toMatchObject({ body_weight_lb: 178.46, body_weight_source: 'apple' });
    expect(Date.parse((await profileRow()).body_weight_updated_at as string)).toBe(Date.parse(newerAt));
  });

  it('GET reads the days back, oldest first', async () => {
    const r = await call(dailyMetricsHandler, makeReq('GET', agent.token, undefined, { start: yesterday, end: today }));
    expect(r.statusCode).toBe(200);
    const days = (r.body as { days: Array<Record<string, unknown>> }).days;
    expect(days.map(d => d.date)).toEqual([yesterday, today]);
    expect(days[0]).toMatchObject({ provider: 'apple', sleepMinutes: 432, hrvSdnnMs: 48.5, restingHr: 52, steps: null, bodyMassLb: 185 });
    const bad = await call(dailyMetricsHandler, makeReq('GET', agent.token, undefined, { start: '2025-01-01', end: today }));
    expect(bad.statusCode).toBe(400);
  });

  it('the coach reads them: the physiology inputs carry the days', async () => {
    const inputs = await fetchPhysiologyInputs(admin as never, agent.userId, today);
    expect(inputs.dailyMetrics?.find(d => d.date === yesterday)).toMatchObject({ sleepMinutes: 432, hrvSdnnMs: 48.5, restingHr: 52 });
  });

  it('disconnect with purgeMetrics removes them', async () => {
    const r = await call(providerSyncHandler, makeReq('POST', agent.token, { action: 'disconnect', provider: 'apple', purgeMetrics: true }));
    expect((r.body as { purged: { dailyMetrics: number } }).purged.dailyMetrics).toBe(2);
    const { count } = await admin.from('daily_metrics').select('date', { count: 'exact', head: true }).eq('user_id', agent.userId);
    expect(count).toBe(0);
  });
});
