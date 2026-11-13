/**
 * A tracked session left running: the athlete forgot Finish, and the timer
 * kept counting until they came back. At Finish the tracker asks when it
 * really ended (docs/specs/tracker-runaway-finish). This module decides when
 * to ask and what to offer; the clients only render it.
 *
 * The thresholds come from the 2026-11-08 measurement in that spec's plan:
 * every normal session sat at or under 2.31× its plan and 1.57 h, every
 * runaway at or over 7.03× and 3.40 h. iOS ports this file (D-061); both
 * suites run `ios/Packages/ApexCore/Tests/ApexCoreTests/Fixtures/runaway-finish.json`,
 * so a change here fails there until the port follows.
 */

/** More than this many times the planned length… */
export const RUNAWAY_PLAN_MULTIPLE = 4;
/** …and more than this long, in seconds. */
export const RUNAWAY_FLOOR_SECONDS = 2 * 60 * 60;

/** A positive, finite number of minutes, or null: anything else is no plan. */
function planMinutes(plannedMinutes: number | null | undefined): number | null {
  return typeof plannedMinutes === 'number' && Number.isFinite(plannedMinutes) && plannedMinutes > 0
    ? plannedMinutes
    : null;
}

/**
 * True when a session has run more than 4× its plan and more than 2 hours.
 * Exactly at either bound is not a runaway; a session with no plan never is.
 */
export function isRunaway(elapsedSeconds: number, plannedMinutes: number | null | undefined): boolean {
  const plan = planMinutes(plannedMinutes);
  if (plan === null || !Number.isFinite(elapsedSeconds)) return false;
  return elapsedSeconds > RUNAWAY_FLOOR_SECONDS && elapsedSeconds > RUNAWAY_PLAN_MULTIPLE * plan * 60;
}

/** Where a suggested finish came from, so the prompt can say so. */
export type FinishBasis = 'last-logged' | 'plan' | 'now';

export interface SuggestedFinish {
  atMs: number;
  basis: FinishBasis;
}

export interface FinishClock {
  startedAtMs: number;
  nowMs: number;
  plannedMinutes: number | null | undefined;
  /** The latest instant a set or cardio row was logged, if any. */
  lastLoggedMs: number | null;
}

/**
 * When the session most likely ended: the last logged set when it falls
 * after the start and no later than now; otherwise the start plus the plan,
 * never past now; with no plan either, now.
 */
export function suggestFinish({ startedAtMs, nowMs, plannedMinutes, lastLoggedMs }: FinishClock): SuggestedFinish {
  if (lastLoggedMs !== null && Number.isFinite(lastLoggedMs) && lastLoggedMs > startedAtMs && lastLoggedMs <= nowMs) {
    return { atMs: lastLoggedMs, basis: 'last-logged' };
  }
  const plan = planMinutes(plannedMinutes);
  if (plan === null) return { atMs: nowMs, basis: 'now' };
  return { atMs: Math.min(nowMs, startedAtMs + plan * 60_000), basis: 'plan' };
}

export interface RunawayFinish {
  elapsedSeconds: number;
  plannedMinutes: number;
  suggestion: SuggestedFinish;
}

/** What the Finish prompt needs, or null when Finish should go straight through. */
export function detectRunaway(clock: FinishClock): RunawayFinish | null {
  const elapsedSeconds = (clock.nowMs - clock.startedAtMs) / 1000;
  const plan = planMinutes(clock.plannedMinutes);
  if (plan === null || !isRunaway(elapsedSeconds, plan)) return null;
  return { elapsedSeconds, plannedMinutes: plan, suggestion: suggestFinish(clock) };
}

/**
 * The latest `updated_at` among rows the athlete logged (autofilled rows are
 * the finish's zero-fills, not sets), as the row carried it; null for none.
 * The server stamps `updated_at` on every save, so this is when the last set
 * or cardio row reached it.
 */
export function latestLoggedAt(
  rows: ReadonlyArray<{ updated_at?: string | null; is_autofilled?: boolean | null }>,
): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const row of rows) {
    if (row.is_autofilled || typeof row.updated_at !== 'string') continue;
    const ms = Date.parse(row.updated_at);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = row.updated_at;
      bestMs = ms;
    }
  }
  return best;
}

/** "29 min", "3 h 24 min", "19 d 15 h": whole minutes, rounded down, like a timer. */
export function formatRunawayLength(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}
