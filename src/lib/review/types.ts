import type { CompletionRow, WorkoutSessionRow, SetLogRow, CardioLogRow } from '../db/types.js';
import type { PersonalRecord } from '../tracking/records.js';
import type { WeightContext, WeightUnit } from '../tracking/weight.js';
import type { Period } from './isoMonth.js';

// ─── Review period ────────────────────────────────────────────────────────────

export type PeriodType = 'month' | 'year';

/**
 * The minimum a date window needs in order to be aggregated by
 * computeReviewStats. Training blocks (phase 19) are Monday-aligned ranges
 * that satisfy this without being review periods — they have no isoYear or
 * monthIndex. periodType stays on the base so the `stats is YearlyStats`
 * guard in email.ts keeps narrowing.
 */
export interface StatsPeriod extends Period {
  periodType: PeriodType | 'block';
  /** Human label: "Jun 15 – Jul 12, 2026" or "2025". */
  label: string;
  /** Whole ISO weeks in the window. */
  weeksInPeriod: number;
}

export interface ReviewPeriod extends StatsPeriod {
  periodType: PeriodType;
  isoYear: number;
  /** 1–13 for months, absent for years. */
  monthIndex?: number;
  /** 4 (or 5 for month 13 of a 53-week year); 52/53 for years. */
  weeksInPeriod: number;
}

// ─── Aggregation inputs ───────────────────────────────────────────────────────
// Fetched by the api layer (api/_lib/reviewData.ts), aggregated here. Set and
// cardio logs are FULL history up to the period end (event_date ASC, names
// canonicalized via the alias index) — PR detection needs everything that
// came before the period, not just what happened inside it.

export interface PeriodInputs<P extends StatsPeriod = StatsPeriod> {
  period: P;
  /** Completed completions with event_date inside the period. */
  completions: CompletionRow[];
  /** Sessions with event_date inside the period. */
  sessions: WorkoutSessionRow[];
  /** All non-autofilled set logs with event_date < period end, ASC. */
  setLogs: SetLogRow[];
  /** All non-autofilled cardio logs with event_date < period end, ASC. */
  cardioLogs: CardioLogRow[];
  /**
   * The athlete's weight unit and body weight (profiles.weight_unit /
   * body_weight_lb), which decide how a bare "80" or a "BW+25" row reads.
   * Absent = pounds, no body weight — every pre-existing row keeps its meaning.
   */
  weight?: WeightContext;
}

export type ReviewInputs = PeriodInputs<ReviewPeriod>;

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
   * Σ weight × reps over weighted sets, in POUNDS: every weight is read by
   * parseWeight, so "84 kg" contributes 84 × 2.20462 and a "BW+25" row its
   * resolved load. Bodyweight sets count here (R1.1). Rendered in `unit`.
   */
  tonnage: number;
  totalSets: number;
  totalReps: number;
  /** Heaviest absolute set, in pounds (two decimals); bodyweight-loaded sets are excluded (R1.1). */
  heaviestSet: { weight: number; reps: number; exerciseName: string; date: string } | null;
  /**
   * The unit the athlete reads weights in when the stats were computed — a
   * DISPLAY hint only: tonnage and heaviestSet above are pounds whatever it
   * says (named so a machine reader of get_period_stats / get_reviews cannot
   * take it for the numbers' unit). Stats stored before it existed read lb.
   */
  displayUnit?: WeightUnit;
  /** Top 5 by set count. */
  topExercises: Array<{ exerciseName: string; sets: number }>;
}

export interface PeriodStats<P extends StatsPeriod = StatsPeriod> {
  period: P;
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

/**
 * Review-shaped stats. The alias (rather than widening PeriodStats.period)
 * is load-bearing: email.ts and recap.ts read period.isoYear / period.monthIndex
 * directly, so those fields must stay required here.
 */
export type ReviewStats = PeriodStats<ReviewPeriod>;

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
