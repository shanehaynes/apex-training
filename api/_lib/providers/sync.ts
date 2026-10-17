import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchCompletionsInRange, fetchExpandedSchedule } from '../mcp/data.js';
import {
  getConnection,
  getFreshAccessToken,
  NotConnectedError,
  recordSync,
  setPendingFillCount,
  stampTimezone,
  type SyncProvider,
} from './connection.js';
import { CorosClient, type ProviderActivity } from './coros/client.js';
import { mapSport, type ActivitySport, type SportMapping } from './coros/mapSport.js';
import { isOwnAppActivity, mapAppleActivityType, parseAppleActivities } from './apple/activity.js';
import { McpAuthExpiredError, McpToolError } from './mcpHttp.js';
import { matchActivity, occurrenceKey } from '../../../src/lib/sync/matching.js';
import { minutesToDisplayTime } from '../../../src/lib/time.js';
import type { WorkoutEvent } from '../../../src/types/workout.js';
import type { Exercise } from '../../../src/types/workout.js';
import { toJson } from '../../../src/lib/db/types.js';
import { endLiveActivities } from '../services/liveActivity.js';
import { isValidTimezone } from '../userTimezone.js';

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
//
// Apple Health (W16 M2b) rides the same rails with the phone as the
// provider: the activities arrive in the body (no token, no fetch, no detail
// call), the match window comes from the batch rather than the watermark, and
// three rules COROS never needed keep a Health workout from becoming a second
// copy of one Apex already has — see classifyApple below.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const FIRST_SYNC_DAYS = 30;
const OVERLAP_MS = 48 * 3600 * 1000;
const MAX_DECISIONS = 100;
/** A Health batch's window reaches a day before its earliest workout, so a
 *  late Watch sync or a first sync's second batch still finds its plan. */
const APPLE_BATCH_LEAD_MS = 24 * 3600 * 1000;
/** Health workouts start no later than this past "now" (clock skew). */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** A tracker session started and never finished counts as in progress for
 *  this long; past it the session is abandoned and blocks nothing. */
const OPEN_SESSION_MS = 12 * 3600 * 1000;
/** Two workouts are the same one when they share at least this much of the
 *  shorter: a Watch strength session recorded alongside the Apex tracker
 *  does; a walk home that brushes the session's last minute does not. */
const SAME_WORKOUT_OVERLAP = 0.5;
/** Another provider's copy of the same workout: start within ±2 min,
 *  duration within ±10 %. */
const CROSS_PROVIDER_START_MS = 120 * 1000;
const CROSS_PROVIDER_DURATION_RATIO = 0.1;

/** Type, title and sport bucket for an activity, by who measured it. */
export function sportFor(provider: SyncProvider, sport: string | number): SportMapping {
  return provider === 'apple' ? mapAppleActivityType(sport) : mapSport(sport);
}

const SUBTITLES: Record<SyncProvider, string> = { coros: 'Synced from COROS', apple: 'Synced from Apple Health' };

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
  provider: SyncProvider;
  activities: ProviderActivity[];
  occurrences: WorkoutEvent[];
  completedKeys: Set<string>;
  ledgerActivityIds: Set<string>;
  ledgerFilledKeys: Set<string>;
  windowStartIso: string;
  /** Apple only: tracker sessions in the window, [start, end] in ms; end is
   *  null for a session still open. Grows as this request writes sessions. */
  sessions: { start: number; end: number | null }[];
  /** Apple only: other providers' imported activities in the window. */
  otherProviderActivities: { start: number; durationSec: number }[];
}

/** Where the activities come from: COROS is fetched with the athlete's
 *  token; Apple Health arrives in the request body. */
export type ActivitySource =
  | { provider: 'coros'; accessToken: string }
  | { provider: 'apple'; activities: ProviderActivity[] };

function dayBefore(isoDate: string): string {
  return new Date(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

async function loadSyncContext(
  supabase: Admin, userId: string, source: ActivitySource,
): Promise<SyncContext> {
  const provider = source.provider;
  const now = Date.now();
  const floor = now - FIRST_SYNC_DAYS * 86_400_000;

  let windowStart: Date;
  if (source.provider === 'apple') {
    // The batch, not the watermark: Health hands the phone workouts in any
    // order and days late, and the phone sends them in batches.
    const earliest = Math.min(...source.activities.map(a => Date.parse(a.startUtc)));
    windowStart = new Date(Math.max(floor, earliest - APPLE_BATCH_LEAD_MS));
  } else {
    const { data: conn, error: connErr } = await supabase
      .from('provider_connections')
      .select('last_synced_at')
      .eq('user_id', userId)
      .eq('provider', provider)
      .maybeSingle();
    if (connErr) throw new Error(`connection read failed: ${connErr.message}`);
    const lastSynced = conn?.last_synced_at ? Date.parse(conn.last_synced_at as string) : null;
    windowStart = new Date(Math.max(floor, lastSynced ? lastSynced - OVERLAP_MS : floor));
  }
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = new Date(now).toISOString();

  const fetchActivities = source.provider === 'apple'
    ? Promise.resolve(source.activities)
    : new CorosClient(source.accessToken).fetchRecentActivities(windowStartIso, windowEndIso);
  const [activities, ledger, expanded, completions, dedup] = await Promise.all([
    fetchActivities,
    // Apple: only this batch's ids — the ledger holds every declined workout
    // too and would outgrow one PostgREST page.
    (source.provider === 'apple'
      ? supabase.from('provider_activity_imports').select('activity_id, mode, event_id, event_date')
        .eq('user_id', userId).eq('provider', provider).in('activity_id', source.activities.map(a => a.activityId))
      : supabase.from('provider_activity_imports').select('activity_id, mode, event_id, event_date')
        .eq('user_id', userId).eq('provider', provider)),
    fetchExpandedSchedule(supabase, userId, windowStartIso.slice(0, 10)),
    fetchCompletionsInRange(supabase, userId, windowStartIso.slice(0, 10), windowEndIso.slice(0, 10)),
    provider === 'apple'
      ? loadDedupContext(supabase, userId, provider, dayBefore(windowStartIso), new Date(windowStart.getTime() - OPEN_SESSION_MS).toISOString())
      : Promise.resolve({ sessions: [], otherProviderActivities: [] }),
  ]);
  if (ledger.error) throw new Error(`ledger read failed: ${ledger.error.message}`);

  return {
    provider,
    ...dedup,
    activities: [...activities].sort((a, b) => a.startUtc.localeCompare(b.startUtc)),
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

/** What a Health workout could be a second copy of: Apex's own tracker
 *  sessions (any provider, or none) and other providers' imports. */
async function loadDedupContext(
  supabase: Admin, userId: string, provider: SyncProvider, fromDate: string, fromInstant: string,
): Promise<Pick<SyncContext, 'sessions' | 'otherProviderActivities'>> {
  const [sessions, streams] = await Promise.all([
    // By when it ran, not by its occurrence's date: an overdue workout
    // tracked today belongs to an occurrence dated days ago.
    supabase.from('workout_sessions')
      .select('started_at, finished_at')
      .eq('user_id', userId)
      .gte('started_at', fromInstant),
    supabase.from('activity_streams')
      .select('provider, summary')
      .eq('user_id', userId)
      .gte('event_date', fromDate)
      .neq('provider', provider),
  ]);
  if (sessions.error) throw new Error(`session read failed: ${sessions.error.message}`);
  if (streams.error) throw new Error(`streams read failed: ${streams.error.message}`);
  return {
    sessions: (sessions.data ?? []).flatMap(s => {
      const start = Date.parse(s.started_at as string);
      if (!Number.isFinite(start)) return [];
      const end = s.finished_at ? Date.parse(s.finished_at as string) : null;
      return [{ start, end: end !== null && Number.isFinite(end) ? end : null }];
    }),
    otherProviderActivities: (streams.data ?? []).flatMap(r => {
      const summary = (r.summary ?? {}) as { startUtc?: unknown; durationSec?: unknown };
      const start = typeof summary.startUtc === 'string' ? Date.parse(summary.startUtc) : NaN;
      const durationSec = typeof summary.durationSec === 'number' ? summary.durationSec : NaN;
      return Number.isFinite(start) && Number.isFinite(durationSec) ? [{ start, durationSec }] : [];
    }),
  };
}

export type AppleSkipReason = 'own-app' | 'duplicate' | 'in-progress' | 'out-of-window' | 'already-imported';

/**
 * Why a Health workout must not be imported, or null when it may be:
 *   already-imported — the ledger has decided it (re-sends are no-ops)
 *   own-app          — Apex wrote it to Health itself (M1)
 *   out-of-window    — started more than 30 days ago, or in the future
 *   in-progress      — overlaps a tracker session that is still open; no
 *                      ledger row, so the next ingest after the finish
 *                      re-evaluates it (as a duplicate)
 *   duplicate        — overlaps a finished tracker session, or another
 *                      provider's import of the same workout
 */
export function classifyApple(activity: ProviderActivity, ctx: SyncContext, now = Date.now()): AppleSkipReason | null {
  if (ctx.ledgerActivityIds.has(activity.activityId)) return 'already-imported';
  if (isOwnAppActivity(activity)) return 'own-app';
  const { start, end } = activityInterval(activity);
  if (start < now - FIRST_SYNC_DAYS * 86_400_000 || start > now + FUTURE_SKEW_MS) return 'out-of-window';
  const overlaps = (s: number, e: number) => start < e && s < end;
  // An open session counts while it is plausibly running; one opened and
  // abandoned more than OPEN_SESSION_MS ago blocks nothing.
  if (ctx.sessions.some(s => s.end === null && now - s.start <= OPEN_SESSION_MS && overlaps(s.start, Math.max(now, s.start + 1)))) {
    return 'in-progress';
  }
  // A finished session is the same workout only when the two share most of
  // the shorter one. Zero-length sessions — a quick-complete, a workout the
  // coach logged — are a tap, not a workout, and never match.
  if (ctx.sessions.some(s => s.end !== null && s.end > s.start && sameWorkout(start, end, s.start, s.end))) return 'duplicate';
  if (ctx.otherProviderActivities.some(o =>
    Math.abs(o.start - start) <= CROSS_PROVIDER_START_MS
    && Math.abs(o.durationSec - activity.durationSec) <= CROSS_PROVIDER_DURATION_RATIO * Math.max(o.durationSec, activity.durationSec),
  )) return 'duplicate';
  return null;
}

/** A Health workout's wall-clock interval: start to the end Health
 *  recorded (a paused workout's duration is shorter than its span), else
 *  start + duration. */
function activityInterval(activity: ProviderActivity): { start: number; end: number } {
  const start = Date.parse(activity.startUtc);
  const recordedEnd = typeof activity.summaryExtras.endUtc === 'string' ? Date.parse(activity.summaryExtras.endUtc) : NaN;
  return { start, end: Number.isFinite(recordedEnd) && recordedEnd > start ? recordedEnd : start + activity.durationSec * 1000 };
}

/** Whether two intervals share at least SAME_WORKOUT_OVERLAP of the shorter. */
function sameWorkout(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const shared = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  const shorter = Math.min(aEnd - aStart, bEnd - bStart);
  return shorter > 0 && shared >= SAME_WORKOUT_OVERLAP * shorter;
}

/** Remember an imported (or proposed) workout's interval, so a second copy
 *  in the same batch (Watch and a phone app both writing to Health) is a
 *  duplicate. */
function rememberSession(ctx: SyncContext, activity: ProviderActivity): void {
  const { start, end } = activityInterval(activity);
  ctx.sessions.push({ start, end });
}

/** "Don't import": the ledger remembers the decision and nothing else is
 *  written. event_id '-' (the column is NOT NULL); the activity's local date. */
async function writeSkip(
  supabase: Admin, userId: string, provider: SyncProvider, activityId: string, localDate: string,
): Promise<void> {
  const { error } = await supabase.from('provider_activity_imports').upsert({
    user_id: userId,
    provider,
    activity_id: activityId,
    mode: 'skipped',
    event_id: '-',
    event_date: localDate,
    imported_at: new Date().toISOString(),
  }, { onConflict: 'user_id,provider,activity_id', ignoreDuplicates: true });
  if (error) throw new Error(`ledger skip insert failed: ${error.message}`);
}

// ─── Handler entry ───────────────────────────────────────────────────────────

export async function handleSyncAction(
  supabase: Admin,
  req: VercelRequest,
  res: VercelResponse,
  userId: string,
  provider: SyncProvider,
  action: 'preview' | 'apply' | 'ingest',
): Promise<void> {
  const body = (req.body ?? {}) as { timezone?: unknown; decisions?: unknown; activities?: unknown };
  if (!isValidTimezone(body.timezone)) {
    res.status(400).send('A valid IANA timezone is required');
    return;
  }
  const timezone = body.timezone;

  if (provider === 'apple') {
    await handleAppleSync(supabase, req, res, userId, action, timezone, body.activities);
    return;
  }
  if (action === 'ingest') {
    res.status(400).send('Unknown action');
    return;
  }

  // Remember the browser's zone — the nightly cron has no browser to ask.
  await stampTimezone(supabase, userId, provider, timezone);

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
    const source: ActivitySource = { provider: 'coros', accessToken };
    if (action === 'preview') {
      await handlePreview(supabase, res, userId, source, timezone);
    } else {
      await handleApply(supabase, req, res, userId, source, timezone);
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

/** Apple Health: consent first (server-side, never trusted to the phone),
 *  then the body's activities. */
async function handleAppleSync(
  supabase: Admin, req: VercelRequest, res: VercelResponse, userId: string,
  action: 'preview' | 'apply' | 'ingest', timezone: string, rawActivities: unknown,
): Promise<void> {
  const connection = await getConnection(supabase, userId, 'apple');
  if (!connection || connection.status !== 'connected') {
    res.status(409).json({ error: 'not-connected' });
    return;
  }
  if (connection.categories.workoutsRead !== true) {
    res.status(409).json({ error: 'category-off', category: 'workoutsRead' });
    return;
  }
  const activities = parseAppleActivities(rawActivities);
  if (!activities) {
    res.status(400).send('activities must be 1–100 unique, well-formed Health workouts');
    return;
  }
  await stampTimezone(supabase, userId, 'apple', timezone);
  const source: ActivitySource = { provider: 'apple', activities };
  if (action === 'preview') {
    await handlePreview(supabase, res, userId, source, timezone);
  } else if (action === 'apply') {
    await handleApply(supabase, req, res, userId, source, timezone);
  } else {
    const ctx = await loadSyncContext(supabase, userId, source);
    res.status(200).json(await runIngest(supabase, userId, ctx, timezone));
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

function proposalFor(
  ctx: SyncContext, activity: ProviderActivity, timezone: string, filled: Set<string>,
): Proposal {
  const sport = sportFor(ctx.provider, activity.sport);
  const local = utcToLocal(activity.startUtc, timezone);
  const durationMin = Math.max(1, Math.round(activity.durationSec / 60));
  const match = matchActivity(
    { localDate: local.date, startMinutes: local.minutes, durationMin, apexType: sport.type },
    ctx.occurrences,
    ctx.completedKeys,
    filled,
  );
  if (match) filled.add(occurrenceKey(match.id, match.date));
  return {
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
  };
}

interface Skipped { activityId: string; reason: AppleSkipReason }

function buildProposals(ctx: SyncContext, timezone: string): { proposals: Proposal[]; skipped: Skipped[] } {
  const filled = new Set(ctx.ledgerFilledKeys);
  const proposals: Proposal[] = [];
  const skipped: Skipped[] = [];

  for (const activity of ctx.activities) {
    if (ctx.provider === 'apple') {
      const reason = classifyApple(activity, ctx);
      if (reason) {
        skipped.push({ activityId: activity.activityId, reason });
        continue;
      }
      proposals.push(proposalFor(ctx, activity, timezone, filled));
      // As apply and ingest do: a second copy in this batch is a duplicate.
      rememberSession(ctx, activity);
      continue;
    }
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
  return { proposals, skipped };
}

async function handlePreview(
  supabase: Admin, res: VercelResponse, userId: string, source: ActivitySource, timezone: string,
): Promise<void> {
  const ctx = await loadSyncContext(supabase, userId, source);
  const { proposals, skipped } = buildProposals(ctx, timezone);
  // COROS's answer is unchanged; Apple also says what it set aside and why.
  res.status(200).json(source.provider === 'apple' ? { proposals, skipped } : { proposals });
}

// ─── apply ───────────────────────────────────────────────────────────────────

interface Decision {
  activityId: string;
  action: 'fill' | 'create' | 'skip';
  targetEventId?: string;
  eventDate?: string;
}

/** `'skip'` ("Don't import") is Apple's only: a COROS activity is either
 *  filled into a plan or imported on its own. */
function parseDecisions(raw: unknown, provider: SyncProvider): Decision[] | null {
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
    } else if (d.action === 'skip' && provider === 'apple') {
      out.push({ activityId: d.activityId, action: 'skip' });
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
  /** Apple only: "Don't import" decisions recorded. */
  skipped?: number;
  errors: { activityId: string; error: string }[];
}

async function handleApply(
  supabase: Admin, req: VercelRequest, res: VercelResponse,
  userId: string, source: ActivitySource, timezone: string,
): Promise<void> {
  const provider = source.provider;
  const decisions = parseDecisions((req.body as Record<string, unknown>).decisions, provider);
  if (!decisions) {
    res.status(400).send(`decisions must be 1–${MAX_DECISIONS} unique {activityId, action} entries`);
    return;
  }

  const ctx = await loadSyncContext(supabase, userId, source);
  const byId = new Map(ctx.activities.map(a => [a.activityId, a]));
  const client = source.provider === 'coros' ? new CorosClient(source.accessToken) : null;
  const occurrenceIndex = new Map(ctx.occurrences.map(o => [occurrenceKey(o.id, o.date), o]));

  const outcome: ApplyOutcome = { created: 0, filled: 0, ...(provider === 'apple' ? { skipped: 0 } : {}), errors: [] };
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

    // The same rules preview applied: a Health workout Apex already has, or
    // one still being tracked, is never imported — only declined.
    if (provider === 'apple' && decision.action !== 'skip') {
      const reason = classifyApple(listItem, ctx);
      if (reason) {
        outcome.errors.push({ activityId: decision.activityId, error: reason });
        continue;
      }
    }

    try {
      // COROS's list item is thin; its detail and FIT add the rest. Apple's
      // body already carries everything the phone could read.
      const activity = client ? await withDetail(client, listItem) : listItem;
      const local = utcToLocal(activity.startUtc, timezone);
      const sport = sportFor(provider, activity.sport);

      if (decision.action === 'skip') {
        await writeSkip(supabase, userId, provider, activity.activityId, local.date);
        outcome.skipped = (outcome.skipped ?? 0) + 1;
        continue;
      }

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
        rememberSession(ctx, activity);
        outcome.filled += 1;
      } else {
        const eventId = sanitizeEventId(provider, activity.activityId);
        await writeActivityRecords(supabase, userId, provider, activity, sport.label, local, null, {
          eventId,
          type: sport.type,
          sport: sport.sport,
        });
        rememberSession(ctx, activity);
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
  // A manual apply carries a decision for every proposal, so nothing the
  // nightly job counted is still pending.
  await setPendingFillCount(supabase, userId, provider, 0);
  res.status(200).json(outcome);
}

// ─── Nightly auto-sync ───────────────────────────────────────────────────────

export interface AutoSyncOutcome {
  created: number;
  pendingFills: number;
  errors: number;
}

/** Cap per user per night: keeps one user's backlog (and its per-activity
 *  FIT downloads) from starving the run. Leftovers import the next night —
 *  the ledger and watermark make that convergent. */
const MAX_AUTO_IMPORTS = 20;

/**
 * The unattended flavor of apply. Imports every unmatched activity as a
 * standalone completed event (the decided behavior for silent imports) but
 * NEVER auto-fills a planned workout — fill decisions stay with the user,
 * counted into pending_fill_count so the calendar Sync button wears a badge.
 * The watermark advances only when nothing is pending, so an unconfirmed
 * match can't age out of the fetch window; a manual sync earlier in the day
 * makes tonight's run a natural no-op (everything already ledgered).
 */
export async function runAutoSync(
  supabase: Admin,
  userId: string,
  provider: SyncProvider,
  timezone: string,
): Promise<AutoSyncOutcome> {
  const accessToken = await getFreshAccessToken(supabase, userId, provider);
  const ctx = await loadSyncContext(supabase, userId, { provider: 'coros', accessToken });
  const client = new CorosClient(accessToken);
  const outcome: AutoSyncOutcome = { created: 0, pendingFills: 0, errors: 0 };
  const filled = new Set(ctx.ledgerFilledKeys);

  for (const listItem of ctx.activities) {
    if (ctx.ledgerActivityIds.has(listItem.activityId)) continue;

    const sport = mapSport(listItem.sport);
    const local = utcToLocal(listItem.startUtc, timezone);
    const durationMin = Math.max(1, Math.round(listItem.durationSec / 60));
    const match = matchActivity(
      { localDate: local.date, startMinutes: local.minutes, durationMin, apexType: sport.type },
      ctx.occurrences,
      ctx.completedKeys,
      filled,
    );
    if (match) {
      // Reserve the occurrence so a second activity can't also claim it,
      // exactly like preview does — but leave the decision to the user.
      filled.add(occurrenceKey(match.id, match.date));
      outcome.pendingFills += 1;
      continue;
    }
    if (outcome.created >= MAX_AUTO_IMPORTS) continue;

    try {
      const activity = await withDetail(client, listItem);
      await writeActivityRecords(supabase, userId, provider, activity, sport.label, local, null, {
        eventId: sanitizeEventId(provider, activity.activityId),
        type: sport.type,
        sport: sport.sport,
      });
      outcome.created += 1;
    } catch (err) {
      console.error(`[provider-cron] auto-import failed for ${listItem.activityId}:`, err instanceof Error ? err.message : err);
      outcome.errors += 1;
    }
  }

  if (outcome.pendingFills === 0 && outcome.errors === 0) {
    await recordSync(supabase, userId, provider);
  }
  await setPendingFillCount(supabase, userId, provider, outcome.pendingFills);
  return outcome;
}

export interface IngestOutcome {
  created: number;
  skipped: Skipped[];
  /** Matches waiting on the athlete: a fill is never made unattended. */
  pending: Proposal[];
  errors: { activityId: string; error: string }[];
}

/**
 * Apple's unattended import, the phone's background delivery: the same rules
 * as runAutoSync — create what matches nothing, never fill a planned workout,
 * count the matches into pending_fill_count — with Health's dedup on top. A
 * duplicate or own-app workout is ledgered as skipped so it is not weighed
 * again; an in-progress one is not, so it is re-weighed after the session
 * finishes. The watermark moves only when nothing is pending or failed.
 */
export async function runIngest(
  supabase: Admin, userId: string, ctx: SyncContext, timezone: string,
): Promise<IngestOutcome> {
  const provider = ctx.provider;
  const outcome: IngestOutcome = { created: 0, skipped: [], pending: [], errors: [] };
  const filled = new Set(ctx.ledgerFilledKeys);

  for (const activity of ctx.activities) {
    const reason = classifyApple(activity, ctx);
    if (reason) {
      outcome.skipped.push({ activityId: activity.activityId, reason });
      if (reason === 'duplicate' || reason === 'own-app') {
        try {
          await writeSkip(supabase, userId, provider, activity.activityId, utcToLocal(activity.startUtc, timezone).date);
        } catch (err) {
          console.error(`[provider-sync] skip ledger failed for ${activity.activityId}:`, err instanceof Error ? err.message : err);
        }
      }
      continue;
    }

    const proposal = proposalFor(ctx, activity, timezone, filled);
    if (proposal.match) {
      outcome.pending.push(proposal);
      continue;
    }
    try {
      const sport = sportFor(provider, activity.sport);
      await writeActivityRecords(supabase, userId, provider, activity, sport.label, utcToLocal(activity.startUtc, timezone), null, {
        eventId: sanitizeEventId(provider, activity.activityId),
        type: sport.type,
        sport: sport.sport,
      });
      rememberSession(ctx, activity);
      outcome.created += 1;
    } catch (err) {
      console.error(`[provider-sync] ingest failed for ${activity.activityId}:`, err instanceof Error ? err.message : err);
      outcome.errors.push({ activityId: activity.activityId, error: 'write-failed' });
    }
  }

  if (outcome.pending.length === 0 && outcome.errors.length === 0) {
    await recordSync(supabase, userId, provider);
  }
  await setPendingFillCount(supabase, userId, provider, outcome.pending.length);
  return outcome;
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
  createSpec: { eventId: string; type: WorkoutEvent['type']; sport: ActivitySport } | null,
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
      sport: createSpec.sport,
      title: sportLabel,
      subtitle: SUBTITLES[provider],
      date: local.date,
      start_time: local.display,
      estimated_duration: durationMin,
      description: '',
      warmup: [],
      exercises: [toJson(exercise)],
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
  // A watch import that completes a workout the phone is still counting.
  await endLiveActivities(supabase, userId, { eventId, eventDate });

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
    streams: activity.streams ? toJson(activity.streams) : null,
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
