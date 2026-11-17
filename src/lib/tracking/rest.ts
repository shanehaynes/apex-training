/**
 * The rest prescription (`Exercise.restPeriod`) is free text. The rest timer
 * pre-fills from it only when it reads unambiguously as one duration:
 *
 *   "90s" · "90 sec" · "2 min" · "1:30" · a range "2-3 min" / "60–90s"
 *
 * A range takes its lower end with the shared unit. Anything else — "as
 * needed", "0", empty, a bare number, "90 sec/side" — is no timer at all:
 * a wrong countdown is worse than none. Strict on purpose, and separate from
 * `parseDurationSeconds` (records.ts), which reads a leading duration out of
 * free text and so turns "2-3 min" into two seconds.
 */

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const SECONDS = String.raw`(?:s|secs?|seconds?)`;
const MINUTES = String.raw`(?:mins?|minutes?)`;
const UNIT = `(${SECONDS}|${MINUTES})`;

const SINGLE = new RegExp(`^${NUMBER}\\s*${UNIT}$`);
const RANGE = new RegExp(`^${NUMBER}\\s*[-–]\\s*${NUMBER}\\s*${UNIT}$`);
const CLOCK = /^(\d+):([0-5]\d)$/;

function toSeconds(n: string, unit: string): number | null {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return null;
  const seconds = Math.round(/^m/.test(unit) ? value * 60 : value);
  return seconds > 0 ? seconds : null;
}

/** Whole seconds for the rest text, or null when no timer should start. */
export function parseRestSeconds(text: string | null | undefined): number | null {
  if (!text) return null;
  const v = text.trim().toLowerCase();
  if (!v) return null;

  const clock = v.match(CLOCK);
  if (clock) {
    const seconds = Number(clock[1]) * 60 + Number(clock[2]);
    return seconds > 0 ? seconds : null;
  }

  const range = v.match(RANGE);
  if (range) {
    const low = toSeconds(range[1], range[3]);
    const high = toSeconds(range[2], range[3]);
    // "90-60s" is not a range anyone meant.
    return low !== null && high !== null && high >= low ? low : null;
  }

  const single = v.match(SINGLE);
  if (single) return toSeconds(single[1], single[2]);

  return null;
}

// ─── Per-set rest ────────────────────────────────────────────────────────────

/**
 * The rest after one set: the row's own `targetRest` when it overrides the
 * exercise, else the exercise's `restPeriod`. An extra set (no plan row)
 * rests like the exercise.
 */
export function restFor(planned: { targetRest?: string } | undefined, restPeriod: string | undefined): string | undefined {
  return planned?.targetRest?.trim() || restPeriod?.trim() || undefined;
}

/**
 * The rest line on a tracker card, from each planned set's rest in order.
 * One value for every set reads as itself ("90s"); sets that differ read as
 * runs in set order, a run longer than one carrying its count
 * ("2 min ×3 · 90s"), and a set with no rest as "none". Null when no set has
 * a rest. The numbers are the athlete's own text, never recomputed.
 */
export function restSummary(rests: ReadonlyArray<string | undefined>): string | null {
  const values = rests.map(r => r?.trim() || '');
  if (!values.some(Boolean)) return null;
  const runs: { value: string; count: number }[] = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && last.value === value) last.count += 1;
    else runs.push({ value, count: 1 });
  }
  if (runs.length === 1) return runs[0].value;
  return runs.map(r => `${r.value || 'none'}${r.count > 1 ? ` ×${r.count}` : ''}`).join(' · ');
}

/**
 * A tracker card's rest line: `restSummary` over the planned sets (extras
 * are not planned), each set's rest per `restFor`; the exercise's own rest
 * when there are no planned sets (cardio). Null when nothing rests.
 */
export function restLine(tracked: {
  exercise: { restPeriod?: string };
  sets: ReadonlyArray<{ isExtra: boolean; planned: { targetRest?: string } }>;
}): string | null {
  const planned = tracked.sets.filter(s => !s.isExtra);
  if (!planned.length) return tracked.exercise.restPeriod?.trim() || null;
  return restSummary(planned.map(s => restFor(s.planned, tracked.exercise.restPeriod)));
}
