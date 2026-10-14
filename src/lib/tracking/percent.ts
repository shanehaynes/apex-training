import type { SetLogRow } from '../db/types.js';
import type { TrackedExercise, TrackedSectionGroup } from './plan.js';
import { classifySet, isPerformedSet, isPitchRow } from './records.js';
import { displayWeight, lbToUnit, unitToLb, type WeightContext, type WeightUnit } from './weight.js';

// ─── Percent-of-1RM targets ──────────────────────────────────────────────────
// A planned weight of "80%" means 80% of the lift's best estimated 1RM. It is
// resolved here, at tracker bootstrap, against the athlete's history — never
// by parseWeight, which reads "80%" as no weight at all (ruling R1.4), so an
// unresolved percentage can never become a lift in tonnage or a record. The
// stored plan and the logged rows keep the text as written; the resolved
// load rides the tracker model only, as text that names its unit.

export const PERCENT_MIN = 1;
export const PERCENT_MAX = 150;

/** The smallest load change a gym makes in each unit: a pair of 1.25 lb / 0.5 kg plates. */
export const PLATE_STEP: Record<WeightUnit, number> = { lb: 2.5, kg: 1 };

/** Above this many reps Epley overstates the max, so a set says nothing about what to load. */
export const MAX_BASIS_REPS = 12;

// Whole-string: a number (dot or comma decimal), optional spaces, a percent sign.
const GRAMMAR = /^\s*(\d+(?:[.,]\d+)?)\s*%\s*$/;

/** The percentage a planned weight names ("80%", " 72.5 % "), or null — including outside 1–150. */
export function parsePercent(text: string | null | undefined): number | null {
  if (text == null) return null;
  const match = GRAMMAR.exec(text);
  if (!match) return null;
  const percent = Number(match[1].replace(',', '.'));
  return Number.isFinite(percent) && percent >= PERCENT_MIN && percent <= PERCENT_MAX ? percent : null;
}

/**
 * A percentage target as a load: `percent` of `bestOneRMLb`, rounded to the
 * nearest plate step in the profile's unit (2.5 lb, 1 kg). `lb` is the
 * rounded load in pounds, `display` the number in the profile's unit
 * ("185"), `text` the load as it is stored — the number with its unit
 * ("185 lb", "80 kg") — so it never depends on what a reader assumes the
 * unit is. Null when the text is not a percentage, there is no positive
 * 1RM to take it of, or the load rounds to nothing.
 */
export function resolvePercentWeight(
  text: string | null | undefined,
  bestOneRMLb: number | null | undefined,
  ctx: WeightContext,
): { lb: number; display: string; text: string } | null {
  const percent = parsePercent(text);
  if (percent === null) return null;
  if (typeof bestOneRMLb !== 'number' || !Number.isFinite(bestOneRMLb) || bestOneRMLb <= 0) return null;
  const step = PLATE_STEP[ctx.unit];
  const rounded = Math.round((lbToUnit(bestOneRMLb, ctx.unit) * percent) / 100 / step) * step;
  if (!(rounded > 0)) return null;
  const lb = unitToLb(rounded, ctx.unit);
  const display = displayWeight(lb, ctx.unit);
  return { lb, display, text: `${display} ${ctx.unit}` };
}

/** The number of a resolved load, for labels: "185 lb" → "185". */
export function resolvedLoadNumber(resolved: string): string {
  return resolved.replace(/\s*(?:lb|kg)$/, '');
}

/**
 * The estimated 1RM a percentage is taken of, per exercise name: the best
 * prior performed set (no warm-ups, no autofills, no pitches) of at most
 * MAX_BASIS_REPS reps, read under `ctx`. Null for a lift whose best such set
 * was a bodyweight load ("BW+45"): its 1RM includes the body, so a
 * percentage of it is not a load anyone can put on a bar.
 */
export function percentBasis(history: SetLogRow[], ctx: WeightContext): Map<string, number | null> {
  const best = new Map<string, { oneRM: number; bodyweight: boolean }>();
  for (const row of history) {
    if (!isPerformedSet(row) || isPitchRow(row)) continue;
    const set = classifySet(row.actual_weight, row.actual_reps, row.actual_duration, ctx);
    if (set?.kind !== 'oneRM' || set.reps > MAX_BASIS_REPS) continue;
    const current = best.get(row.exercise_name);
    if (!current || set.oneRM > current.oneRM) {
      best.set(row.exercise_name, { oneRM: set.oneRM, bodyweight: set.load === 'bodyweight' });
    }
  }
  return new Map([...best].map(([name, b]) => [name, b.bodyweight ? null : b.oneRM]));
}

/** Whether any planned set in the model is a percentage — the bootstrap reads the weight context only then. */
export function hasPercentTargets(groups: TrackedSectionGroup[]): boolean {
  return groups.some(g => g.exercises.some(t =>
    !t.isCardio && t.exercise.category !== 'climbing' && t.sets.some(s => parsePercent(s.planned.targetWeight) !== null)));
}

/**
 * The model with every percentage target resolved: `resolvedPlannedWeight`
 * (the load with its unit) set on each set whose planned weight is a
 * percentage of a lift with a usable prior 1RM (percentBasis over
 * `history`, read under `ctx` — which must be the profile's KNOWN context,
 * never a default standing in for a failed read). Uniform and per-set
 * targets alike — both arrive as the set's planned weight. A pitch's
 * weight column is a grade and cardio has no sets, so neither resolves;
 * with no basis the field stays absent and the raw text shows. Keyed by
 * the movement being logged, so a swapped exercise resolves against its
 * own history.
 */
export function resolvePercentTargets(
  groups: TrackedSectionGroup[],
  history: SetLogRow[],
  ctx: WeightContext,
): TrackedSectionGroup[] {
  if (!hasPercentTargets(groups)) return groups;
  const basis = percentBasis(history, ctx);
  return groups.map(group => ({
    ...group,
    exercises: group.exercises.map(tracked => {
      if (tracked.isCardio || tracked.exercise.category === 'climbing') return tracked;
      const oneRM = basis.get(tracked.exercise.name);
      if (oneRM == null) return tracked;
      return {
        ...tracked,
        sets: tracked.sets.map(set => {
          const resolved = resolvePercentWeight(set.planned.targetWeight, oneRM, ctx);
          return resolved ? { ...set, resolvedPlannedWeight: resolved.text } : set;
        }),
      };
    }),
  }));
}

/**
 * An exercise with its resolved loads dropped — for a swap onto another
 * movement, whose percentage is of a different max. The raw target shows
 * until the next bootstrap resolves it against the new lift.
 */
export function clearResolvedLoads(tracked: TrackedExercise): TrackedExercise {
  if (!tracked.sets.some(s => s.resolvedPlannedWeight !== undefined)) return tracked;
  return {
    ...tracked,
    sets: tracked.sets.map(({ resolvedPlannedWeight: _dropped, ...set }) => set),
  };
}
