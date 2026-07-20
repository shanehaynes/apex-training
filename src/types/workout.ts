export type WorkoutType =
  | 'stretching'
  | 'morning-routine'
  | 'weights'
  | 'climbing'
  | 'outdoor-climbing'
  | 'cardio'
  | 'yoga';

/** Climbing discipline for a pitch (an exercise entry with category 'climbing'). */
export type ClimbStyle = 'sport' | 'trad' | 'boulder' | 'ice-mixed';

/** How a pitch went. 'follow' is roped-only — boulders can't be followed. */
export type AscentStyle = 'flash' | 'redpoint' | 'follow' | 'attempt';

/**
 * Per-set planned target, for ramps/pyramids where sets differ. When absent,
 * the tracker synthesizes uniform targets from the legacy sets/reps/weight/
 * duration fields (see src/lib/tracking/plan.ts) — no backfill required.
 */
export interface PlannedSet {
  setNumber: number;
  targetWeight?: string;
  targetReps?: string;
  targetDuration?: string;
}

export type ExerciseCategory = 'strength' | 'stretch' | 'cardio' | 'skill' | 'mobility' | 'climbing';

/**
 * One row per movement in the exercise library (see EXERCISE_LIBRARY_SPEC.md).
 * Owns identity + descriptive metadata, shared by every referencing event.
 * default* fields are insert-time prefills only — copied into a new event
 * entry, never resolved live.
 */
export interface ExerciseDefinition {
  id: string;
  canonicalName: string;
  /** Former names + accepted spellings; history matching unions these with canonicalName. */
  aliases: string[];
  category: ExerciseCategory;
  muscleGroups: string[];
  equipment: string[];
  imageUrl?: string;
  techniqueNotes?: string;
  isUnilateral: boolean;
  defaultSets?: number;
  defaultReps?: string;
  defaultDuration?: string;
  defaultWeight?: string;
  defaultRest?: string;
  archivedAt?: string;
}

/**
 * An exercise entry inside a workout event: a reference into the library plus
 * this event's prescription. name/category/imageUrl/muscleGroups are snapshots
 * taken when the reference was made — display resolves them from the
 * definition when definitionId is set (src/lib/schedule/definitions.ts) and
 * falls back to the snapshots when it isn't (or the definition is missing).
 */
export interface Exercise {
  id: string;
  definitionId?: string;
  name: string;
  category: ExerciseCategory;
  // ── Prescription: per-event, never shared across events ──
  sets?: number;
  reps?: string;
  duration?: string;
  weight?: string;
  restPeriod?: string;
  plannedSets?: PlannedSet[];
  /** Climbing pitches only: discipline, grade, and how the ascent went. */
  climbStyle?: ClimbStyle;
  grade?: string;
  ascentStyle?: AscentStyle;
  /** Day-specific intent ("last set AMRAP"). Form cues live on the definition. */
  notes?: string;
  imageUrl?: string;
  muscleGroups?: string[];
  /** Populated at resolution time from the definition — never persisted on the entry. */
  techniqueNotes?: string;
}

/**
 * Planned targets for a cardio session. Free-text distance/elevation match
 * the tracker's cardio log fields ('5 mi', '800 ft'); heart rate is bpm.
 */
export interface CardioTargets {
  distance?: string;
  elevationGain?: string;
  avgHeartRate?: number;
}

/**
 * Planned session targets for an outdoor climbing event. Fields left unset
 * are derived from the pitch list at display time (src/lib/climbing.ts) —
 * never persisted back.
 */
export interface ClimbingTargets {
  maxGrade?: string;
  totalPitches?: number;
}

export interface WorkoutEvent {
  id: string;
  type: WorkoutType;
  title: string;
  subtitle?: string;
  date: string;
  startTime?: string;
  endTime?: string;
  estimatedDuration: number;
  description: string;
  warmup?: Exercise[];
  exercises: Exercise[];
  cooldown?: Exercise[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  location?: string;
  coverImageUrl?: string;
  /** Planned session targets for cardio events (actuals live in workout_cardio_logs). */
  cardioTargets?: CardioTargets;
  /** Planned session targets for outdoor climbing events. */
  climbingTargets?: ClimbingTargets;
  tags: string[];
  equipment?: string[];
  isCompleted: boolean;
  completedAt?: string;
  isRecurring: boolean;
  /**
   * Canonical RFC 5545 RRULE value string (no 'RRULE:' prefix), e.g.
   * 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231'. Parsed and expanded by
   * src/lib/recurrence/. Source of truth for the recurrence pattern.
   */
  recurrenceRule?: string;
  /** @deprecated Superseded by recurrenceRule — kept for legacy row display only. */
  recurringPattern?: {
    frequency: 'daily' | 'weekly' | 'custom';
    daysOfWeek?: number[];
    endDate?: string;
  };
}

export interface Schedule {
  version: string;
  lastUpdated: string;
  events: WorkoutEvent[];
}

export type DateRange = 'week' | 'month' | 'all';

export type CalendarView = 'month' | 'week' | 'day';

export interface WeekVolume {
  weekLabel: string;
  weekStart: string;
  count: number;
  totalMinutes: number;
}

export interface WorkoutColorConfig {
  solid: string;
  light: string;
  glow: string;
  border: string;
  label: string;
}
