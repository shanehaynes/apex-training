// Nightly auto-sync against the LOCAL Supabase stack — real connection
// row, real writes, only the COROS MCP client stubbed. Proves the
// decided behavior: unmatched activities import on their own, matches are
// NEVER auto-filled (counted into pending_fill_count instead), the
// watermark holds while fills are pending, and a night after a manual
// sync converges to a no-op.
//
// Requires: supabase start + scripts/db-reset-local.sh (phase29 applied),
//   then APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Skipped entirely when APEX_LOCAL_SUPABASE is unset.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ProviderActivity } from '../../_lib/providers/coros/client';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../../scripts/lib/localEnv.mjs';

const RUN = !!process.env.APEX_LOCAL_SUPABASE;

const RUN_START_UTC = new Date(Date.now() - 7 * 3600_000).toISOString();
const RIDE_START_UTC = new Date(Date.now() - 5 * 3600_000).toISOString();

const ACTIVITIES: ProviderActivity[] = [
  {
    provider: 'coros', activityId: 'cron-run-1', sport: 102,
    startUtc: RUN_START_UTC, durationSec: 2700, distanceMeters: 8000, avgHr: 150,
    summaryExtras: {},
  },
  {
    provider: 'coros', activityId: 'cron-ride-1', sport: 200,
    startUtc: RIDE_START_UTC, durationSec: 3600, distanceMeters: 25000, avgHr: 135,
    summaryExtras: {},
  },
];

vi.mock('../../_lib/providers/coros/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../_lib/providers/coros/client.js')>();
  class StubCorosClient {
    async fetchRecentActivities() { return ACTIVITIES; }
    async fetchActivityDetail() { return null; }
    async fetchFitStreams() { return null; }
  }
  return { ...original, CorosClient: StubCorosClient };
});

const { runAutoSync } = await import('../../_lib/providers/sync');

const TZ = 'America/Los_Angeles';

function localDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

describe.skipIf(!RUN)('runAutoSync against the local stack', () => {
  let admin: SupabaseClient;
  let userId: string;
  const plannedEventId = 'cron-planned-run';
  const runLocalDate = localDateOf(RUN_START_UTC);

  beforeAll(async () => {
    const env = localSupabaseEnv();
    process.env.VITE_SUPABASE_URL = env.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceKey;
    admin = createClient(env.url, env.serviceKey);

    // A dedicated user with NO seeded events: the seeded agent@apex.local
    // calendar is dense with planned cardio, which would nondeterministically
    // absorb this test's activities as matches — and the provider-sync
    // integration file shares that user in a parallel worker.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: `cron-agent-${Date.now()}@apex.local`,
      password: 'apex-cron-password',
      email_confirm: true,
    });
    if (createErr || !created.user) throw new Error(`user create failed: ${createErr?.message}`);
    userId = created.user.id;

    await admin.from('provider_connections').upsert({
      user_id: userId, provider: 'coros',
      access_token: 'stub-token', refresh_token: 'stub-refresh',
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      status: 'connected', connected_at: new Date().toISOString(),
      timezone: TZ, auto_sync: true,
    }, { onConflict: 'user_id,provider' });

    // A planned run on the trail run's local date → the nightly job must
    // NOT auto-fill it.
    await admin.from('workout_events').insert({
      user_id: userId, id: plannedEventId, type: 'cardio',
      title: 'Planned Run', date: runLocalDate, start_time: '6:00 AM',
      estimated_duration: 45, description: '', warmup: [], cooldown: [],
      exercises: [{ id: 'run-ex', name: 'Run', category: 'cardio' }],
      difficulty: 3, tags: [], equipment: [], is_recurring: false,
    });
  });

  afterAll(async () => {
    if (!admin) return;
    const createdId = 'coros-cron-ride-1';
    await admin.from('provider_activity_imports').delete().eq('user_id', userId).in('activity_id', ['cron-run-1', 'cron-ride-1']);
    await admin.from('activity_streams').delete().eq('user_id', userId).in('event_id', [plannedEventId, createdId]);
    for (const table of ['workout_cardio_logs', 'workout_sessions', 'workout_completion_log', 'workout_completions']) {
      await admin.from(table).delete().eq('user_id', userId).in('event_id', [plannedEventId, createdId]);
    }
    await admin.from('event_mutations_log').delete().eq('user_id', userId).eq('event_id', createdId);
    await admin.from('workout_events').delete().eq('user_id', userId).in('id', [plannedEventId, createdId]);
    await admin.from('provider_connections').delete().eq('user_id', userId).eq('provider', 'coros');
    await admin.auth.admin.deleteUser(userId);
  });

  it('imports the unmatched ride, counts the matched run as pending, holds the watermark', async () => {
    const outcome = await runAutoSync(admin as never, userId, 'coros', TZ);
    expect(outcome).toEqual({ created: 1, pendingFills: 1, errors: 0 });

    // The ride landed as a completed standalone event.
    const { data: ride } = await admin.from('workout_events').select('source, title').eq('user_id', userId).eq('id', 'coros-cron-ride-1').single();
    expect(ride).toMatchObject({ source: 'coros', title: 'Bike' });

    // The planned run is untouched: no completion, no ledger row.
    const { data: completion } = await admin.from('workout_completions').select('event_id').eq('user_id', userId).eq('event_id', plannedEventId);
    expect(completion).toEqual([]);
    const { data: ledger } = await admin.from('provider_activity_imports').select('activity_id').eq('user_id', userId);
    expect(ledger).toEqual([{ activity_id: 'cron-ride-1' }]);

    // Pending badge set; watermark held so the match can't age out.
    const { data: conn } = await admin.from('provider_connections').select('pending_fill_count, last_synced_at').eq('user_id', userId).eq('provider', 'coros').single();
    expect(conn).toEqual({ pending_fill_count: 1, last_synced_at: null });
  });

  it('a second night converges: nothing new, the match still pending', async () => {
    const outcome = await runAutoSync(admin as never, userId, 'coros', TZ);
    expect(outcome).toEqual({ created: 0, pendingFills: 1, errors: 0 });

    const { data: rides } = await admin.from('workout_cardio_logs').select('event_id').eq('user_id', userId).eq('event_id', 'coros-cron-ride-1');
    expect(rides).toHaveLength(1);
  });
});
