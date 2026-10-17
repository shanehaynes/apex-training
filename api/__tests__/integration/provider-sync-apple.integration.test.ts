// Apple Health through provider-sync against the LOCAL Supabase stack (W16
// M2b): the phone is the provider, so there is nothing to stub — the
// activities are the request body. Proves preview / apply (fill, create,
// skip) / ingest, replay, the batch-not-watermark window, and the dedup that
// keeps a Watch workout from becoming a second copy of an Apex session.
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
import { APEX_BUNDLE_ID } from '../../_lib/providers/apple/activity';

const RUN = !!process.env.APEX_LOCAL_SUPABASE;
const TZ = 'America/Los_Angeles';
const HOUR = 3600_000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

function localDateOf(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function workout(id: string, startMs: number, durationSec: number, activityType: number, extra: Record<string, unknown> = {}) {
  return {
    activityId: id, activityType, activityName: 'Workout', sourceBundleId: 'com.apple.health.watch', sourceName: 'Apple Watch',
    startUtc: iso(startMs), endUtc: iso(startMs + durationSec * 1000), durationSec,
    avgHr: 140, streams: { hr: [[0, 120], [60, 140]] }, ...extra,
  };
}

// A run five days ago that should FILL its planned run; a ride with nothing
// planned to CREATE; a walk the athlete declines (SKIP); a strength session
// recorded on the Watch while Apex's own tracker ran (DUPLICATE); one still
// overlapping an open tracker session (IN-PROGRESS); one Apex wrote itself.
const RUN_START = now - 5 * 24 * HOUR;
const RIDE_START = now - 3 * HOUR;
const WALK_START = now - 2 * 24 * HOUR;
const TRACKED_START = now - 26 * HOUR;
const OPEN_START = now - 20 * 60_000;
// An overdue workout tracked this morning: its occurrence is dated ten days
// ago, but the session ran today — dedup goes by when it ran.
const OVERDUE_START = now - 6 * HOUR;

const ACT = {
  run: workout('it-apple-run', RUN_START, 2700, 37),
  ride: workout('it-apple-ride', RIDE_START, 3600, 13),
  walk: workout('it-apple-walk', WALK_START, 1800, 52),
  dupe: workout('it-apple-dupe', TRACKED_START + 5 * 60_000, 2400, 50),
  open: workout('it-apple-open', OPEN_START + 2 * 60_000, 300, 63),
  own: workout('it-apple-own', now - 30 * HOUR, 1800, 50, { sourceBundleId: APEX_BUNDLE_ID, sourceName: 'Apex' }),
  overdue: workout('it-apple-overdue', OVERDUE_START + 2 * 60_000, 3000, 50),
};
const ALL_IDS = Object.values(ACT).map(a => a.activityId);

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
  return { method: 'POST', headers: { authorization: `Bearer ${token}` }, query: {}, body, cookies: {} } as unknown as VercelRequest;
}

describe.skipIf(!RUN)('provider-sync: Apple Health against the local stack', () => {
  let admin: SupabaseClient;
  let agent: { token: string; userId: string };
  const plannedRunId = 'it-apple-planned-run';
  const plannedRideId = 'it-apple-planned-ride';

  async function sync(body: Record<string, unknown>) {
    const { captured, res } = makeRes();
    await providerSyncHandler(makeReq({ provider: 'apple', client: 'ios', timezone: TZ, ...body }, agent.token), res);
    return captured;
  }

  beforeAll(async () => {
    const env = localSupabaseEnv();
    process.env.VITE_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey;
    admin = createClient(env.url, env.serviceKey);

    // A throwaway user (the COROS suite's reason: imports are PR-bearing).
    const email = `apple-sync-${Date.now()}@apex.local`;
    const password = 'apex-apple-password';
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !created.user) throw new Error(`user create failed: ${error?.message}`);
    const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    agent = { token: (await res.json() as { access_token: string }).access_token, userId: created.user.id };
    const accepted = makeRes();
    await acceptanceHandler(makeReq(undefined, agent.token), accepted.res);

    const uid = agent.userId;
    await admin.from('workout_events').insert([
      {
        user_id: uid, id: plannedRunId, type: 'cardio', title: 'Planned Long Run', date: localDateOf(RUN_START),
        start_time: null, estimated_duration: 45, description: '', warmup: [], cooldown: [],
        exercises: [{ id: 'run-ex', name: 'Run', category: 'cardio', duration: '45 min' }],
        difficulty: 3, tags: [], equipment: [], is_recurring: false,
      },
      {
        // For ingest: a planned ride on today's date, so the ingested ride
        // matches it and must wait for the athlete rather than be filled.
        user_id: uid, id: plannedRideId, type: 'cardio', title: 'Planned Ride', date: localDateOf(RIDE_START),
        start_time: null, estimated_duration: 60, description: '', warmup: [], cooldown: [],
        exercises: [{ id: 'ride-ex', name: 'Ride', category: 'cardio', duration: '60 min' }],
        difficulty: 3, tags: [], equipment: [], is_recurring: false,
      },
    ]);
    // Apex's own tracker: one finished session the Watch also recorded, and
    // one still running.
    await admin.from('workout_sessions').insert([
      { user_id: uid, event_id: 'it-apple-tracked', event_date: localDateOf(TRACKED_START),
        started_at: iso(TRACKED_START), finished_at: iso(TRACKED_START + 50 * 60_000), total_duration_seconds: 3000 },
      { user_id: uid, event_id: 'it-apple-open-session', event_date: localDateOf(OPEN_START),
        started_at: iso(OPEN_START), finished_at: null },
      { user_id: uid, event_id: 'it-apple-overdue-session', event_date: localDateOf(now - 10 * 24 * HOUR),
        started_at: iso(OVERDUE_START), finished_at: iso(OVERDUE_START + 55 * 60_000), total_duration_seconds: 3300 },
    ]);
  });

  afterAll(async () => {
    if (!admin || !agent) return;
    const uid = agent.userId;
    const created = ALL_IDS.map(id => `apple-${id}`);
    const events = [plannedRunId, plannedRideId, ...created];
    await admin.from('provider_activity_imports').delete().eq('user_id', uid);
    await admin.from('activity_streams').delete().eq('user_id', uid);
    for (const table of ['workout_cardio_logs', 'workout_sessions', 'workout_completion_log', 'workout_completions']) {
      await admin.from(table).delete().eq('user_id', uid);
    }
    await admin.from('event_mutations_log').delete().eq('user_id', uid);
    await admin.from('workout_events').delete().eq('user_id', uid).in('id', events);
    await admin.from('provider_connections').delete().eq('user_id', uid);
    const { error } = await admin.auth.admin.deleteUser(uid);
    expect(error).toBeNull();
  });

  it('connects with Health categories, and a watermark that has moved changes nothing', async () => {
    const connected = await sync({ action: 'connect', categories: { workoutsRead: true, workoutsWrite: true } });
    expect(connected.statusCode).toBe(200);
    // Pretend a sync already happened today: a COROS-style watermark would
    // now hide a five-day-old workout. Apple's window comes from the batch.
    await admin.from('provider_connections').update({ last_synced_at: iso(now) }).eq('user_id', agent.userId).eq('provider', 'apple');
  });

  it('preview: the run matches its plan five days on, the ride stands alone, and the rest are set aside with reasons', async () => {
    const preview = await sync({ action: 'preview', activities: Object.values(ACT) });
    expect(preview.statusCode).toBe(200);
    const body = preview.body as {
      proposals: Array<{ activity: { activityId: string; apexType: string; sportLabel: string }; match: { eventId: string } | null }>;
      skipped: Array<{ activityId: string; reason: string }>;
    };
    const byId = Object.fromEntries(body.proposals.map(p => [p.activity.activityId, p]));
    expect(byId['it-apple-run'].match?.eventId).toBe(plannedRunId);
    expect(byId['it-apple-ride'].match?.eventId).toBe(plannedRideId);
    expect(byId['it-apple-walk']).toMatchObject({ activity: { sportLabel: 'Walk', apexType: 'cardio' }, match: null });
    expect(Object.fromEntries(body.skipped.map(s => [s.activityId, s.reason]))).toEqual({
      'it-apple-dupe': 'duplicate',
      'it-apple-open': 'in-progress',
      'it-apple-own': 'own-app',
      'it-apple-overdue': 'duplicate',
    });
    // Preview writes nothing.
    const { data: ledger } = await admin.from('provider_activity_imports').select('activity_id').eq('user_id', agent.userId);
    expect(ledger).toEqual([]);
  });

  it('apply fills the run, creates the ride, records the declined walk, and refuses the duplicate', async () => {
    const apply = await sync({
      action: 'apply',
      activities: Object.values(ACT),
      decisions: [
        { activityId: 'it-apple-run', action: 'fill', targetEventId: plannedRunId, eventDate: localDateOf(RUN_START) },
        { activityId: 'it-apple-ride', action: 'create' },
        { activityId: 'it-apple-walk', action: 'skip' },
        { activityId: 'it-apple-dupe', action: 'create' },
      ],
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.body).toEqual({
      created: 1, filled: 1, skipped: 1,
      errors: [{ activityId: 'it-apple-dupe', error: 'duplicate' }],
    });

    const uid = agent.userId;
    const { data: created } = await admin.from('workout_events').select('type, title, subtitle, source').eq('user_id', uid).eq('id', 'apple-it-apple-ride').single();
    expect(created).toEqual({ type: 'cardio', title: 'Ride', subtitle: 'Synced from Apple Health', source: 'apple' });
    const { data: streams } = await admin.from('activity_streams').select('provider, streams').eq('user_id', uid).eq('event_id', plannedRunId).single();
    expect(streams).toMatchObject({ provider: 'apple', streams: { hr: [[0, 120], [60, 140]] } });

    const { data: ledger } = await admin.from('provider_activity_imports').select('activity_id, mode, event_id, event_date')
      .eq('user_id', uid).order('activity_id');
    expect(ledger).toEqual([
      { activity_id: 'it-apple-ride', mode: 'created', event_id: 'apple-it-apple-ride', event_date: localDateOf(RIDE_START) },
      { activity_id: 'it-apple-run', mode: 'filled', event_id: plannedRunId, event_date: localDateOf(RUN_START) },
      // A skip writes the decision and nothing else.
      { activity_id: 'it-apple-walk', mode: 'skipped', event_id: '-', event_date: localDateOf(WALK_START) },
    ]);
    const { count: walkEvents } = await admin.from('workout_events').select('id', { count: 'exact', head: true })
      .eq('user_id', uid).eq('id', 'apple-it-apple-walk');
    expect(walkEvents).toBe(0);
  });

  it('a replay changes nothing: everything decided reads as already-imported', async () => {
    const preview = await sync({ action: 'preview', activities: [ACT.run, ACT.ride, ACT.walk] });
    expect((preview.body as { proposals: unknown[] }).proposals).toEqual([]);
    expect((preview.body as { skipped: Array<{ reason: string }> }).skipped.map(s => s.reason))
      .toEqual(['already-imported', 'already-imported', 'already-imported']);

    const again = await sync({
      action: 'apply', activities: [ACT.run],
      decisions: [{ activityId: 'it-apple-run', action: 'fill', targetEventId: plannedRunId, eventDate: localDateOf(RUN_START) }],
    });
    expect(again.body).toMatchObject({ created: 0, filled: 0, errors: [] });
    const { data: cardio } = await admin.from('workout_cardio_logs').select('event_id').eq('user_id', agent.userId).eq('event_id', plannedRunId);
    expect(cardio).toHaveLength(1);
  });

  it('ingest never fills: a match waits, the duplicate is ledgered, the in-progress one is not', async () => {
    // A second ride later today, after the first one ended (one that overlapped
    // it would be a second copy of it — a duplicate). The planned ride is
    // still open: the first ride was created, not filled.
    const lateRide = workout('it-apple-late-ride', RIDE_START + 90 * 60_000, 1800, 13);
    const ingest = await sync({ action: 'ingest', activities: [lateRide, ACT.dupe, ACT.open] });
    expect(ingest.statusCode).toBe(200);
    const body = ingest.body as {
      created: number; pending: Array<{ activity: { activityId: string }; match: { eventId: string } }>;
      skipped: Array<{ activityId: string; reason: string }>; errors: unknown[];
    };
    expect(body.created).toBe(0);
    expect(body.pending.map(p => [p.activity.activityId, p.match.eventId])).toEqual([['it-apple-late-ride', plannedRideId]]);
    expect(body.skipped).toEqual([
      { activityId: 'it-apple-dupe', reason: 'duplicate' },
      { activityId: 'it-apple-open', reason: 'in-progress' },
    ]);

    const uid = agent.userId;
    const { data: rows } = await admin.from('provider_activity_imports').select('activity_id, mode')
      .eq('user_id', uid).in('activity_id', ['it-apple-dupe', 'it-apple-open', 'it-apple-late-ride']);
    expect(rows).toEqual([{ activity_id: 'it-apple-dupe', mode: 'skipped' }]);
    const { data: conn } = await admin.from('provider_connections').select('pending_fill_count, auto_sync')
      .eq('user_id', uid).eq('provider', 'apple').single();
    expect(conn).toEqual({ pending_fill_count: 1, auto_sync: false });
  });

  it('once the open session finishes, the same workout is a duplicate', async () => {
    await admin.from('workout_sessions').update({ finished_at: iso(now) })
      .eq('user_id', agent.userId).eq('event_id', 'it-apple-open-session');
    const ingest = await sync({ action: 'ingest', activities: [ACT.open] });
    expect((ingest.body as { skipped: unknown[] }).skipped).toEqual([{ activityId: 'it-apple-open', reason: 'duplicate' }]);
  });

  it('the nightly cron never lists an Apple connection', async () => {
    const { listAutoSyncConnections } = await import('../../_lib/providers/connection');
    const rows = await listAutoSyncConnections(admin as never);
    expect(rows.filter(r => r.user_id === agent.userId)).toEqual([]);
  });
});
