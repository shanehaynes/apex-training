import type { SetLogRow } from '../db/types.js';
import type { TrackedSectionGroup } from './plan.js';
import { bestHistoricalOneRM } from './records.js';
import { displayWeight, lbToUnit, unitToLb, type WeightContext, type WeightUnit } from './weight.js';

// ─── Percent-of-1RM targets ──────────────────────────────────────────────────
// A planned weight of "80%" means 80% of the lift's best estimated 1RM. It is
// resolved here, at tracker bootstrap, against the athlete's history — never
// by parseWeight, which reads "80%" as no weight at all (ruling R1.4), so an
// unresolved percentage can never become a lift in tonnage or a record. The
// stored plan and the logged rows keep the text as written; the resolved
// number rides the tracker model only.

export const PERCENT_MIN = 1;
export const PERCENT_MAX = 150;

/** The smallest load change a gym makes in each unit: a pair of 1.25 lb / 0.5 kg plates. */
export const PLATE_STEP: Record<WeightUnit, number> = { lb: 2.5, kg: 1 };

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
 * nearest plate step in the profile's unit (2.5 lb, 1 kg) and printed in
 * that unit without a suffix. `lb` is the rounded load in pounds. Null when
 * the text is not a percentage, there is no positive 1RM to take it of, or
 * the load rounds to nothing.
 */
export function resolvePercentWeight(
  text: string | null | undefined,
  bestOneRMLb: number | null | undefined,
  ctx: WeightContext,
): { lb: number; display: string } | null {
  const percent = parsePercent(text);
  if (percent === null) return null;
  if (typeof bestOneRMLb !== 'number' || !Number.isFinite(bestOneRMLb) || bestOneRMLb <= 0) return null;
  const step = PLATE_STEP[ctx.unit];
  const rounded = Math.round((lbToUnit(bestOneRMLb, ctx.unit) * percent) / 100 / step) * step;
  if (!(rounded > 0)) return null;
  const lb = unitToLb(rounded, ctx.unit);
  return { lb, display: displayWeight(lb, ctx.unit) };
}

/** Whether any planned set in the model is a percentage — the bootstrap reads the weight context only then. */
export function hasPercentTargets(groups: TrackedSectionGroup[]): boolean {
  return groups.some(g => g.exercises.some(t =>
    !t.isCardio && t.exercise.category !== 'climbing' && t.sets.some(s => parsePercent(s.planned.targetWeight) !== null)));
}

/**
 * The model with every percentage target resolved: `resolvedPlannedWeight`
 * set on each set whose planned weight is a percentage of a lift with a
 * prior estimated 1RM (bestHistoricalOneRM over `history`, read under
 * `ctx`). Uniform and per-set targets alike — both arrive as the set's
 * planned weight. A pitch's weight column is a grade and cardio has no
 * sets, so neither resolves; with no history the field stays absent and
 * the raw text shows. Keyed by the movement being logged, so a swapped
 * exercise resolves against its own history.
 */
export function resolvePercentTargets(
  groups: TrackedSectionGroup[],
  history: SetLogRow[],
  ctx: WeightContext,
): TrackedSectionGroup[] {
  if (!hasPercentTargets(groups)) return groups;
  const best = bestHistoricalOneRM(history, ctx);
  return groups.map(group => ({
    ...group,
    exercises: group.exercises.map(tracked => {
      if (tracked.isCardio || tracked.exercise.category === 'climbing') return tracked;
      const oneRM = best.get(tracked.exercise.name)?.oneRM;
      if (oneRM === undefined) return tracked;
      return {
        ...tracked,
        sets: tracked.sets.map(set => {
          const resolved = resolvePercentWeight(set.planned.targetWeight, oneRM, ctx);
          return resolved ? { ...set, resolvedPlannedWeight: resolved.display } : set;
        }),
      };
    }),
  }));
}
