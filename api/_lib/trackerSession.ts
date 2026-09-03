import type { getSupabaseAdmin } from './supabaseAdmin.js';
import { aliasIndexOf, fetchDefinitionRows } from './mcp/data.js';
import { fetchAllPages } from './pagination.js';
import type { CardioLogRow, MealRow, SetLogRow, WorkoutEventRow, WorkoutSessionRow } from '../../src/lib/db/types.js';
import type { Meal } from '../../src/types/nutrition.js';
import type { WorkoutEvent } from '../../src/types/workout.js';
import { rowToEvent } from '../../src/lib/schedule/mapping.js';
import {
  canonicalizeLogNames,
  expandNamesWithAliases,
  resolveEventExercises,
  rowToDefinition,
  type AliasIndex,
} from '../../src/lib/schedule/definitions.js';
import { baseIdOf } from '../../src/lib/schedule/occurrence.js';
import {
  buildLastCardio,
  buildLastPerformance,
  buildTrackerModel,
  cardioExerciseNames,
  setExerciseNames,
  type TrackedSectionGroup,
} from '../../src/lib/tracking/plan.js';
import {
  computeSessionPRs,
  computeWorkoutScorePR,
  describeRecord,
  describeWorkoutScore,
  sessionScoreFromRow,
  type PersonalRecord,
  type ScoreHistoryRow,
  type SessionScore,
  type WorkoutScoreRecord,
} from '../../src/lib/tracking/records.js';
import { buildSessionRecap } from '../../src/lib/coach/summary.js';
import { rowToMeal } from '../../src/lib/nutrition/mapping.js';

// Server-side tracker session model (docs/ios/backend-changes.md, W3). The
// pure builders in src/lib/tracking run here against the service-role
// client, filtered by the verified user id, so every client — web or native
// — receives a fully resolved TrackedSectionGroup[] and owns only its edits.
// Full-history reads page (fetchAllPages): the browser's old .limit(500)
// silently truncated heavy users' history, which fabricates PRs.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/**
 * The resolved plan for one occurrence: the base row (accepting either the
 * base id or a `${base}__${date}` occurrence id), exercises resolved against
 * the caller's library, re-keyed to the occurrence id and date the tracker
 * logs against. Null when the caller owns no such event.
 */
export async function loadResolvedOccurrence(
  supabase: Admin,
  userId: string,
  eventId: string,
  eventDate: string,
): Promise<WorkoutEvent | null> {
  const [{ data, error }, definitionRows] = await Promise.all([
    supabase.from('workout_events').select('*').eq('user_id', userId).eq('id', baseIdOf(eventId)).maybeSingle(),
    fetchDefinitionRows(supabase, userId),
  ]);
  if (error) throw new Error(`workout_events fetch failed: ${error.message}`);
  if (!data) return null;
  const definitions = new Map(definitionRows.map(r => [r.id, rowToDefinition(r)]));
  const base = resolveEventExercises(rowToEvent(data as WorkoutEventRow), definitions);
  return { ...base, id: eventId, date: eventDate };
}

export interface SavedRows {
  savedSets: SetLogRow[];
  savedCardio: CardioLogRow[];
}

/** Everything logged so far for this occurrence. */
export async function loadSavedRows(supabase: Admin, userId: string, eventId: string, eventDate: string): Promise<SavedRows> {
  const [savedSets, savedCardio] = await Promise.all([
    fetchAllPages<SetLogRow>('workout_set_logs', (from, to) =>
      supabase.from('workout_set_logs').select('*').eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate)
        .order('section').order('exercise_id').order('set_number').range(from, to),
    ),
    fetchAllPages<CardioLogRow>('workout_cardio_logs', (from, to) =>
      supabase.from('workout_cardio_logs').select('*').eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate)
        .order('section').order('exercise_id').range(from, to),
    ),
  ]);
  return { savedSets, savedCardio };
}

export interface TrackerHistory {
  history: SetLogRow[];
  cardioHistory: CardioLogRow[];
  scoreHistory: ScoreHistoryRow[];
}

export function isScoredEvent(event: WorkoutEvent): boolean {
  return !!event.templateId && (event.scoringType === 'for-time' || event.scoringType === 'amrap');
}

/** Names this session logged that the plan did not name — a swapped exercise. */
function extraNames(rows: { exercise_name: string }[], covered: string[]): string[] {
  const known = new Set(covered);
  return [...new Set(rows.map(r => r.exercise_name).filter(name => name && !known.has(name)))];
}

async function priorLogs<T extends { exercise_name: string }>(
  supabase: Admin,
  userId: string,
  table: 'workout_set_logs' | 'workout_cardio_logs',
  names: string[],
  before: string,
  aliasIndex: AliasIndex,
): Promise<T[]> {
  if (!names.length) return [];
  // `as never`: fetchAllPages pins its page type to the row type it returns,
  // which a table chosen at runtime cannot satisfy statically. Both tables
  // carry every column SetLogRow / CardioLogRow name.
  const rows = await fetchAllPages<T>(table, (from, to) =>
    supabase.from(table).select('*').eq('user_id', userId)
      .in('exercise_name', expandNamesWithAliases(names, aliasIndex))
      .lt('event_date', before).eq('is_autofilled', false)
      .order('event_date', { ascending: false }).order('event_id').order('exercise_id').range(from, to) as never,
  );
  // Canonicalized in memory only: grouping keys by exercise_name, so
  // pre-rename rows must group with current ones.
  return canonicalizeLogNames(rows, aliasIndex) as T[];
}

/**
 * Prior actuals for this event's movements (aliases widened, names
 * canonicalized) plus prior finished scores for its template — the inputs to
 * shadow-fill and PR detection. Mirrors what the browser used to fetch.
 */
export async function loadTrackerHistory(
  supabase: Admin,
  userId: string,
  event: WorkoutEvent,
  saved: SavedRows,
): Promise<TrackerHistory> {
  const aliasIndex = aliasIndexOf(await fetchDefinitionRows(supabase, userId));
  const setNames = setExerciseNames(event);
  const cardioNames = cardioExerciseNames(event);

  const [history, cardioHistory, scoreHistory] = await Promise.all([
    priorLogs<SetLogRow>(supabase, userId, 'workout_set_logs',
      [...setNames, ...extraNames(saved.savedSets, setNames)], event.date, aliasIndex),
    priorLogs<CardioLogRow>(supabase, userId, 'workout_cardio_logs',
      [...cardioNames, ...extraNames(saved.savedCardio, cardioNames)], event.date, aliasIndex),
    isScoredEvent(event)
      ? fetchAllPages<ScoreHistoryRow>('workout_sessions', (from, to) =>
          supabase.from('workout_sessions')
            .select('event_date,score_type,score_time_seconds,score_rounds,score_reps')
            .eq('user_id', userId).eq('template_id', event.templateId!)
            .lt('event_date', event.date).not('finished_at', 'is', null).not('score_type', 'is', null)
            .order('event_date', { ascending: false }).range(from, to),
        )
      : Promise.resolve([] as ScoreHistoryRow[]),
  ]);
  return { history, cardioHistory, scoreHistory };
}

/** A PR as it travels to clients: the record plus the sentence the web renders. */
export type WirePersonalRecord = PersonalRecord & { description: string };
export type WireScoreRecord = WorkoutScoreRecord & { description: string };

export function describePRs(prs: PersonalRecord[]): WirePersonalRecord[] {
  return prs.map(pr => ({ ...pr, description: describeRecord(pr) }));
}

function describeScore(record: WorkoutScoreRecord | null): WireScoreRecord | null {
  return record ? { ...record, description: describeWorkoutScore(record) } : null;
}

export interface TrackerBootstrap {
  session: WorkoutSessionRow;
  event: WorkoutEvent;
  groups: TrackedSectionGroup[];
  scored: boolean;
  /** Populated for an already-finished session, so reopening the summary is free. */
  prs: WirePersonalRecord[];
  scoreRecord: WireScoreRecord | null;
}

/** The tracker's opening state: plan × saved rows × last-session shadows. */
export async function buildBootstrap(
  supabase: Admin,
  userId: string,
  session: WorkoutSessionRow,
  event: WorkoutEvent,
): Promise<TrackerBootstrap> {
  const saved = await loadSavedRows(supabase, userId, event.id, event.date);
  const hist = await loadTrackerHistory(supabase, userId, event, saved);
  const groups = buildTrackerModel(
    event, saved.savedSets, saved.savedCardio,
    buildLastPerformance(hist.history), buildLastCardio(hist.cardioHistory),
  );
  let prs: WirePersonalRecord[] = [];
  let scoreRecord: WireScoreRecord | null = null;
  if (session.finished_at) {
    prs = describePRs(computeSessionPRs(groups, hist.history, hist.cardioHistory));
    const score = sessionScoreFromRow(session);
    scoreRecord = describeScore(score ? computeWorkoutScorePR(score, hist.scoreHistory) : null);
  }
  return { session, event, groups, scored: isScoredEvent(event), prs, scoreRecord };
}

export async function loadMealsForDate(supabase: Admin, userId: string, date: string): Promise<Meal[]> {
  const rows = await fetchAllPages<MealRow>('meals', (from, to) =>
    supabase.from('meals').select('*').eq('user_id', userId).eq('date', date).order('time').range(from, to),
  );
  return rows.map(rowToMeal);
}

export interface FinishSummary {
  groups: TrackedSectionGroup[];
  prs: WirePersonalRecord[];
  scoreRecord: WireScoreRecord | null;
  /** The plain-text recap the summary model narrates (buildSessionRecap). */
  recap: string;
}

/**
 * What a finished session amounts to: PRs against full history, the
 * workout-level score record, and the recap text. Computed from the SAVED
 * rows, so it is the same whether called at Finish or when a finished
 * session's summary is regenerated later.
 */
export async function buildFinishSummary(
  supabase: Admin,
  userId: string,
  event: WorkoutEvent,
  totalSeconds: number | null,
  score: SessionScore | null,
): Promise<FinishSummary> {
  const saved = await loadSavedRows(supabase, userId, event.id, event.date);
  const [hist, meals] = await Promise.all([
    loadTrackerHistory(supabase, userId, event, saved),
    // Fueling context is the workout's day, not the wall-clock day.
    loadMealsForDate(supabase, userId, event.date).catch(() => [] as Meal[]),
  ]);
  const groups = buildTrackerModel(event, saved.savedSets, saved.savedCardio);
  const prs = computeSessionPRs(groups, hist.history, hist.cardioHistory);
  const scoreRecord = score ? computeWorkoutScorePR(score, hist.scoreHistory) : null;
  return {
    groups,
    prs: describePRs(prs),
    scoreRecord: describeScore(scoreRecord),
    recap: buildSessionRecap(event, groups, totalSeconds, prs, meals),
  };
}
