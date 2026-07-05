import { postJson } from '../api';
import { supabase } from '../supabaseClient';
import type { CardioLogRow, SetLogRow, TrackedSection, WorkoutSessionRow } from '../db/types';
import type { WorkoutEvent } from '../../types/workout';
import { buildQuickCompleteLogs, cardioExerciseNames, setExerciseNames } from './plan';

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

/** Get-or-create the session and hydrate any previously-saved logs. */
export async function loadSession(event: WorkoutEvent): Promise<TrackerSessionData> {
  if (!supabase) {
    return { session: inMemorySession(), savedSets: [], savedCardio: [], history: [], cardioHistory: [] };
  }

  // Previous actuals for this event's set-tracked exercises, matched by
  // name so history follows an exercise across events. Ordered desc so a
  // truncated result still contains the most recent sessions.
  const names = setExerciseNames(event);
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
  const cardioNames = cardioExerciseNames(event);
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

  return {
    session: startRes?.session ?? inMemorySession(),
    savedSets: (setsRes?.data ?? []) as SetLogRow[],
    savedCardio: (cardioRes?.data ?? []) as CardioLogRow[],
    history: (historyRes?.data ?? []) as SetLogRow[],
    cardioHistory: (cardioHistoryRes?.data ?? []) as CardioLogRow[],
  };
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
