import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchCompletionsInRange, fetchExpandedSchedule } from '../mcp/data.js';
import { getFreshAccessToken, NotConnectedError, recordSync, type SyncProvider } from './connection.js';
import { CorosClient, type ProviderActivity } from './coros/client.js';
import { mapSport } from './coros/mapSport.js';
import { McpAuthExpiredError, McpToolError } from './mcpHttp.js';
import { matchActivity, occurrenceKey } from '../../../src/lib/sync/matching.js';
import { minutesToDisplayTime } from '../../../src/lib/time.js';
import type { WorkoutEvent } from '../../../src/types/workout.js';
import type { Exercise } from '../../../src/types/workout.js';

// The two-phase activity grab.
//
// preview: fetch provider activities since the last grab (48 h overlap —
// a watch that synced late must not lose an activity), drop everything the
// imports ledger already decided, match the rest against the expanded
// planned schedule, and return proposals. Read-only: neither the ledger
// nor last_synced_at moves, so an abandoned preview changes nothing.
//
// apply: execute the user's per-activity decisions. Metrics are re-fetched
// from the provider (the client's copy is display-only), fill targets are
// re-validated server-side, and each activity's ledger row is written LAST
// so a mid-sequence crash re-proposes it — every earlier write is an
// upsert, so the retry converges instead of duplicating.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const FIRST_SYNC_DAYS = 30;
const OVERLAP_MS = 48 * 3600 * 1000;
const MAX_DECISIONS = 100;

// ─── Local-time conversion ───────────────────────────────────────────────────
// The schema stores floating dates + display-time strings and no timezone;
// the browser initiating the sync sends its IANA zone, which is authoritative.

export interface LocalInstant {
  date: string;       // YYYY-MM-DD
  minutes: number;    // since local midnight
  display: string;    // "6:32 AM"
}

export function utcToLocal(iso: string, timeZone: string): LocalInstant {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  // en-CA emits hour '24' for midnight in some runtimes; normalize.
  const hour = Number(parts.hour) % 24;
  const minutes = hour * 60 + Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes,
    display: minutesToDisplayTime(minutes),
  };
}

function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── Unit serialization (parseQuantity-compatible, records.ts) ───────────────

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

export function distanceLabel(meters: number | undefined): string | null {
  if (!meters || meters <= 0) return null;
  return `${(meters / METERS_PER_MILE).toFixed(2)} mi`;
}

export function elevationLabel(meters: number | undefined): string | null {
  if (!meters || meters <= 0) return null;
  return `${Math.round(meters * FEET_PER_METER)} ft`;
}

// ─── Shared context ──────────────────────────────────────────────────────────

interface SyncContext {
  activities: ProviderActivity[];
  occurrences: WorkoutEvent[];
  completedKeys: Set<string>;
  ledgerActivityIds: Set<string>;
  ledgerFilledKeys: Set<string>;
  windowStartIso: string;
}

async function loadSyncContext(
  supabase: Admin, userId: string, provider: SyncProvider, accessToken: string,
): Promise<SyncContext> {
  const now = Date.now();
  const floor = now - FIRST_SYNC_DAYS * 86_400_000;

  const { data: conn, error: connErr } = await supabase
    .from('provider_connections')
    .select('last_synced_at')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (connErr) throw new Error(`connection read failed: ${connErr.message}`);

  const lastSynced = conn?.last_synced_at ? Date.parse(conn.last_synced_at as string) : null;
  const windowStart = new Date(Math.max(floor, lastSynced ? lastSynced - OVERLAP_MS : floor));
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = new Date(now).toISOString();

  const client = new CorosClient(accessToken);
  const [activities, ledger, expanded, completions] = await Promise.all([
    client.fetchRecentActivities(windowStartIso, windowEndIso),
    supabase
      .from('provider_activity_imports')
      .select('activity_id, mode, event_id, event_date')
      .eq('user_id', userId)
      .eq('provider', provider),
    fetchExpandedSchedule(supabase, userId, windowStartIso.slice(0, 10)),
    fetchCompletionsInRange(supabase, userId, windowStartIso.slice(0, 10), windowEndIso.slice(0, 10)),
  ]);
  if (ledger.error) throw new Error(`ledger read failed: ${ledger.error.message}`);

  return {
    activities: activities.sort((a, b) => a.startUtc.localeCompare(b.startUtc)),
    occurrences: expanded.occurrences,
    completedKeys: new Set(
      completions.filter(c => c.is_completed).map(c => occurrenceKey(c.event_id, c.event_date)),
    ),
    ledgerActivityIds: new Set(ledger.data.map(r => r.activity_id as string)),
    ledgerFilledKeys: new Set(
      ledger.data.filter(r => r.mode === 'filled').map(r => occurrenceKey(r.event_id as string, r.event_date as string)),
    ),
    windowStartIso,
  };
}

// ─── Handler entry ───────────────────────────────────────────────────────────

export async function handleSyncAction(
  supabase: Admin,
  req: VercelRequest,
  res: VercelResponse,
  userId: string,
  provider: SyncProvider,
  action: 'preview' | 'apply',
): Promise<void> {
  const body = (req.body ?? {}) as { timezone?: unknown; decisions?: unknown };
  if (!isValidTimezone(body.timezone)) {
    res.status(400).send('A valid IANA timezone is required');
    return;
  }
  const timezone = body.timezone;

  let accessToken: string;
  try {
    accessToken = await getFreshAccessToken(supabase, userId, provider);
  } catch (err) {
    if (err instanceof NotConnectedError) {
      res.status(409).json({ error: err.reason === 'expired' ? 'connection-expired' : 'not-connected' });
      return;
    }
    throw err;
  }

  try {
    if (action === 'preview') {
      await handlePreview(supabase, res, userId, provider, accessToken, timezone);
    } else {
      await handleApply(supabase, req, res, userId, provider, accessToken, timezone);
    }
  } catch (err) {
    if (err instanceof McpAuthExpiredError) {
      res.status(409).json({ error: 'connection-expired' });
      return;
    }
    if (err instanceof McpToolError) {
      console.error(`[provider-sync] ${provider} MCP call failed:`, err.message);
      res.status(502).send('The COROS service did not answer as expected — try again shortly');
      return;
    }
    throw err;
  }
}

// ─── preview ─────────────────────────────────────────────────────────────────

interface Proposal {
  activity: {
    activityId: string;
    sportLabel: string;
    apexType: WorkoutEvent['type'];
    localDate: string;
    displayTime: string;
    durationMin: number;
    distance: string | null;
    avgHr: number | null;
  };
  match: { eventId: string; eventDate: string; title: string; startTime: string | null; type: string } | null;
}

function buildProposals(ctx: SyncContext, timezone: string): Proposal[] {
  const filled = new Set(ctx.ledgerFilledKeys);
  const proposals: Proposal[] = [];

  for (const activity of ctx.activities) {
    if (ctx.ledgerActivityIds.has(activity.activityId)) continue;
    const sport = mapSport(activity.sport);
    const local = utcToLocal(activity.startUtc, timezone);
    const durationMin = Math.max(1, Math.round(activity.durationSec / 60));

    const match = matchActivity(
      { localDate: local.date, startMinutes: local.minutes, durationMin, apexType: sport.type },
      ctx.occurrences,
      ctx.completedKeys,
      filled,
    );
    if (match) filled.add(occurrenceKey(match.id, match.date));

    proposals.push({
      activity: {
        activityId: activity.activityId,
        sportLabel: sport.label,
        apexType: sport.type,
        localDate: local.date,
        displayTime: local.display,
        durationMin,
        distance: distanceLabel(activity.distanceMeters),
        avgHr: activity.avgHr ?? null,
      },
      match: match
        ? { eventId: match.id, eventDate: match.date, title: match.title, startTime: match.startTime ?? null, type: match.type }
        : null,
    });
  }
  return proposals;
}

async function handlePreview(
  supabase: Admin, res: VercelResponse, userId: string,
  provider: SyncProvider, accessToken: string, timezone: string,
): Promise<void> {
  const ctx = await loadSyncContext(supabase, userId, provider, accessToken);
  res.status(200).json({ proposals: buildProposals(ctx, timezone) });
}

// ─── apply ───────────────────────────────────────────────────────────────────

interface Decision {
  activityId: string;
  action: 'fill' | 'create';
  targetEventId?: string;
  eventDate?: string;
}

function parseDecisions(raw: unknown): Decision[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DECISIONS) return null;
  const out: Decision[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const d = item as Record<string, unknown>;
    if (typeof d.activityId !== 'string' || !d.activityId || seen.has(d.activityId)) return null;
    seen.add(d.activityId);
    if (d.action === 'fill') {
      if (typeof d.targetEventId !== 'string' || typeof d.eventDate !== 'string') return null;
      out.push({ activityId: d.activityId, action: 'fill', targetEventId: d.targetEventId, eventDate: d.eventDate });
    } else if (d.action === 'create') {
      out.push({ activityId: d.activityId, action: 'create' });
    } else {
      return null;
    }
  }
  return out;
}

/** Merge the richer detail payload over the list item when available. */
async function withDetail(client: CorosClient, activity: ProviderActivity): Promise<ProviderActivity> {
  const sportType = typeof activity.sport === 'number' ? activity.sport : undefined;
  let enriched = activity;
  try {
    // getActivityDetail requires the numeric sportType from the records list.
    const detail = await client.fetchActivityDetail(activity.activityId, sportType);
    if (detail) {
      enriched = {
        ...activity,
        ...Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined && v !== null)),
        summaryExtras: { ...activity.summaryExtras, ...detail.summaryExtras },
        streams: detail.streams ?? activity.streams,
        // The list item's identity + start are authoritative.
        activityId: activity.activityId,
        startUtc: activity.startUtc,
      };
    }
  } catch (err) {
    // Detail is enrichment, not a requirement — scalars from the list
    // payload still make a useful import.
    console.error('[provider-sync] detail fetch failed, using list payload:', err instanceof Error ? err.message : err);
  }

  // Time-series only exist in the FIT files. Same posture: enrichment, never
  // a blocker — a failed download (or the daily FIT limit) still imports the
  // activity with its scalars, and streams stay null.
  if (!enriched.streams) {
    try {
      const streams = await client.fetchFitStreams(activity.activityId, sportType);
      if (streams) enriched = { ...enriched, streams };
    } catch (err) {
      console.error('[provider-sync] FIT streams fetch failed, importing without series:', err instanceof Error ? err.message : err);
    }
  }
  return enriched;
}

const APEX_TYPE_TO_EXERCISE_CATEGORY: Record<string, Exercise['category']> = {
  'cardio': 'cardio',
  'weights': 'strength',
  'climbing': 'climbing',
  'outdoor-climbing': 'climbing',
  'yoga': 'stretch',
  'stretching': 'stretch',
  'morning-routine': 'mobility',
};

function sanitizeEventId(provider: SyncProvider, activityId: string): string {
  const cleaned = activityId.replace(/[^A-Za-z0-9_-]/g, '-');
  return `${provider}-${cleaned}`.slice(0, 128);
}

interface ApplyOutcome {
  created: number;
  filled: number;
  errors: { activityId: string; error: string }[];
}

async function handleApply(
  supabase: Admin, req: VercelRequest, res: VercelResponse,
  userId: string, provider: SyncProvider, accessToken: string, timezone: string,
): Promise<void> {
  const decisions = parseDecisions((req.body as Record<string, unknown>).decisions);
  if (!decisions) {
    res.status(400).send(`decisions must be 1–${MAX_DECISIONS} unique {activityId, action} entries`);
    return;
  }

  const ctx = await loadSyncContext(supabase, userId, provider, accessToken);
  const byId = new Map(ctx.activities.map(a => [a.activityId, a]));
  const client = new CorosClient(accessToken);
  const occurrenceIndex = new Map(ctx.occurrences.map(o => [occurrenceKey(o.id, o.date), o]));

  const outcome: ApplyOutcome = { created: 0, filled: 0, errors: [] };
  // Fills already executed this apply — a second decision naming the same
  // occurrence must fail validation, exactly like a ledgered fill.
  const filledThisApply = new Set<string>();

  for (const decision of decisions) {
    const listItem = byId.get(decision.activityId);
    if (!listItem) {
      outcome.errors.push({ activityId: decision.activityId, error: 'activity-not-available' });
      continue;
    }
    if (ctx.ledgerActivityIds.has(decision.activityId)) {
      // Concurrent apply or a retry after partial success — already done.
      continue;
    }

    try {
      const activity = await withDetail(client, listItem);
      const local = utcToLocal(activity.startUtc, timezone);
      const sport = mapSport(activity.sport);

      if (decision.action === 'fill') {
        const key = occurrenceKey(decision.targetEventId!, decision.eventDate!);
        const target = occurrenceIndex.get(key);
        if (
          !target
          || target.date !== local.date
          || ctx.completedKeys.has(key)
          || ctx.ledgerFilledKeys.has(key)
          || filledThisApply.has(key)
        ) {
          outcome.errors.push({ activityId: decision.activityId, error: 'fill-target-unavailable' });
          continue;
        }
        await writeActivityRecords(supabase, userId, provider, activity, sport.label, local, target, null);
        filledThisApply.add(key);
        outcome.filled += 1;
      } else {
        const eventId = sanitizeEventId(provider, activity.activityId);
        await writeActivityRecords(supabase, userId, provider, activity, sport.label, local, null, {
          eventId,
          type: sport.type,
        });
        outcome.created += 1;
      }
    } catch (err) {
      console.error(`[provider-sync] apply failed for ${decision.activityId}:`, err instanceof Error ? err.message : err);
      outcome.errors.push({ activityId: decision.activityId, error: 'write-failed' });
    }
  }

  // The grab is recorded even when individual activities errored — their
  // ledger rows are absent, so the 48 h overlap re-proposes them next time.
  await recordSync(supabase, userId, provider);
  res.status(200).json(outcome);
}

// ─── The per-activity write sequence ─────────────────────────────────────────

function firstCardioExercise(event: WorkoutEvent): Exercise | null {
  const all = [...(event.warmup ?? []), ...event.exercises, ...(event.cooldown ?? [])];
  return event.exercises.find(e => e.category === 'cardio')
    ?? all.find(e => e.category === 'cardio')
    ?? event.exercises[0]
    ?? all[0]
    ?? null;
}

/**
 * All writes for one activity, ledger last. `fillTarget` xor `createSpec`
 * decides the shape; both paths share the completion/session/cardio/streams
 * sequence keyed by the resulting (eventId, eventDate).
 */
async function writeActivityRecords(
  supabase: Admin,
  userId: string,
  provider: SyncProvider,
  activity: ProviderActivity,
  sportLabel: string,
  local: LocalInstant,
  fillTarget: WorkoutEvent | null,
  createSpec: { eventId: string; type: WorkoutEvent['type'] } | null,
): Promise<void> {
  const now = new Date().toISOString();
  const durationMin = Math.max(1, Math.round(activity.durationSec / 60));
  const finishedAtIso = new Date(Date.parse(activity.startUtc) + activity.durationSec * 1000).toISOString();

  let eventId: string;
  let eventDate: string;
  let eventType: string;
  let eventTitle: string;
  let logExercise: { id: string; name: string; definitionId: string | null };

  if (fillTarget) {
    // The planned event row is untouched — cardio_targets stay the plan of
    // record; actuals land in the session/cardio-log tables below.
    eventId = fillTarget.id;
    eventDate = fillTarget.date;
    eventType = fillTarget.type;
    eventTitle = fillTarget.title;
    const ex = firstCardioExercise(fillTarget);
    logExercise = ex
      ? { id: ex.id, name: ex.name, definitionId: ex.definitionId ?? null }
      : { id: 'cardio-1', name: sportLabel, definitionId: null };
  } else if (createSpec) {
    eventId = createSpec.eventId;
    eventDate = local.date;
    eventType = createSpec.type;
    eventTitle = sportLabel;
    logExercise = { id: 'cardio-1', name: sportLabel, definitionId: null };

    const exercise: Exercise = {
      id: 'cardio-1',
      name: sportLabel,
      category: APEX_TYPE_TO_EXERCISE_CATEGORY[createSpec.type] ?? 'cardio',
      duration: `${durationMin} min`,
    };
    // ignoreDuplicates: a PK hit means a concurrent/duplicate apply already
    // created this event — converge, don't error.
    const { error: eventErr } = await supabase.from('workout_events').upsert({
      user_id: userId,
      id: eventId,
      type: createSpec.type,
      title: sportLabel,
      subtitle: 'Synced from COROS',
      date: local.date,
      start_time: local.display,
      estimated_duration: durationMin,
      description: '',
      warmup: [],
      exercises: [exercise],
      cooldown: [],
      difficulty: 3,
      tags: [],
      equipment: [],
      is_recurring: false,
      recurrence_rule: null,
      source: provider,
    }, { onConflict: 'user_id,id', ignoreDuplicates: true });
    if (eventErr) throw new Error(`event insert failed: ${eventErr.message}`);

    const { error: mutErr } = await supabase.from('event_mutations_log').insert({
      user_id: userId,
      operation: 'create',
      event_id: eventId,
      event_title: sportLabel,
      event_date: local.date,
      diff: { after: { source: provider, activityId: activity.activityId } },
      triggered_by: 'user',
    });
    if (mutErr) console.error('[provider-sync] mutation log insert failed:', mutErr.message);
  } else {
    throw new Error('writeActivityRecords needs a fill target or a create spec');
  }

  // Completion + append-only log (completions.ts write shape).
  const [{ error: completionErr }, { error: logErr }] = await Promise.all([
    supabase.from('workout_completions').upsert({
      user_id: userId,
      event_id: eventId,
      event_date: eventDate,
      event_type: eventType,
      event_title: eventTitle,
      duration_minutes: durationMin,
      is_completed: true,
      completed_at: finishedAtIso,
      updated_at: now,
    }, { onConflict: 'user_id,event_id' }),
    supabase.from('workout_completion_log').insert({
      user_id: userId,
      event_id: eventId,
      event_date: eventDate,
      event_type: eventType,
      event_title: eventTitle,
      duration_minutes: durationMin,
      action: 'complete',
    }),
  ]);
  if (completionErr) throw new Error(`completion upsert failed: ${completionErr.message}`);
  if (logErr) console.error('[provider-sync] completion log insert failed:', logErr.message);

  // Session with the measured instants. ignoreDuplicates keeps a session the
  // user tracked by hand; our timing only lands when none exists.
  const { error: sessionErr } = await supabase.from('workout_sessions').upsert({
    user_id: userId,
    event_id: eventId,
    event_date: eventDate,
    started_at: activity.startUtc,
    finished_at: finishedAtIso,
    total_duration_seconds: Math.round(activity.durationSec),
    updated_at: now,
  }, { onConflict: 'user_id,event_id,event_date', ignoreDuplicates: true });
  if (sessionErr) throw new Error(`session upsert failed: ${sessionErr.message}`);

  // Measured actuals — is_autofilled FALSE: these are real, PR-eligible.
  const { error: cardioErr } = await supabase.from('workout_cardio_logs').upsert({
    user_id: userId,
    event_id: eventId,
    event_date: eventDate,
    section: 'exercise',
    exercise_id: logExercise.id,
    exercise_name: logExercise.name,
    definition_id: logExercise.definitionId,
    duration_minutes: durationMin,
    distance: distanceLabel(activity.distanceMeters),
    elevation_gain: elevationLabel(activity.elevationGainMeters),
    avg_heart_rate: activity.avgHr ?? null,
    is_autofilled: false,
    updated_at: now,
  }, { onConflict: 'user_id,event_id,event_date,section,exercise_id', ignoreDuplicates: true });
  if (cardioErr) throw new Error(`cardio log upsert failed: ${cardioErr.message}`);

  // Rich metrics, outside the calendar read path.
  const { error: streamsErr } = await supabase.from('activity_streams').upsert({
    user_id: userId,
    event_id: eventId,
    event_date: eventDate,
    provider,
    activity_id: activity.activityId,
    summary: {
      sport: activity.sport,
      sportLabel,
      startUtc: activity.startUtc,
      durationSec: activity.durationSec,
      distanceMeters: activity.distanceMeters ?? null,
      elevationGainMeters: activity.elevationGainMeters ?? null,
      avgHr: activity.avgHr ?? null,
      maxHr: activity.maxHr ?? null,
      calories: activity.calories ?? null,
      ...activity.summaryExtras,
    },
    streams: activity.streams ?? null,
    created_at: now,
  }, { onConflict: 'user_id,event_id,event_date' });
  if (streamsErr) throw new Error(`activity_streams upsert failed: ${streamsErr.message}`);

  // Ledger LAST — the commit point for this activity.
  const { error: ledgerErr } = await supabase.from('provider_activity_imports').upsert({
    user_id: userId,
    provider,
    activity_id: activity.activityId,
    mode: fillTarget ? 'filled' : 'created',
    event_id: eventId,
    event_date: eventDate,
    imported_at: now,
  }, { onConflict: 'user_id,provider,activity_id', ignoreDuplicates: true });
  if (ledgerErr) throw new Error(`ledger insert failed: ${ledgerErr.message}`);
}
