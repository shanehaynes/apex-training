import type { getSupabaseAdmin } from './supabaseAdmin.js';
import { aliasIndexOf, fetchDefinitionRows } from './mcp/data.js';
import { fetchAllPages } from './pagination.js';
import type { CardioLogRow, ExerciseNoteRow, MealRow, SetLogRow, TrackedSection, WorkoutEventRow, WorkoutSessionRow } from '../../src/lib/db/types.js';
import type { Meal } from '../../src/types/nutrition.js';
import type { Exercise, ExerciseCategory, WorkoutEvent } from '../../src/types/workout.js';
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
  isAddedExerciseId,
  loggedShapeOf,
  setExerciseNames,
  type TrackedSectionGroup,
} from '../../src/lib/tracking/plan.js';
import {
  computeSessionPRs,
  computeWorkoutScorePR,
  describeRecord,
  isPitchRow,
  describeWorkoutScore,
  sessionScoreFromRow,
  type PersonalRecord,
  type ScoreHistoryRow,
  type SessionScore,
  type WorkoutScoreRecord,
} from '../../src/lib/tracking/records.js';
import { buildSessionRecap } from '../../src/lib/coach/summary.js';
import { rowToMeal } from '../../src/lib/nutrition/mapping.js';
import { buildQuickCompleteLogs } from '../../src/lib/tracking/plan.js';
import type { TablesInsert } from '../../src/lib/db/types.js';
import { fail, succeed, type ServiceResult } from './services/result.js';
import { fetchWeightContext, readWeightContext } from './weightContext.js';
import { hasPercentTargets, resolvePercentTargets } from '../../src/lib/tracking/percent.js';

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

/** This occurrence's per-exercise notes (phase 54) — one row per exercise at most. */
async function loadExerciseNotes(supabase: Admin, userId: string, eventId: string, eventDate: string): Promise<ExerciseNoteRow[]> {
  const { data, error } = await supabase
    .from('workout_exercise_notes')
    .select('section,exercise_id,note,event_id,event_date')
    .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate);
  // A note is never worth failing the whole tracker over.
  if (error) {
    console.error('[trackerSession] exercise notes load failed:', error.message);
    return [];
  }
  return (data ?? []) as ExerciseNoteRow[];
}

export interface TrackerHistory {
  history: SetLogRow[];
  cardioHistory: CardioLogRow[];
  scoreHistory: ScoreHistoryRow[];
  /** definition id → category: what an exercise added mid-workout is (its rows don't say). */
  definitionCategories: Map<string, ExerciseCategory>;
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
  const definitionRows = await fetchDefinitionRows(supabase, userId);
  const aliasIndex = aliasIndexOf(definitionRows);
  const definitionCategories = new Map(definitionRows.map(r => [r.id, r.category as ExerciseCategory]));
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
  return { history, cardioHistory, scoreHistory, definitionCategories };
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
  /** Null only for a `peek` bootstrap of a session that has never started. */
  session: WorkoutSessionRow | null;
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
  session: WorkoutSessionRow | null,
  event: WorkoutEvent,
): Promise<TrackerBootstrap> {
  const [saved, notes] = await Promise.all([
    loadSavedRows(supabase, userId, event.id, event.date),
    loadExerciseNotes(supabase, userId, event.id, event.date),
  ]);
  const hist = await loadTrackerHistory(supabase, userId, event, saved);
  const model = buildTrackerModel(
    event, saved.savedSets, saved.savedCardio,
    buildLastPerformance(hist.history), buildLastCardio(hist.cardioHistory),
    notes, hist.definitionCategories,
  );
  // "80%" becomes 80% of the lift's best estimated 1RM here, once, so every
  // client renders the same load (D-008) — only under the unit the profile
  // actually holds: a guessed lb would put a kg lifter's 80 kg on the bar
  // as 177.5. Unknown unit, the raw "80%" shows.
  const known = hasPercentTargets(model) ? await readWeightContext(supabase, userId) : null;
  const groups = known ? resolvePercentTargets(model, hist.history, known) : model;
  let prs: WirePersonalRecord[] = [];
  let scoreRecord: WireScoreRecord | null = null;
  if (session?.finished_at) {
    // The same context the review reads with, so a bare "80" is 80 kg for a
    // kg lifter here too and the two never disagree about a record.
    const weight = known ?? await fetchWeightContext(supabase, userId);
    prs = describePRs(computeSessionPRs(groups, hist.history, hist.cardioHistory, weight));
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
  const [hist, meals, weight] = await Promise.all([
    loadTrackerHistory(supabase, userId, event, saved),
    // Fueling context is the workout's day, not the wall-clock day.
    loadMealsForDate(supabase, userId, event.date).catch(() => [] as Meal[]),
    // How a bare "80" or a "BW+25" reads — the review's context, so Finish
    // and the review agree about every record.
    fetchWeightContext(supabase, userId),
  ]);
  const groups = buildTrackerModel(event, saved.savedSets, saved.savedCardio, undefined, undefined, [], hist.definitionCategories);
  const prs = computeSessionPRs(groups, hist.history, hist.cardioHistory, weight);
  const scoreRecord = score ? computeWorkoutScorePR(score, hist.scoreHistory) : null;
  return {
    groups,
    prs: describePRs(prs),
    scoreRecord: describeScore(scoreRecord),
    recap: buildSessionRecap(event, groups, totalSeconds, prs, meals),
  };
}

const SET_LOG_CONFLICT = 'user_id,event_id,event_date,section,exercise_id,set_number';
const CARDIO_CONFLICT = 'user_id,event_id,event_date,section,exercise_id';

/**
 * "Mark as Complete": stamp the session finished at the recommended duration
 * and log the given rows as autofilled. Every upsert ignores duplicates, so
 * anything hand-logged — including a partially tracked session — is never
 * overwritten. Shared by the workout-sessions handler and the coach's
 * server-side retro-log (an event created on a past day completes on creation).
 */
export async function applyQuickComplete(
  supabase: Admin,
  userId: string,
  eventId: string,
  eventDate: string,
  rows: { setLogs: Record<string, unknown>[]; cardioLogs: Record<string, unknown>[] },
  durationSeconds: number | undefined,
): Promise<ServiceResult> {
  const now = new Date().toISOString();

  const { error: sessionErr } = await supabase
    .from('workout_sessions')
    .upsert(
      { user_id: userId, event_id: eventId, event_date: eventDate, started_at: now },
      { onConflict: 'user_id,event_id,event_date', ignoreDuplicates: true },
    );
  if (sessionErr) {
    console.error('[api/workout-sessions] quick-complete session upsert failed:', sessionErr.message);
    return fail(500, 'Failed to quick-complete session');
  }

  // Stamp unfinished sessions with the recommended duration; a genuinely
  // tracked-and-finished session keeps its measured time.
  const { error: finishErr } = await supabase
    .from('workout_sessions')
    .update({
      finished_at: now,
      total_duration_seconds: typeof durationSeconds === 'number' ? Math.round(durationSeconds) : null,
      updated_at: now,
    })
    .eq('user_id', userId).eq('event_id', eventId)
    .eq('event_date', eventDate)
    .is('finished_at', null);
  if (finishErr) {
    console.error('[api/workout-sessions] quick-complete finish failed:', finishErr.message);
    return fail(500, 'Failed to quick-complete session');
  }

  const ops: PromiseLike<{ error: { message: string } | null }>[] = [];
  if (rows.setLogs.length) {
    ops.push(supabase
      .from('workout_set_logs')
      .upsert(
        rows.setLogs.map(r => ({ ...r, user_id: userId, is_autofilled: true, updated_at: now })) as TablesInsert<'workout_set_logs'>[],
        { onConflict: SET_LOG_CONFLICT, ignoreDuplicates: true },
      ));
  }
  if (rows.cardioLogs.length) {
    ops.push(supabase
      .from('workout_cardio_logs')
      .upsert(
        rows.cardioLogs.map(r => ({ ...r, user_id: userId, is_autofilled: true, updated_at: now })) as TablesInsert<'workout_cardio_logs'>[],
        { onConflict: CARDIO_CONFLICT, ignoreDuplicates: true },
      ));
  }
  const results = await Promise.all(ops);
  const failed = results.find(r => r.error);
  if (failed?.error) {
    console.error('[api/workout-sessions] quick-complete logs failed:', failed.error.message);
    return fail(500, 'Failed to log planned work');
  }
  return succeed(undefined);
}

/** Quick-complete an event from its plan alone (rows built server-side). */
export async function quickCompletePlan(supabase: Admin, userId: string, event: WorkoutEvent): Promise<ServiceResult> {
  const built = buildQuickCompleteLogs(event);
  return applyQuickComplete(
    supabase, userId, event.id, event.date,
    { setLogs: built.setLogs as unknown as Record<string, unknown>[], cardioLogs: built.cardioLogs as unknown as Record<string, unknown>[] },
    event.estimatedDuration > 0 ? event.estimatedDuration * 60 : undefined,
  );
}

/**
 * Undo "Mark as Complete": drop only the system-filled rows (is_autofilled),
 * so hand-entered logs survive. Zero-fills from a real Finish share the flag
 * and are dropped too; re-finishing recreates them. A session with no logs
 * left was created by the toggle — it goes too, so the tracker starts fresh
 * instead of resuming a phantom finished session. Shared by the
 * workout-sessions handler and the connector's uncomplete_workout tool.
 */
export async function applyQuickUncomplete(
  supabase: Admin,
  userId: string,
  eventId: string,
  eventDate: string,
): Promise<ServiceResult> {
  const deletes = await Promise.all([
    supabase.from('workout_set_logs').delete()
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate).eq('is_autofilled', true),
    supabase.from('workout_cardio_logs').delete()
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate).eq('is_autofilled', true),
  ]);
  const failedDelete = deletes.find(r => r.error);
  if (failedDelete?.error) {
    console.error('[api/workout-sessions] quick-uncomplete delete failed:', failedDelete.error.message);
    return fail(500, 'Failed to remove quick-completed logs');
  }

  const [setsLeft, cardioLeft] = await Promise.all([
    supabase.from('workout_set_logs').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate),
    supabase.from('workout_cardio_logs').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate),
  ]);
  if ((setsLeft.count ?? 0) === 0 && (cardioLeft.count ?? 0) === 0) {
    const { error: sessionErr } = await supabase
      .from('workout_sessions').delete()
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate);
    if (sessionErr) {
      console.error('[api/workout-sessions] quick-uncomplete session delete failed:', sessionErr.message);
      return fail(500, 'Failed to remove quick-completed session');
    }
  }
  return succeed(undefined);
}

// ─── Editing a finished session's start and finish ───────────────────────────
// The session row is created the moment the tracker opens, so opening it
// early or logging yesterday's session today records a wrong duration
// forever. `edit-times` lets a finished, tracker-logged session say when it
// really ran (rulings R4.1–R4.5): the duration is recomputed and mirrored
// onto workout_completions, and nothing else — not the score, not the
// coach's summary — is touched.

/** How far past "now" a finish may sit: clock skew, not a plan. */
export const EDIT_TIMES_FUTURE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export interface EditedTimes {
  startedAt: Date;
  finishedAt: Date;
  totalDurationSeconds: number;
}

/**
 * R4.3 — the edit's own bounds, not the autosave timestamp window:
 * event_date − 1 day ≤ started_at ≤ finished_at ≤ now + 5 min. The lower
 * bound is midnight UTC of the day before the event, which admits a
 * session that began the evening before in any timezone and refuses one
 * filed under a day it could not have belonged to (R4.5: any day inside
 * these bounds is fine — stats bucket by event_date, not by the clock).
 */
export function validateEditTimes(
  input: { startedAt: unknown; finishedAt: unknown },
  eventDate: string,
  now: Date = new Date(),
): ServiceResult<EditedTimes> {
  const started = typeof input.startedAt === 'string' ? Date.parse(input.startedAt) : NaN;
  const finished = typeof input.finishedAt === 'string' ? Date.parse(input.finishedAt) : NaN;
  if (Number.isNaN(started) || Number.isNaN(finished)) {
    return fail(400, 'startedAt and finishedAt must both be timestamps');
  }
  const dayStart = Date.parse(`${eventDate}T00:00:00Z`);
  if (Number.isNaN(dayStart)) return fail(400, 'eventDate must be a calendar date');
  if (started < dayStart - DAY_MS) {
    return fail(400, 'The start must be no earlier than the day before the workout');
  }
  if (finished < started) {
    return fail(400, 'The finish must come after the start');
  }
  if (finished > now.getTime() + EDIT_TIMES_FUTURE_MS) {
    return fail(400, 'The finish cannot be in the future');
  }
  return succeed({
    startedAt: new Date(started),
    finishedAt: new Date(finished),
    totalDurationSeconds: Math.round((finished - started) / 1000),
  });
}

/**
 * Change when a finished session started and finished. Refuses (R4.1,
 * R4.2) a session that is still running, one with nothing hand-logged
 * (every row autofilled — "Mark as Complete", whose duration is the plan's
 * estimate), and one a synced activity filled (provider_activity_imports),
 * whose time is the device's. The error says which.
 */
export async function applyEditTimes(
  supabase: Admin,
  userId: string,
  eventId: string,
  eventDate: string,
  input: { startedAt: unknown; finishedAt: unknown },
  now: Date = new Date(),
): Promise<ServiceResult<EditedTimes>> {
  const { data: session, error: sessionErr } = await supabase
    .from('workout_sessions')
    .select('finished_at')
    .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate)
    .maybeSingle();
  if (sessionErr) {
    console.error('[api/workout-sessions] edit-times session load failed:', sessionErr.message);
    return fail(500, 'Failed to load session');
  }
  if (!session) return fail(404, 'Session not started');
  if (!session.finished_at) return fail(409, 'Times can be edited once the workout is finished');

  // Each table named literally: postgrest-js types a union table name as the
  // intersection of the schemas, which has no is_autofilled.
  const [sets, cardio, imports] = await Promise.all([
    supabase.from('workout_set_logs').select('event_id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate).eq('is_autofilled', false),
    supabase.from('workout_cardio_logs').select('event_id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate).eq('is_autofilled', false),
    supabase.from('provider_activity_imports').select('event_id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate),
  ]);
  const failed = [sets, cardio, imports].find(r => r.error);
  if (failed?.error) {
    console.error('[api/workout-sessions] edit-times row check failed:', failed.error.message);
    return fail(500, 'Failed to load session');
  }
  if ((imports.count ?? 0) > 0) {
    return fail(409, 'This workout’s time came from a synced activity — it stays the device’s');
  }
  if ((sets.count ?? 0) === 0 && (cardio.count ?? 0) === 0) {
    return fail(409, 'This workout was marked complete, not tracked — its duration is the plan’s estimate');
  }

  const validated = validateEditTimes(input, eventDate, now);
  if (!validated.ok) return validated;
  const times = validated.value;

  const { error: updateErr } = await supabase
    .from('workout_sessions')
    .update({
      started_at: times.startedAt.toISOString(),
      finished_at: times.finishedAt.toISOString(),
      total_duration_seconds: times.totalDurationSeconds,
      updated_at: now.toISOString(),
    })
    .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate);
  if (updateErr) {
    console.error('[api/workout-sessions] edit-times update failed:', updateErr.message);
    return fail(500, 'Failed to save times');
  }

  // R4.4: the completion row's minutes are what reflection and the review
  // read, so they follow the session. No row (a session finished before the
  // completion landed) is not an error.
  const { error: completionErr } = await supabase
    .from('workout_completions')
    .update({ duration_minutes: Math.round(times.totalDurationSeconds / 60), updated_at: now.toISOString() })
    .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate);
  if (completionErr) {
    console.error('[api/workout-sessions] edit-times completion mirror failed:', completionErr.message);
    return fail(500, 'Failed to save times');
  }
  return succeed(times);
}

// ─── Swapping a logged exercise ──────────────────────────────────────────────
// swap-exercise relabels log rows onto another movement. It may not change
// the rows' shape: a pitch's weight column holds its grade, so a pitch
// relabelled as a lift would read "5.9" as 5.9 lb, and a lift relabelled as
// a pitch would read 185 as a grade; cardio is another table altogether.

const SECTION_ENTRIES: Record<TrackedSection, (e: WorkoutEvent) => Exercise[]> = {
  warmup: e => e.warmup ?? [],
  exercise: e => e.exercises,
  cooldown: e => e.cooldown ?? [],
};

/** The category of what is logged under an added exercise's id, read off its rows. */
async function addedExerciseCategory(
  supabase: Admin,
  userId: string,
  eventId: string,
  eventDate: string,
  section: TrackedSection,
  exerciseId: string,
): Promise<string | null> {
  const [sets, cardio] = await Promise.all([
    supabase.from('workout_set_logs').select('definition_id,ascent_style,attempts')
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate)
      .eq('section', section).eq('exercise_id', exerciseId),
    supabase.from('workout_cardio_logs').select('definition_id')
      .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate)
      .eq('section', section).eq('exercise_id', exerciseId),
  ]);
  const failed = [sets, cardio].find(r => r.error);
  if (failed?.error) throw new Error(`added exercise lookup failed: ${failed.error.message}`);
  if ((cardio.data ?? []).length) return 'cardio';
  const rows = sets.data ?? [];
  if (rows.some(isPitchRow)) return 'climbing';
  const definitionId = rows.find(r => r.definition_id)?.definition_id;
  if (!definitionId) return rows.length ? 'strength' : null;
  const { data, error } = await supabase.from('exercise_definitions').select('category')
    .eq('user_id', userId).eq('id', definitionId).maybeSingle();
  if (error) throw new Error(`definition lookup failed: ${error.message}`);
  return data?.category ?? 'strength';
}

/**
 * Refuses (400) a swap onto a definition whose logged shape differs from the
 * logged exercise's (loggedShapeOf). `event` is the resolved occurrence
 * (loadResolvedOccurrence), null when it is gone. Nothing to compare — no
 * definition named (a free-text name), or an exercise neither the plan nor
 * its rows identify — is not refused. A definition the caller does not own is.
 */
export async function checkSwapShape(
  supabase: Admin,
  userId: string,
  event: WorkoutEvent | null,
  target: { eventId: string; eventDate: string; section: TrackedSection; exerciseId: string },
  definitionId: string | null | undefined,
): Promise<ServiceResult> {
  if (!definitionId) return succeed(undefined);
  const { eventId, eventDate, section, exerciseId } = target;

  let fromCategory: string | null = null;
  const planned = event ? SECTION_ENTRIES[section](event).find(e => e.id === exerciseId) : undefined;
  if (planned) fromCategory = planned.category;
  else if (isAddedExerciseId(exerciseId)) {
    fromCategory = await addedExerciseCategory(supabase, userId, eventId, eventDate, section, exerciseId);
  }
  const from = loggedShapeOf(fromCategory);
  if (!from) return succeed(undefined);

  const { data, error } = await supabase.from('exercise_definitions').select('category')
    .eq('user_id', userId).eq('id', definitionId).maybeSingle();
  if (error) throw new Error(`definition lookup failed: ${error.message}`);
  if (!data) return fail(400, 'swap-exercise names a definition that is not in your library');
  const to = loggedShapeOf(data.category);
  if (to !== from) {
    return fail(400, `swap-exercise cannot change what was logged: a ${fromCategory} exercise cannot become a ${data.category} one`);
  }
  return succeed(undefined);
}
