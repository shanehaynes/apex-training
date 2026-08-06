// ─── Objectives & training blocks (phase 19) ─────────────────────────────────
// The semantic layer over the training log. An Objective is what the training
// is aimed at; a TrainingBlock is a dated stretch of training aimed at it,
// carrying quantified weekly targets.
//
// Blocks may not overlap (DB exclusion constraint), so "the block covering
// date D" is a total, single-valued function — which is what lets block
// membership be derived from event_date with no block_id on workout_events.

export type ObjectiveDiscipline = 'alpine' | 'ice' | 'rock' | 'ski' | 'general';
export type ObjectiveStatus = 'active' | 'achieved' | 'abandoned';
export type BlockPhase = 'base' | 'build' | 'peak' | 'taper' | 'recovery' | 'maintenance';

export const BLOCK_PHASES: readonly BlockPhase[] =
  ['base', 'build', 'peak', 'taper', 'recovery', 'maintenance'];
export const OBJECTIVE_DISCIPLINES: readonly ObjectiveDiscipline[] =
  ['alpine', 'ice', 'rock', 'ski', 'general'];

export interface Objective {
  id: string;
  name: string;
  /** undefined = undated aspiration. */
  targetDate?: string;
  discipline?: ObjectiveDiscipline;
  notes: string;
  status: ObjectiveStatus;
}

// ─── Weekly targets ───────────────────────────────────────────────────────────
// Quantity targets carry their unit because the repo refuses cross-unit
// conversion by policy: CardioStats.distanceByUnit / elevationByUnit are
// per-unit maps precisely so "5 mi" never sums with "8 km" (see the comment
// at src/lib/review/stats.ts). Attainment sums only the matching unit key and
// discloses the rest as unmatchedUnits rather than converting or dropping.

export type DistanceUnit = 'mi' | 'km';
export type ElevationUnit = 'ft' | 'm';

export interface Quantity<U extends string> {
  value: number;
  unit: U;
}

export interface WeeklyTargets {
  /** Minutes of cardio-type sessions per week. */
  cardioMinutes?: number;
  /** Vertical gain per week. */
  vert?: Quantity<ElevationUnit>;
  /** Distance covered per week. */
  distance?: Quantity<DistanceUnit>;
  /** Count of completed 'weights' sessions per week. */
  strengthSessions?: number;
  /** Count of completed 'climbing' + 'outdoor-climbing' sessions per week. */
  climbingSessions?: number;
  /** Count of sessions at or above this many minutes — the alpine long day. */
  longSessionMinutes?: number;
}

export type WeeklyTargetKey = keyof WeeklyTargets;

export interface TrainingBlock {
  id: string;
  objectiveId?: string;
  name: string;
  /** What this block is FOR, free text. */
  intent: string;
  phase?: BlockPhase;
  /** Both Mondays, half-open [startDate, endDateExclusive) — matches Period. */
  startDate: string;
  endDateExclusive: string;
  weeklyTargets: WeeklyTargets;
}
