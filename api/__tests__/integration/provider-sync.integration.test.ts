// Provider-sync integration tests against the LOCAL Supabase stack — real
// connection row, real preview matching over the seeded schedule, real
// apply writes (completions / sessions / cardio logs / streams / ledger)
// with only the COROS MCP client stubbed. Proves the two-phase flow and
// its idempotency end to end.
//
// Requires: supabase start + scripts/db-reset-local.sh, then
//   APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Skipped entirely when APEX_LOCAL_SUPABASE is unset.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ProviderActivity } from '../../_lib/providers/coros/client';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../../scripts/lib/localEnv.mjs';

const RUN = !!process.env.APEX_LOCAL_SUPABASE;

// Two fixture activities: a trail run that should FILL a planned run, and a
// bike ride with nothing planned that should CREATE a standalone event.
const RUN_START_UTC = new Date(Date.now() - 6 * 3600_000).toISOString();
const RIDE_START_UTC = new Date(Date.now() - 4 * 3600_000).toISOString();

const ACTIVITIES: ProviderActivity[] = [
  {
    provider: 'coros', activityId: 'it-449021', sport: 102,
    startUtc: RUN_START_UTC, durationSec: 2820,
    distanceMeters: 8368.6, elevationGainMeters: 250, avgHr: 152, maxHr: 176, calories: 512,
    summaryExtras: { trainingLoad: 87 },
    streams: { hr: [[0, 120], [30, 140], [60, 150]] },
  },
  {
    provider: 'coros', activityId: 'it-449022', sport: 200,
    startUtc: RIDE_START_UTC, durationSec: 5400,
    distanceMeters: 30000, avgHr: 138,
    summaryExtras: {},
  },
];

vi.mock('../../_lib/providers/coros/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../_lib/providers/coros/client.js')>();
  class StubCorosClient {
    async fetchRecentActivities() { return ACTIVITIES; }
    async fetchActivityDetail() { return null; }
  }
  return { ...original, CorosClient: StubCorosClient };
});

// Imported AFTER the mock so sync.ts binds the stub.
const { default: providerSyncHandler } = await import('../../_lib/handlers/providerSync');

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

function makeReq(body: unknown, token: string): VercelRequest {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    query: {},
    body,
    cookies: {},
  } as unknown as VercelRequest;
}

const TZ = 'America/Los_Angeles';

function localDateOf(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(iso));
}

describe.skipIf(!RUN)('provider-sync against the local stack', () => {
  let env: { url: string; anonKey: string; serviceKey: string };
  let agent: { token: string; userId: string };
  let admin: SupabaseClient;
  const runLocalDate = localDateOf(RUN_START_UTC);
  const plannedEventId = 'it-planned-run';

  beforeAll(async () => {
    env = localSupabaseEnv();
    process.env.VITE_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey;

    const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'agent@apex.local', password: 'apex-agent-password' }),
    });
    if (!res.ok) throw new Error(`sign-in failed: ${await res.text()}`);
    const data = await res.json() as { access_token: string; user: { id: string } };
    agent = { token: data.access_token, userId: data.user.id };
    admin = createClient(env.url, env.serviceKey);

    // A connected COROS row. No API_KEY_ENCRYPTION_SECRET in the test env,
    // so the plaintext token round-trips through unsealed().
    await admin.from('provider_connections').upsert({
      user_id: agent.userId, provider: 'coros',
      access_token: 'stub-token', refresh_token: 'stub-refresh',
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      status: 'connected', connected_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider' });

    // A planned run on the trail run's local date, so preview proposes a fill.
    await admin.from('workout_events').insert({
      user_id: agent.userId, id: plannedEventId, type: 'cardio',
      title: 'Planned Morning Run', date: runLocalDate, start_time: '6:30 AM',
      estimated_duration: 45, description: '', warmup: [], cooldown: [],
      exercises: [{ id: 'run-ex', name: 'Trail Run', category: 'cardio', duration: '45 min' }],
      difficulty: 3, tags: [], equipment: [], is_recurring: false,
    });
  });

  afterAll(async () => {
    if (!admin) return;
    const uid = agent.userId;
    const createdId = 'coros-it-449022';
    await admin.from('provider_activity_imports').delete().eq('user_id', uid).in('activity_id', ['it-449021', 'it-449022']);
    await admin.from('activity_streams').delete().eq('user_id', uid).in('event_id', [plannedEventId, createdId]);
    for (const table of ['workout_cardio_logs', 'workout_sessions', 'workout_completion_log', 'workout_completions']) {
      await admin.from(table).delete().eq('user_id', uid).in('event_id', [plannedEventId, createdId]);
    }
    await admin.from('event_mutations_log').delete().eq('user_id', uid).eq('event_id', createdId);
    await admin.from('workout_events').delete().eq('user_id', uid).in('id', [plannedEventId, createdId]);
    await admin.from('provider_connections').delete().eq('user_id', uid).eq('provider', 'coros');
  });

  it('preview proposes a fill for the planned run and a create for the ride', async () => {
    const { captured, res } = makeRes();
    await providerSyncHandler(makeReq({ action: 'preview', provider: 'coros', timezone: TZ }, agent.token), res);
    expect(captured.statusCode).toBe(200);
    const { proposals } = captured.body as { proposals: Array<{ activity: { activityId: string }; match: { eventId: string } | null }> };
    expect(proposals).toHaveLength(2);

    const runProposal = proposals.find(p => p.activity.activityId === 'it-449021');
    expect(runProposal?.match?.eventId).toBe(plannedEventId);
    const rideProposal = proposals.find(p => p.activity.activityId === 'it-449022');
    expect(rideProposal?.match).toBeNull();
  });

  it('apply fills the planned run and creates the ride, writing every table', async () => {
    const { captured, res } = makeRes();
    await providerSyncHandler(makeReq({
      action: 'apply', provider: 'coros', timezone: TZ,
      decisions: [
        { activityId: 'it-449021', action: 'fill', targetEventId: plannedEventId, eventDate: runLocalDate },
        { activityId: 'it-449022', action: 'create' },
      ],
    }, agent.token), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({ created: 1, filled: 1, errors: [] });

    const uid = agent.userId;

    // Fill: the planned event row is untouched, actuals landed beside it.
    const { data: planned } = await admin.from('workout_events').select('title, source').eq('user_id', uid).eq('id', plannedEventId).single();
    expect(planned).toEqual({ title: 'Planned Morning Run', source: null });

    const { data: completion } = await admin.from('workout_completions').select('is_completed, event_title').eq('user_id', uid).eq('event_id', plannedEventId).single();
    expect(completion).toMatchObject({ is_completed: true, event_title: 'Planned Morning Run' });

    const { data: cardio } = await admin.from('workout_cardio_logs').select('*').eq('user_id', uid).eq('event_id', plannedEventId);
    expect(cardio).toHaveLength(1);
    expect(cardio![0]).toMatchObject({
      exercise_id: 'run-ex', distance: '5.20 mi', elevation_gain: '820 ft',
      avg_heart_rate: 152, is_autofilled: false,
    });

    const { data: streams } = await admin.from('activity_streams').select('summary, streams').eq('user_id', uid).eq('event_id', plannedEventId).single();
    expect((streams!.summary as Record<string, unknown>).trainingLoad).toBe(87);
    expect((streams!.streams as Record<string, unknown>).hr).toHaveLength(3);

    // Create: a completed standalone event with provenance.
    const { data: created } = await admin.from('workout_events').select('type, title, subtitle, source, date').eq('user_id', uid).eq('id', 'coros-it-449022').single();
    expect(created).toMatchObject({ type: 'cardio', title: 'Bike', subtitle: 'Synced from COROS', source: 'coros' });

    const { data: rideCompletion } = await admin.from('workout_completions').select('is_completed').eq('user_id', uid).eq('event_id', 'coros-it-449022').single();
    expect(rideCompletion!.is_completed).toBe(true);

    // Ledger has both; the watermark moved.
    const { data: ledger } = await admin.from('provider_activity_imports').select('activity_id, mode').eq('user_id', uid).order('activity_id');
    expect(ledger).toEqual([
      { activity_id: 'it-449021', mode: 'filled' },
      { activity_id: 'it-449022', mode: 'created' },
    ]);
    const { data: conn } = await admin.from('provider_connections').select('last_synced_at').eq('user_id', uid).eq('provider', 'coros').single();
    expect(conn!.last_synced_at).not.toBeNull();
  });

  it('a second preview proposes nothing and a repeat apply converges', async () => {
    const preview = makeRes();
    await providerSyncHandler(makeReq({ action: 'preview', provider: 'coros', timezone: TZ }, agent.token), preview.res);
    expect((preview.captured.body as { proposals: unknown[] }).proposals).toHaveLength(0);

    const apply = makeRes();
    await providerSyncHandler(makeReq({
      action: 'apply', provider: 'coros', timezone: TZ,
      decisions: [{ activityId: 'it-449021', action: 'fill', targetEventId: plannedEventId, eventDate: runLocalDate }],
    }, agent.token), apply.res);
    // Already ledgered — skipped silently, nothing double-written.
    expect(apply.captured.body).toMatchObject({ created: 0, filled: 0, errors: [] });

    const { data: cardio } = await admin.from('workout_cardio_logs').select('event_id').eq('user_id', agent.userId).eq('event_id', plannedEventId);
    expect(cardio).toHaveLength(1);
  });
});
