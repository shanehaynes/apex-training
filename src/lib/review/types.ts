import type { CompletionRow, WorkoutSessionRow, SetLogRow, CardioLogRow } from '../db/types';
import type { PersonalRecord } from '../tracking/records';
import type { Period } from './isoMonth';

// ─── Review period ────────────────────────────────────────────────────────────

export type PeriodType = 'month' | 'year';

export interface ReviewPeriod extends Period {
  periodType: PeriodType;
  isoYear: number;
  /** 1–13 for months, absent for years. */
  monthIndex?: number;
  /** Human label: "Jun 15 – Jul 12, 2026" or "2025". */
  label: string;
  /** 4 (or 5 for month 13 of a 53-week year); 52/53 for years. */
  weeksInPeriod: number;
}

// ─── Aggregation inputs ───────────────────────────────────────────────────────
// Fetched by the api layer (api/_lib/reviewData.ts), aggregated here. Set and
// cardio logs are FULL history up to the period end (event_date ASC, names
// canonicalized via the alias index) — PR detection needs everything that
// came before the period, not just what happened inside it.

export interface ReviewInputs {
  period: ReviewPeriod;
  /** Completed completions with event_date inside the period. */
  completions: CompletionRow[];
  /** Sessions with event_date inside the period. */
  sessions: WorkoutSessionRow[];
  /** All non-autofilled set logs with event_date < period end, ASC. */
  setLogs: SetLogRow[];
  /** All non-autofilled cardio logs with event_date < period end, ASC. */
  cardioLogs: CardioLogRow[];
}

// ─── Computed stats ───────────────────────────────────────────────────────────
// Stored verbatim in reviews.stats and rendered by the recap and the email —
// every number the AI ever sees is computed here, never by the model.

export type DatedPersonalRecord = PersonalRecord & {
  /** event_date the record was set. */
  date: string;
};

export interface QuantityHighlight {
  value: number;
  unit: string;
  exerciseName: string;
  date: string;
}

export interface ReviewTotals {
  sessionsCompleted: number;
  sessionsByType: Record<string, number>;
  totalDurationMinutes: number;
  activeDays: number;
  /** Distinct ISO weeks with at least one completed session. */
  weeksActive: number;
}

export interface CardioStats {
  /** Summed per normalized unit — "5 mi" never adds to "8 km". */
  distanceByUnit: Record<string, number>;
  elevationByUnit: Record<string, number>;
  longestDistance: QuantityHighlight | null;
  biggestClimb: QuantityHighlight | null;
}

export interface StrengthStats {
  /**
   * Σ weight × reps over weighted sets. Weights are summed as bare numbers
   * in whatever unit they were logged ("185lb" and "84 kg" both contribute
   * their number) — the repo never normalizes weight units, so label this
   * "total weight moved" without a unit.
   */
  tonnage: number;
  totalSets: number;
  totalReps: number;
  heaviestSet: { weight: number; reps: number; exerciseName: string; date: string } | null;
  /** Top 5 by set count. */
  topExercises: Array<{ exerciseName: string; sets: number }>;
}

export interface ReviewStats {
  period: ReviewPeriod;
  totals: ReviewTotals;
  cardio: CardioStats;
  strength: StrengthStats;
  /** PRs set inside the period, in date order. */
  prs: DatedPersonalRecord[];
  prCountsByKind: Record<string, number>;
  streaks: {
    longestActiveDayStreak: number;
    mostActiveWeek: { weekStart: string; sessions: number } | null;
  };
  notable: {
    longestSession: { minutes: number; date: string; title: string } | null;
  };
}

// ─── Yearly retrospective ─────────────────────────────────────────────────────

export interface MonthLite {
  monthIndex: number;
  /** "Jun 15 – Jul 12" style range label. */
  label: string;
  sessions: number;
  durationMinutes: number;
  tonnage: number;
  distanceByUnit: Record<string, number>;
  prCount: number;
}

export interface YearlyStats extends ReviewStats {
  months: MonthLite[];
  /** Most sessions, tie-broken by duration. Null when the year had none. */
  bestMonth: MonthLite | null;
  bestCategory: { type: string; sessions: number } | null;
  /**
   * Largest second-half vs first-half session-count gain. Halves are months
   * 1–7 vs 8–13 (the odd 13th month forces an uneven split; month 7 goes to
   * the first half). Null when nothing improved.
   */
  mostImprovedCategory: { type: string; firstHalf: number; secondHalf: number } | null;
  /** Top 5 PRs by relative improvement over the previous best. */
  biggestPRs: DatedPersonalRecord[];
  /**
   * Deterministic, pre-rendered highlight lines (multi-PR days, longest
   * efforts, coach-summary excerpts) — the shortlist the AI may riff on.
   */
  memorableCandidates: string[];
}
