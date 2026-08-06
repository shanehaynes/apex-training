import type { CardioLogRow, CompletionRow, WorkoutSessionRow } from '../db/types';
import type { DatedPersonalRecord, PeriodInputs, PeriodStats, StatsPeriod } from '../review/types';
import {
  computeCardioStats,
  computeReviewStats,
  durationMinutesFor,
  sessionSecondsMap,
} from '../review/stats';
import { rangeLabel } from '../review/isoMonth';
import { parseQuantity } from '../tracking/records';
import type { WorkoutEvent } from '../../types/workout';
import type { TrainingBlock, WeeklyTargetKey, WeeklyTargets } from '../../types/blocks';
import { TARGET_META, targetUnit, targetValue } from './targets';
import { blockPeriod, blockWeeks, currentWeekIndex, enumerateWeeks, weeksElapsed } from './period';

// ─── Block attainment ─────────────────────────────────────────────────────────
// Targets vs. actuals for a training block. Every number here is computed
// deterministically; the coach is handed the result and narrates it.
//
// SCOPE DECISION: attainment measures LOGGED ACTUALS against AUTHORED (or
// calendar-derived) targets. It deliberately does not parse planned exercise
// prescriptions — those are free text by design ("5 each leg", "10s on, 5s
// off", "20–25mm, open hand") and evals/ flags the absence of a reps-string
// parser. Building one to drive a progress bar is a research problem with an
// accuracy ceiling, and unreliable numbers under the coach's authority would
// violate the derive-vs-narrate principle. What's lost: no exercise-level
// planned-vs-actual. What's kept: every target below reads from a field that
// is already numeric or already has a tested parser.

/** Weekly-target keys that are bare numbers rather than unit-carrying quantities. */
type ScalarTargetKey = 'cardioMinutes' | 'strengthSessions' | 'climbingSessions' | 'longSessionMinutes';

/** Event types that count toward each session-count target. */
const CARDIO_TYPES = new Set(['cardio']);
const STRENGTH_TYPES = new Set(['weights']);
const CLIMBING_TYPES = new Set(['climbing', 'outdoor-climbing']);

export interface TargetAttainment {
  key: WeeklyTargetKey;
  label: string;
  unit: string;
  /** Per-week target as authored, or derived from the planned calendar. */
  target: number;
  source: 'authored' | 'derived';
  /** target × weeks in this window. */
  targetForWindow: number;
  actual: number;
  /** actual / targetForWindow, or null when there is no target to divide by. */
  pct: number | null;
  /**
   * Quantities logged in a unit the target did not name. Never converted and
   * never folded into `actual` — the repo refuses cross-unit conversion, so
   * these are surfaced for the UI to disclose instead.
   */
  unmatchedUnits?: Record<string, number>;
}

export interface BlockWeekProgress {
  index: number;
  startDate: string;
  endDateExclusive: string;
  isComplete: boolean;
  sessionsCompleted: number;
  attainment: TargetAttainment[];
}

export interface BlockProgress {
  block: TrainingBlock;
  period: StatsPeriod;
  weeksTotal: number;
  weeksElapsed: number;
  /** 1-based in-progress week, or null when the block hasn't started/has ended. */
  currentWeek: number | null;
  weeks: BlockWeekProgress[];
  /** Prorated by ELAPSED weeks, not block length. */
  toDate: { attainment: TargetAttainment[]; stats: PeriodStats<StatsPeriod> };
  prs: DatedPersonalRecord[];
}

export interface BlockProgressInputs extends PeriodInputs<StatsPeriod> {
  block: TrainingBlock;
  /** Expanded occurrences overlapping the block — the source of derived targets. */
  plannedEvents: WorkoutEvent[];
}

// ─── Window actuals ───────────────────────────────────────────────────────────

interface WindowActuals {
  sessionsCompleted: number;
  cardioMinutes: number;
  strengthSessions: number;
  climbingSessions: number;
  longestSessionMinutes: number;
  distanceByUnit: Record<string, number>;
  elevationByUnit: Record<string, number>;
}

const inWindow = (date: string, period: StatsPeriod) =>
  date >= period.startDate && date < period.endDateExclusive;

/**
 * Actuals for one window. Deliberately avoids computeReviewStats: that runs
 * full-history PR detection, and calling it per week would make a 52-week
 * block do 52 full-history scans. PRs are computed once, for the whole block.
 */
function windowActuals(
  completions: CompletionRow[],
  sessions: WorkoutSessionRow[],
  cardioLogs: CardioLogRow[],
  period: StatsPeriod,
): WindowActuals {
  const seconds = sessionSecondsMap(sessions.filter(s => inWindow(s.event_date, period)));
  const done = completions.filter(c => c.is_completed && inWindow(c.event_date, period));

  let cardioMinutes = 0;
  let strengthSessions = 0;
  let climbingSessions = 0;
  let longestSessionMinutes = 0;

  for (const completion of done) {
    const minutes = durationMinutesFor(completion, seconds);
    if (minutes > longestSessionMinutes) longestSessionMinutes = minutes;
    if (CARDIO_TYPES.has(completion.event_type)) cardioMinutes += minutes;
    if (STRENGTH_TYPES.has(completion.event_type)) strengthSessions += 1;
    if (CLIMBING_TYPES.has(completion.event_type)) climbingSessions += 1;
  }

  const cardio = computeCardioStats(cardioLogs, period);

  return {
    sessionsCompleted: done.length,
    cardioMinutes,
    strengthSessions,
    climbingSessions,
    longestSessionMinutes,
    distanceByUnit: cardio.distanceByUnit,
    elevationByUnit: cardio.elevationByUnit,
  };
}

// ─── Derived targets ──────────────────────────────────────────────────────────

/**
 * Per-week targets implied by what is actually on the calendar, for keys the
 * user did not author. Reads only structured numeric fields —
 * estimatedDuration, cardioTargets, and the event type — never exercise
 * prescriptions.
 */
interface DerivedTargets extends Record<ScalarTargetKey, number> {
  /** Planned volume per unit, so a target that names no unit can pick one. */
  _distanceUnits: Record<string, number>;
  _vertUnits: Record<string, number>;
}

function derivedTargets(
  plannedEvents: WorkoutEvent[],
  period: StatsPeriod,
  weeks: number,
): DerivedTargets {
  const planned = plannedEvents.filter(e => inWindow(e.date, period));
  const perWeek = (total: number) => (weeks > 0 ? total / weeks : 0);

  let cardioMinutes = 0;
  let strengthSessions = 0;
  let climbingSessions = 0;
  let longestSessionMinutes = 0;
  const distanceUnits: Record<string, number> = {};
  const vertUnits: Record<string, number> = {};

  for (const event of planned) {
    const minutes = event.estimatedDuration ?? 0;
    if (minutes > longestSessionMinutes) longestSessionMinutes = minutes;
    if (CARDIO_TYPES.has(event.type)) cardioMinutes += minutes;
    if (STRENGTH_TYPES.has(event.type)) strengthSessions += 1;
    if (CLIMBING_TYPES.has(event.type)) climbingSessions += 1;

    const distance = parseQuantity(event.cardioTargets?.distance);
    if (distance) distanceUnits[distance.unit] = (distanceUnits[distance.unit] ?? 0) + distance.value;
    const vert = parseQuantity(event.cardioTargets?.elevationGain);
    if (vert) vertUnits[vert.unit] = (vertUnits[vert.unit] ?? 0) + vert.value;
  }

  return {
    cardioMinutes:      perWeek(cardioMinutes),
    strengthSessions:   perWeek(strengthSessions),
    climbingSessions:   perWeek(climbingSessions),
    longSessionMinutes: longestSessionMinutes,
    _distanceUnits:     distanceUnits,
    _vertUnits:         vertUnits,
  };
}

// ─── Attainment ───────────────────────────────────────────────────────────────

function ratio(actual: number, targetForWindow: number): number | null {
  if (!(targetForWindow > 0)) return null;   // also catches NaN
  return actual / targetForWindow;
}

/** Sum a per-unit map excluding the matched unit — for disclosure, never conversion. */
function otherUnits(byUnit: Record<string, number>, matched: string): Record<string, number> | undefined {
  const rest: Record<string, number> = {};
  for (const [unit, value] of Object.entries(byUnit)) {
    if (unit !== matched && value > 0) rest[unit] = value;
  }
  return Object.keys(rest).length ? rest : undefined;
}

function buildAttainment(
  targets: WeeklyTargets,
  derived: DerivedTargets,
  actuals: WindowActuals,
  weeksInWindow: number,
): TargetAttainment[] {
  const out: TargetAttainment[] = [];

  // Scalar keys only — vert/distance carry a unit and go through pushQuantity.
  const push = (key: ScalarTargetKey, actual: number) => {
    const authored = targetValue(targets, key);
    const source: 'authored' | 'derived' = authored !== undefined ? 'authored' : 'derived';
    const target = authored ?? derived[key] ?? 0;
    if (!(target > 0)) return;   // nothing authored and nothing on the calendar
    // longSessionMinutes is a per-session threshold, not a weekly quantity:
    // the window target is the threshold itself, compared to the longest
    // session in the window.
    const targetForWindow = key === 'longSessionMinutes' ? target : target * weeksInWindow;
    out.push({
      key,
      label:  TARGET_META[key].label,
      unit:   targetUnit(targets, key),
      target,
      source,
      targetForWindow,
      actual,
      pct:    ratio(actual, targetForWindow),
    });
  };

  push('cardioMinutes', actuals.cardioMinutes);
  push('strengthSessions', actuals.strengthSessions);
  push('climbingSessions', actuals.climbingSessions);
  push('longSessionMinutes', actuals.longestSessionMinutes);

  // Quantity targets sum only the matching unit; everything else is disclosed.
  const vertUnit = targets.vert?.unit ?? dominantUnit(derived._vertUnits);
  if (vertUnit) {
    pushQuantity('vert', vertUnit, actuals.elevationByUnit, derived._vertUnits);
  }
  const distUnit = targets.distance?.unit ?? dominantUnit(derived._distanceUnits);
  if (distUnit) {
    pushQuantity('distance', distUnit, actuals.distanceByUnit, derived._distanceUnits);
  }

  function pushQuantity(
    key: 'vert' | 'distance',
    unit: string,
    actualByUnit: Record<string, number>,
    derivedByUnit: Record<string, number>,
  ) {
    const authored = targets[key]?.value;
    const source: 'authored' | 'derived' = authored !== undefined ? 'authored' : 'derived';
    const perWeek = authored ?? (weeksInWindow > 0 ? (derivedByUnit[unit] ?? 0) / weeksInWindow : 0);
    if (!(perWeek > 0)) return;
    const targetForWindow = perWeek * weeksInWindow;
    const actual = actualByUnit[unit] ?? 0;
    out.push({
      key,
      label: TARGET_META[key].label,
      unit,
      target: perWeek,
      source,
      targetForWindow,
      actual,
      pct: ratio(actual, targetForWindow),
      ...(otherUnits(actualByUnit, unit) ? { unmatchedUnits: otherUnits(actualByUnit, unit) } : {}),
    });
  }

  return out;
}

/** The unit with the most planned volume — used when no target names a unit. */
function dominantUnit(byUnit: Record<string, number>): string | null {
  const entries = Object.entries(byUnit).filter(([, v]) => v > 0);
  if (!entries.length) return null;
  return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Block progress as of `today`. `today` is a parameter, never read from the
 * clock inside, so tests and the app's fake clock drive it identically.
 */
export function computeBlockProgress(inputs: BlockProgressInputs, today: Date): BlockProgress {
  const { block, completions, sessions, setLogs, cardioLogs, plannedEvents } = inputs;
  const period = blockPeriod(block);
  const weeksTotal = blockWeeks(block);
  const elapsed = weeksElapsed(block, today);

  const weeks: BlockWeekProgress[] = enumerateWeeks(block).map(week => {
    const weekPeriod: StatsPeriod = {
      startDate:        week.startDate,
      endDateExclusive: week.endDateExclusive,
      periodType:       'block',
      label:            rangeLabel(week.startDate, week.endDateExclusive),
      weeksInPeriod:    1,
    };
    const actuals = windowActuals(completions, sessions, cardioLogs, weekPeriod);
    const derived = derivedTargets(plannedEvents, weekPeriod, 1);
    return {
      index:            week.index,
      startDate:        week.startDate,
      endDateExclusive: week.endDateExclusive,
      isComplete:       week.index <= elapsed,
      sessionsCompleted: actuals.sessionsCompleted,
      attainment:       buildAttainment(block.weeklyTargets, derived, actuals, 1),
    };
  });

  // Block-to-date covers only COMPLETED weeks, and prorates by those. Week 1
  // of an 8-week block must not read as 12% just because 7 weeks haven't
  // happened yet; the in-progress week is reported separately in `weeks`.
  const toDatePeriod: StatsPeriod = {
    startDate:        block.startDate,
    endDateExclusive: elapsed > 0 ? weeks[elapsed - 1].endDateExclusive : block.startDate,
    periodType:       'block',
    label:            rangeLabel(
      block.startDate,
      elapsed > 0 ? weeks[elapsed - 1].endDateExclusive : block.startDate,
    ),
    weeksInPeriod:    elapsed,
  };
  const toDateActuals = windowActuals(completions, sessions, cardioLogs, toDatePeriod);
  const toDateDerived = derivedTargets(plannedEvents, toDatePeriod, elapsed);

  // The one full-history pass: PR detection needs every prior log, so this
  // runs once for the whole block rather than per week.
  const stats = computeReviewStats({ period, completions, sessions, setLogs, cardioLogs });

  return {
    block,
    period,
    weeksTotal,
    weeksElapsed: elapsed,
    currentWeek: currentWeekIndex(block, today),
    weeks,
    toDate: {
      attainment: buildAttainment(block.weeklyTargets, toDateDerived, toDateActuals, elapsed),
      stats,
    },
    prs: stats.prs,
  };
}
