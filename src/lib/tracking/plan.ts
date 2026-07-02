import type { Exercise, PlannedSet, WorkoutEvent } from '../../types/workout';
import type { CardioLogRow, SetLogRow, TrackedSection } from '../supabaseClient';

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
}

export interface CardioActuals {
  durationMinutes: string;
  distance: string;
  elevationGain: string;
  avgHeartRate: string;
  isLogged: boolean;
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
  };
}

export function makeExtraSet(setNumber: number): TrackedSet {
  return emptySet({ setNumber }, true);
}

// ─── Model construction ───────────────────────────────────────────────────────

const SECTION_SOURCES: { section: TrackedSection; label: string; pick: (e: WorkoutEvent) => Exercise[] }[] = [
  { section: 'warmup',   label: 'Warm-Up',   pick: e => e.warmup ?? [] },
  { section: 'exercise', label: 'Main Work', pick: e => e.exercises },
  { section: 'cooldown', label: 'Cool-Down', pick: e => e.cooldown ?? [] },
];

export function buildTrackerModel(
  event: WorkoutEvent,
  savedSets: SetLogRow[] = [],
  savedCardio: CardioLogRow[] = [],
): TrackedSectionGroup[] {
  const setKey = (section: string, exerciseId: string, setNumber: number) =>
    `${section}|${exerciseId}|${setNumber}`;
  const setsByKey = new Map(savedSets.map(r => [setKey(r.section, r.exercise_id, r.set_number), r]));
  const cardioByKey = new Map(savedCardio.map(r => [`${r.section}|${r.exercise_id}`, r]));

  return SECTION_SOURCES
    .map(({ section, label, pick }) => ({
      section,
      label,
      exercises: pick(event).map((exercise): TrackedExercise => {
        if (exercise.category === 'cardio') {
          const row = cardioByKey.get(`${section}|${exercise.id}`);
          return {
            section,
            exercise,
            isCardio: true,
            sets: [],
            cardio: {
              durationMinutes: row?.duration_minutes != null ? String(row.duration_minutes) : '',
              distance: row?.distance ?? '',
              elevationGain: row?.elevation_gain ?? '',
              avgHeartRate: row?.avg_heart_rate != null ? String(row.avg_heart_rate) : '',
              isLogged: !!row,
            },
          };
        }

        const planned = resolvePlannedSets(exercise);
        const sets = planned.map(p => {
          const row = setsByKey.get(setKey(section, exercise.id, p.setNumber));
          const base = emptySet(p, false);
          return row
            ? {
                ...base,
                actualWeight: row.actual_weight ?? '',
                actualReps: row.actual_reps ?? '',
                actualDuration: row.actual_duration ?? '',
                isLogged: true,
                isAutofilled: row.is_autofilled,
              }
            : base;
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
    duration_minutes: Number.isFinite(durationNum) ? durationNum : null,
    distance: c.distance || null,
    elevation_gain: c.elevationGain || null,
    avg_heart_rate: Number.isFinite(hrNum) ? hrNum : null,
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
