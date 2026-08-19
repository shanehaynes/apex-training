import { postJson } from '../api';
import { supabase } from '../supabaseClient';
import type { CardioLogRow, ExerciseDefinitionRow, SetLogRow, TrackedSection, WorkoutSessionRow } from '../db/types';
import type { WorkoutEvent } from '../../types/workout';
import { buildQuickCompleteLogs, cardioExerciseNames, setExerciseNames } from './plan';
import { buildAliasIndex, canonicalizeLogNames, expandNamesWithAliases, type AliasIndex } from '../schedule/definitions';

// Data access for the workout tracker — the one module that knows where
// tracking data lives. Reads go straight to Supabase on the anon client
// (SELECT-only RLS policies); writes go through /api/workout-sessions
// (service role). Owns the no-backend fallback: with Supabase unconfigured
// the session is tracked in memory only, like completions are.

export type SessionInfo = Pick<
  WorkoutSessionRow,
  'started_at' | 'finished_at' | 'total_duration_seconds' | 'coach_summary'
>;

export interface RemovedSetKey {
  section: TrackedSection;
  exerciseId: string;
  setNumber: number;
}

export interface TrackerSessionData {
  session: SessionInfo;
  savedSets: SetLogRow[];
  savedCardio: CardioLogRow[];
  /** Raw prior set logs for this event's exercises — feed client-side PR
      detection at Finish (never sent through the AI). */
  history: SetLogRow[];
  cardioHistory: CardioLogRow[];
}

function inMemorySession(): SessionInfo {
  return { started_at: new Date().toISOString(), finished_at: null, total_duration_seconds: null, coach_summary: null };
}

/**
 * Alias index over the exercise library, so history fetches match every
 * spelling a log row might carry (pre-rename names included) and grouping
 * unifies them under the canonical name. Empty index on failure — matching
 * degrades to today's exact-name behavior.
 */
async function loadAliasIndex(): Promise<AliasIndex> {
  const { data, error } = await supabase!
    .from('exercise_definitions')
    .select('canonical_name,aliases');
  if (error || !data) return buildAliasIndex([]);
  return buildAliasIndex(
    (data as Pick<ExerciseDefinitionRow, 'canonical_name' | 'aliases'>[]).map(r => ({
      canonicalName: r.canonical_name,
      aliases: r.aliases ?? [],
    })),
  );
}

/** Get-or-create the session and hydrate any previously-saved logs. */
export async function loadSession(event: WorkoutEvent): Promise<TrackerSessionData> {
  if (!supabase) {
    return { session: inMemorySession(), savedSets: [], savedCardio: [], history: [], cardioHistory: [] };
  }

  // Aliases must load before the history queries — they widen the name filter.
  const aliasIndex = await loadAliasIndex().catch(() => buildAliasIndex([]));

  // Previous actuals for this event's set-tracked exercises, matched by
  // name (expanded to known aliases) so history follows an exercise across
  // events and renames. Ordered desc so a truncated result still contains
  // the most recent sessions.
  const names = expandNamesWithAliases(setExerciseNames(event), aliasIndex);
  const historyQuery = names.length
    ? supabase
        .from('workout_set_logs')
        .select('*')
        .in('exercise_name', names)
        .lt('event_date', event.date)
        .eq('is_autofilled', false)
        .order('event_date', { ascending: false })
        .limit(500)
    : Promise.resolve({ data: [] as SetLogRow[] });

  // Prior cardio actuals, for distance/elevation PR detection. Autofilled
  // rows (quick-complete plan-fills) are not performances, like set logs.
  const cardioNames = expandNamesWithAliases(cardioExerciseNames(event), aliasIndex);
  const cardioHistoryQuery = cardioNames.length
    ? supabase
        .from('workout_cardio_logs')
        .select('*')
        .in('exercise_name', cardioNames)
        .lt('event_date', event.date)
        .eq('is_autofilled', false)
        .order('event_date', { ascending: false })
        .limit(500)
    : Promise.resolve({ data: [] as CardioLogRow[] });

  const [startRes, setsRes, cardioRes, historyRes, cardioHistoryRes] = await Promise.all([
    postJson<{ session: WorkoutSessionRow }>(
      '/api/workout-sessions',
      { action: 'start', eventId: event.id, eventDate: event.date },
      'Starting session',
    ),
    supabase.from('workout_set_logs').select('*').eq('event_id', event.id).eq('event_date', event.date),
    supabase.from('workout_cardio_logs').select('*').eq('event_id', event.id).eq('event_date', event.date),
    historyQuery,
    cardioHistoryQuery,
  ]).catch(err => {
    console.warn('[apex] Tracker load failed:', err);
    return [null, null, null, null, null] as const;
  });

  const savedSets = (setsRes?.data ?? []) as SetLogRow[];
  const savedCardio = (cardioRes?.data ?? []) as CardioLogRow[];

  // A swapped exercise is logged under a movement the plan never names, so
  // the history queries above missed it. Fetch the difference — one extra
  // round trip, and only for sessions that actually carry a substitution.
  const [extraHistory, extraCardioHistory] = await Promise.all([
    fetchHistoryFor('workout_set_logs', extraNames(savedSets, names), event.date, aliasIndex),
    fetchHistoryFor('workout_cardio_logs', extraNames(savedCardio, cardioNames), event.date, aliasIndex),
  ]);

  return {
    session: startRes?.session ?? inMemorySession(),
    savedSets,
    savedCardio,
    // Canonicalized in memory only: PR/last-performance grouping keys by
    // exercise_name, so pre-rename rows must group with current ones.
    history: [
      ...canonicalizeLogNames((historyRes?.data ?? []) as SetLogRow[], aliasIndex),
      ...(extraHistory as SetLogRow[]),
    ],
    cardioHistory: [
      ...canonicalizeLogNames((cardioHistoryRes?.data ?? []) as CardioLogRow[], aliasIndex),
      ...(extraCardioHistory as CardioLogRow[]),
    ],
  };
}

/** Names this session logged that the plan-derived name list did not cover. */
function extraNames(rows: { exercise_name: string }[], covered: string[]): string[] {
  const known = new Set(covered);
  return [...new Set(rows.map(r => r.exercise_name).filter(name => name && !known.has(name)))];
}

/** Prior non-autofilled logs for a set of exercise names, aliases included. */
async function fetchHistoryFor(
  table: 'workout_set_logs' | 'workout_cardio_logs',
  names: string[],
  before: string,
  aliasIndex: AliasIndex,
): Promise<{ exercise_name: string }[]> {
  if (!supabase || !names.length) return [];
  const { data } = await supabase
    .from(table)
    .select('*')
    .in('exercise_name', expandNamesWithAliases(names, aliasIndex))
    .lt('event_date', before)
    .eq('is_autofilled', false)
    .order('event_date', { ascending: false })
    .limit(500);
  return canonicalizeLogNames((data ?? []) as { exercise_name: string }[], aliasIndex);
}

/** Idempotent upsert of everything the user touched since the last flush. */
export async function saveLogs(
  eventId: string,
  eventDate: string,
  payload: { setLogs: SetLogRow[]; cardioLogs: CardioLogRow[]; removedSets: RemovedSetKey[] },
): Promise<void> {
  if (!supabase) return;
  await postJson('/api/workout-sessions', { action: 'save', eventId, eventDate, ...payload }, 'Autosave');
}

/**
 * Stamp the session finished; zero-fill rows arrive pre-built by the caller.
 * Returns the server-computed duration, or null offline (caller keeps its
 * locally elapsed time).
 */
export async function finishSession(
  eventId: string,
  eventDate: string,
  autofillRows: SetLogRow[],
): Promise<number | null> {
  if (!supabase) return null;
  const data = await postJson<{ totalDurationSeconds?: number }>(
    '/api/workout-sessions',
    { action: 'finish', eventId, eventDate, autofillRows },
    'Finishing workout',
  );
  return typeof data?.totalDurationSeconds === 'number' ? data.totalDurationSeconds : null;
}

export interface ExerciseSwap {
  section: TrackedSection;
  /** The plan entry's id — unchanged by the swap, since logs key on it. */
  exerciseId: string;
  exerciseName: string;
  definitionId: string | null;
}

/**
 * Relabel one exercise's logs for this event+date onto a different movement,
 * keeping every set. The plan is untouched — a recurring series and its other
 * occurrences keep their prescription. Resolves false when there is no
 * backend to persist to, so callers can skip the reload.
 */
export async function swapLoggedExercise(
  eventId: string,
  eventDate: string,
  swap: ExerciseSwap,
): Promise<boolean> {
  if (!supabase) return false;
  await postJson('/api/workout-sessions', { action: 'swap-exercise', eventId, eventDate, ...swap }, 'Swapping exercise');
  return true;
}

/** Forget the session entirely — no resume, no history. */
export async function cancelSession(eventId: string, eventDate: string): Promise<void> {
  if (!supabase) return;
  await postJson('/api/workout-sessions', { action: 'cancel', eventId, eventDate }, 'Discarding workout');
}

/**
 * "Mark as Complete" quick path: log every exercise at its planned targets
 * and stamp the session finished at the recommended duration. Server-side
 * upserts ignore duplicates, so hand-logged rows are never overwritten.
 */
export async function quickCompleteSession(event: WorkoutEvent): Promise<void> {
  if (!supabase) return;
  const { setLogs, cardioLogs } = buildQuickCompleteLogs(event);
  await postJson('/api/workout-sessions', {
    action: 'quick-complete',
    eventId: event.id,
    eventDate: event.date,
    durationSeconds: event.estimatedDuration * 60,
    setLogs,
    cardioLogs,
  }, 'Quick-completing workout');
}

/** Undo the quick path: delete system-filled rows, keep hand-entered logs. */
export async function quickUncompleteSession(eventId: string, eventDate: string): Promise<void> {
  if (!supabase) return;
  await postJson('/api/workout-sessions', { action: 'quick-uncomplete', eventId, eventDate }, 'Un-completing workout');
}

/** Persist the AI coach summary — fire-and-forget. */
export function saveSummary(eventId: string, eventDate: string, coachSummary: string): void {
  if (!supabase) return;
  postJson('/api/workout-sessions', { action: 'summary', eventId, eventDate, coachSummary }, 'Saving coach summary')
    .catch(() => {});
}
