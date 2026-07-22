import type { Exercise, PlannedSet, WorkoutEvent } from '../../types/workout';
import type { CardioLogRow, SetLogRow, TrackedSection } from '../db/types';
import { sectionLabels } from '../climbing';
import { parseDurationSeconds } from './records';

// ─── Tracker form model ───────────────────────────────────────────────────────
// Pure builders that turn a WorkoutEvent (plan) plus previously-saved rows
// (actuals) into the state the tracker renders. Kept free of React/Supabase
// so the synthesis rules are unit-testable.

export interface TrackedSet {
  setNumber: number;
  planned: PlannedSet;
  actualWeight: string;
  actualReps: string;
  actualDuration: string;
  /** Persisted at least once — an untouched planned set gets zero-filled at Finish. */
  isLogged: boolean;
  isAutofilled: boolean;
  /** Added in the tracker beyond the plan — removable, never zero-filled. */
  isExtra: boolean;
  /** Seeded from last session's actuals; cleared on first edit. Untouched
   *  prefills persist at Finish flagged is_autofilled, like quick-complete. */
  isPrefilled: boolean;
}

export interface CardioActuals {
  durationMinutes: string;
  distance: string;
  elevationGain: string;
  avgHeartRate: string;
  isLogged: boolean;
  isPrefilled: boolean;
}

export interface TrackedExercise {
  section: TrackedSection;
  exercise: Exercise;
  /** Cardio exercises get one structured form instead of per-set rows. */
  isCardio: boolean;
  sets: TrackedSet[];
  cardio: CardioActuals | null;
}

export interface TrackedSectionGroup {
  section: TrackedSection;
  label: string;
  exercises: TrackedExercise[];
}

// ─── Planned-set synthesis ────────────────────────────────────────────────────

/**
 * Per-set targets for an exercise: `plannedSets` when authored, otherwise
 * `sets` (default 1) identical rows synthesized from the legacy uniform
 * reps/weight/duration strings. Old events keep working with no backfill.
 */
export function resolvePlannedSets(exercise: Exercise): PlannedSet[] {
  // A climbing pitch is one set whose target grade rides the free-text
  // weight column — the whole set-log pipeline works unchanged, and PR
  // detection never fires on it (classifySet needs weight AND reps).
  if (exercise.category === 'climbing') {
    return [{ setNumber: 1, targetWeight: exercise.grade }];
  }
  if (exercise.plannedSets?.length) return exercise.plannedSets;
  const count = exercise.sets && exercise.sets > 0 ? exercise.sets : 1;
  return Array.from({ length: count }, (_, i) => ({
    setNumber: i + 1,
    targetWeight: exercise.weight,
    targetReps: exercise.reps,
    targetDuration: exercise.duration,
  }));
}

function emptySet(planned: PlannedSet, isExtra: boolean): TrackedSet {
  return {
    setNumber: planned.setNumber,
    planned,
    actualWeight: '',
    actualReps: '',
    actualDuration: '',
    isLogged: false,
    isAutofilled: false,
    isExtra,
    isPrefilled: false,
  };
}

export function makeExtraSet(setNumber: number): TrackedSet {
  return emptySet({ setNumber }, true);
}

// ─── Model construction ───────────────────────────────────────────────────────

const SECTION_SOURCES: { section: TrackedSection; labelKey: 'warmup' | 'exercises' | 'cooldown'; pick: (e: WorkoutEvent) => Exercise[] }[] = [
  { section: 'warmup',   labelKey: 'warmup',    pick: e => e.warmup ?? [] },
  { section: 'exercise', labelKey: 'exercises', pick: e => e.exercises },
  { section: 'cooldown', labelKey: 'cooldown',  pick: e => e.cooldown ?? [] },
];

export function buildTrackerModel(
  event: WorkoutEvent,
  savedSets: SetLogRow[] = [],
  savedCardio: CardioLogRow[] = [],
  lastByName: Map<string, LastPerformance> = new Map(),
  lastCardioByName: Map<string, LastCardioActuals> = new Map(),
): TrackedSectionGroup[] {
  const setKey = (section: string, exerciseId: string, setNumber: number) =>
    `${section}|${exerciseId}|${setNumber}`;
  const setsByKey = new Map(savedSets.map(r => [setKey(r.section, r.exercise_id, r.set_number), r]));
  const cardioByKey = new Map(savedCardio.map(r => [`${r.section}|${r.exercise_id}`, r]));

  const labels = sectionLabels(event.type);
  return SECTION_SOURCES
    .map(({ section, labelKey, pick }) => ({
      section,
      label: labels[labelKey],
      exercises: pick(event).map((exercise): TrackedExercise => {
        if (exercise.category === 'cardio') {
          const row = cardioByKey.get(`${section}|${exercise.id}`);
          const last = row ? undefined : lastCardioByName.get(exercise.name);
          return {
            section,
            exercise,
            isCardio: true,
            sets: [],
            cardio: row
              ? {
                  durationMinutes: row.duration_minutes != null ? String(row.duration_minutes) : '',
                  distance: row.distance ?? '',
                  elevationGain: row.elevation_gain ?? '',
                  avgHeartRate: row.avg_heart_rate != null ? String(row.avg_heart_rate) : '',
                  isLogged: true,
                  isPrefilled: false,
                }
              : {
                  durationMinutes: last?.durationMinutes ?? '',
                  distance: last?.distance ?? '',
                  elevationGain: last?.elevationGain ?? '',
                  avgHeartRate: last?.avgHeartRate ?? '',
                  isLogged: false,
                  isPrefilled: !!last,
                },
          };
        }

        const planned = resolvePlannedSets(exercise);
        const last = lastByName.get(exercise.name);
        const sets = planned.map(p => {
          const row = setsByKey.get(setKey(section, exercise.id, p.setNumber));
          const base = emptySet(p, false);
          if (row) {
            return {
              ...base,
              actualWeight: row.actual_weight ?? '',
              actualReps: row.actual_reps ?? '',
              actualDuration: row.actual_duration ?? '',
              isLogged: true,
              isAutofilled: row.is_autofilled,
            };
          }
          // When the plan has more sets than last time, extras inherit the
          // highest-numbered set that was actually performed.
          const lastSet = last && (last.sets.get(p.setNumber) ?? highestNumberedSet(last.sets));
          if (lastSet && (lastSet.weight || lastSet.reps || lastSet.duration)) {
            return {
              ...base,
              actualWeight: lastSet.weight,
              actualReps: lastSet.reps,
              actualDuration: lastSet.duration,
              isPrefilled: true,
            };
          }
          return base;
        });

        // Extra sets logged beyond the plan in a previous sitting.
        const maxPlanned = planned.length ? planned[planned.length - 1].setNumber : 0;
        for (const row of savedSets) {
          if (row.section === section && row.exercise_id === exercise.id && row.set_number > maxPlanned) {
            sets.push({
              ...makeExtraSet(row.set_number),
              actualWeight: row.actual_weight ?? '',
              actualReps: row.actual_reps ?? '',
              actualDuration: row.actual_duration ?? '',
              isLogged: true,
              isAutofilled: row.is_autofilled,
            });
          }
        }
        sets.sort((a, b) => a.setNumber - b.setNumber);

        return { section, exercise, isCardio: false, sets, cardio: null };
      }),
    }))
    .filter(group => group.exercises.length > 0);
}

// ─── Last performance (previous session actuals) ─────────────────────────────

export interface LastSetActuals {
  weight: string;
  reps: string;
  duration: string;
}

export interface LastPerformance {
  /** event_date of the most recent prior session with real logs. */
  date: string;
  sets: Map<number, LastSetActuals>;
}

/** Names of every set-tracked (non-cardio) exercise in the event, deduped. */
export function setExerciseNames(event: WorkoutEvent): string[] {
  const names = new Set<string>();
  for (const { pick } of SECTION_SOURCES) {
    for (const exercise of pick(event)) {
      if (exercise.category !== 'cardio') names.add(exercise.name);
    }
  }
  return [...names];
}

/** Names of every cardio exercise in the event, deduped. */
export function cardioExerciseNames(event: WorkoutEvent): string[] {
  const names = new Set<string>();
  for (const { pick } of SECTION_SOURCES) {
    for (const exercise of pick(event)) {
      if (exercise.category === 'cardio') names.add(exercise.name);
    }
  }
  return [...names];
}

/**
 * Most recent prior actuals per exercise name. Matched by name (not id) so
 * history follows an exercise across different events; autofilled zero-fills
 * and empty rows are ignored — a skipped set is not a performance.
 */
export function buildLastPerformance(rows: SetLogRow[]): Map<string, LastPerformance> {
  const byName = new Map<string, LastPerformance>();
  for (const row of rows) {
    if (row.is_autofilled) continue;
    if (!row.actual_weight && !row.actual_reps && !row.actual_duration) continue;
    const existing = byName.get(row.exercise_name);
    if (existing && row.event_date < existing.date) continue;
    const entry = existing && row.event_date === existing.date
      ? existing
      : { date: row.event_date, sets: new Map<number, LastSetActuals>() };
    entry.sets.set(row.set_number, {
      weight: row.actual_weight ?? '',
      reps: row.actual_reps ?? '',
      duration: row.actual_duration ?? '',
    });
    byName.set(row.exercise_name, entry);
  }
  return byName;
}

function highestNumberedSet(sets: Map<number, LastSetActuals>): LastSetActuals | undefined {
  let best: LastSetActuals | undefined;
  let bestNumber = -Infinity;
  for (const [setNumber, actuals] of sets) {
    if (setNumber > bestNumber) {
      bestNumber = setNumber;
      best = actuals;
    }
  }
  return best;
}

export interface LastCardioActuals {
  /** event_date of the most recent prior session with real logs. */
  date: string;
  durationMinutes: string;
  distance: string;
  elevationGain: string;
  avgHeartRate: string;
}

/**
 * Most recent prior cardio actuals per exercise name — the cardio counterpart
 * of buildLastPerformance. Duplicate cardio names in one event share the same
 * entry. Autofilled and all-empty rows are ignored.
 */
export function buildLastCardio(rows: CardioLogRow[]): Map<string, LastCardioActuals> {
  const byName = new Map<string, LastCardioActuals>();
  for (const row of rows) {
    if (row.is_autofilled) continue;
    if (row.duration_minutes == null && !row.distance && !row.elevation_gain && row.avg_heart_rate == null) continue;
    const existing = byName.get(row.exercise_name);
    if (existing && row.event_date <= existing.date) continue;
    byName.set(row.exercise_name, {
      date: row.event_date,
      durationMinutes: row.duration_minutes != null ? String(row.duration_minutes) : '',
      distance: row.distance ?? '',
      elevationGain: row.elevation_gain ?? '',
      avgHeartRate: row.avg_heart_rate != null ? String(row.avg_heart_rate) : '',
    });
  }
  return byName;
}

// ─── Serialization back to rows ───────────────────────────────────────────────

export function setToRow(
  eventId: string,
  eventDate: string,
  tracked: TrackedExercise,
  set: TrackedSet,
): SetLogRow {
  return {
    event_id: eventId,
    event_date: eventDate,
    section: tracked.section,
    exercise_id: tracked.exercise.id,
    exercise_name: tracked.exercise.name,
    definition_id: tracked.exercise.definitionId ?? null,
    set_number: set.setNumber,
    planned_weight: set.planned.targetWeight ?? null,
    planned_reps: set.planned.targetReps ?? null,
    planned_duration: set.planned.targetDuration ?? null,
    actual_weight: set.actualWeight || null,
    actual_reps: set.actualReps || null,
    actual_duration: set.actualDuration || null,
    is_autofilled: false,
  };
}

export function cardioToRow(
  eventId: string,
  eventDate: string,
  tracked: TrackedExercise,
): CardioLogRow {
  const c = tracked.cardio!;
  const durationNum = parseFloat(c.durationMinutes);
  const hrNum = parseInt(c.avgHeartRate, 10);
  return {
    event_id: eventId,
    event_date: eventDate,
    section: tracked.section,
    exercise_id: tracked.exercise.id,
    exercise_name: tracked.exercise.name,
    definition_id: tracked.exercise.definitionId ?? null,
    duration_minutes: Number.isFinite(durationNum) ? durationNum : null,
    distance: c.distance || null,
    elevation_gain: c.elevationGain || null,
    avg_heart_rate: Number.isFinite(hrNum) ? hrNum : null,
    is_autofilled: false,
  };
}

/** Planned sets never logged nor edited this sitting — zero-filled at Finish. */
export function collectUntouchedPlanned(
  eventId: string,
  eventDate: string,
  groups: TrackedSectionGroup[],
): SetLogRow[] {
  const rows: SetLogRow[] = [];
  for (const group of groups) {
    for (const tracked of group.exercises) {
      for (const set of tracked.sets) {
        if (set.isExtra || set.isLogged) continue;
        if (set.actualWeight || set.actualReps || set.actualDuration) continue;
        const row = setToRow(eventId, eventDate, tracked, set);
        // Actual = 0 for whichever dimensions were planned (reps as the
        // fallback when the plan had none), flagged so analytics can tell
        // a skipped set from a genuine 0-rep attempt.
        rows.push({
          ...row,
          actual_weight: row.planned_weight ? '0' : null,
          actual_reps: row.planned_reps || !row.planned_duration ? '0' : null,
          actual_duration: row.planned_duration ? '0' : null,
          is_autofilled: true,
        });
      }
    }
  }
  return rows;
}

/**
 * Prefilled sets/cardio never touched this sitting — persisted at Finish at
 * last session's values, flagged is_autofilled like quick-complete so history
 * and PR detection ignore them and prefill never compounds across sessions.
 */
export function collectPrefilledUntouched(
  eventId: string,
  eventDate: string,
  groups: TrackedSectionGroup[],
): { setRows: SetLogRow[]; cardioRows: CardioLogRow[] } {
  const setRows: SetLogRow[] = [];
  const cardioRows: CardioLogRow[] = [];
  for (const group of groups) {
    for (const tracked of group.exercises) {
      for (const set of tracked.sets) {
        if (!set.isPrefilled) continue;
        setRows.push({ ...setToRow(eventId, eventDate, tracked, set), is_autofilled: true });
      }
      if (tracked.cardio?.isPrefilled) {
        cardioRows.push({ ...cardioToRow(eventId, eventDate, tracked), is_autofilled: true });
      }
    }
  }
  return { setRows, cardioRows };
}

// ─── Quick complete (the "Mark as Complete" toggle) ──────────────────────────

/**
 * Planned cardio duration in minutes: "45 min" → 45, "30–40 min" → 30 (a
 * range logs its floor), "~2 min" → 2, "1 hr" → 60. Null when nothing
 * parses — the row still marks the exercise done.
 */
export function plannedCardioMinutes(duration: string | undefined): number | null {
  if (!duration) return null;
  const cleaned = duration
    .trim()
    .replace(/^[~≈]\s*/, '')
    .replace(/^(\d+(?:\.\d+)?)\s*[–—-]\s*\d+(?:\.\d+)?/, '$1');
  const seconds = parseDurationSeconds(cleaned);
  return seconds !== null ? Math.round((seconds / 60) * 100) / 100 : null;
}

/**
 * Every exercise in the event logged at its planned (recommended) targets:
 * per-set weight/reps/duration for set work, planned duration for cardio.
 * Rows are flagged is_autofilled so hand-entered logs always win the upsert
 * (ignoreDuplicates server-side), PR and last-performance detection ignore
 * them, and un-marking can delete exactly what the toggle created.
 */
export function buildQuickCompleteLogs(
  event: WorkoutEvent,
): { setLogs: SetLogRow[]; cardioLogs: CardioLogRow[] } {
  const setLogs: SetLogRow[] = [];
  const cardioLogs: CardioLogRow[] = [];

  for (const { section, pick } of SECTION_SOURCES) {
    for (const exercise of pick(event)) {
      if (exercise.category === 'cardio') {
        cardioLogs.push({
          event_id: event.id,
          event_date: event.date,
          section,
          exercise_id: exercise.id,
          exercise_name: exercise.name,
          definition_id: exercise.definitionId ?? null,
          duration_minutes: plannedCardioMinutes(exercise.duration),
          distance: null,
          elevation_gain: null,
          avg_heart_rate: null,
          is_autofilled: true,
        });
        continue;
      }

      for (const planned of resolvePlannedSets(exercise)) {
        setLogs.push({
          event_id: event.id,
          event_date: event.date,
          section,
          exercise_id: exercise.id,
          exercise_name: exercise.name,
          definition_id: exercise.definitionId ?? null,
          set_number: planned.setNumber,
          planned_weight: planned.targetWeight ?? null,
          planned_reps: planned.targetReps ?? null,
          planned_duration: planned.targetDuration ?? null,
          actual_weight: planned.targetWeight ?? null,
          actual_reps: planned.targetReps ?? null,
          actual_duration: planned.targetDuration ?? null,
          is_autofilled: true,
        });
      }
    }
  }

  return { setLogs, cardioLogs };
}
