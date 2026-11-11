import { format, parseISO } from 'date-fns';
import { canonicalDurationText, type QuarterBest } from './records.js';
import { withExplicitUnit, type WeightContext } from './weight.js';

// How the tracker reads a quarterly best (records.ts, bestSetsThisQuarter):
// one line per field the set was logged with, in the tracker's column order
// (weight, reps, time), each standing on its own because the line shows one
// at a time.

/** "185 lb", "5 reps", "1:30": the set's filled fields, each readable alone. */
export function quarterBestFields(best: QuarterBest, ctx: WeightContext | null): string[] {
  const out: string[] = [];
  if (best.weight) out.push(ctx ? withExplicitUnit(best.weight, ctx) : best.weight);
  if (best.reps) {
    // A bare count needs its noun to read alone; "8 each leg" already says what it is.
    out.push(/^\d+$/.test(best.reps) ? `${best.reps} ${best.reps === '1' ? 'rep' : 'reps'}` : best.reps);
  }
  if (best.duration) out.push(canonicalDurationText(best.duration) ?? best.duration);
  return out;
}

/** "185 lb × 5": the whole set on one line, for a reader who gets no animation. */
export function quarterBestSummary(best: QuarterBest, ctx: WeightContext | null): string {
  const weight = best.weight ? (ctx ? withExplicitUnit(best.weight, ctx) : best.weight) : '';
  const duration = best.duration ? canonicalDurationText(best.duration) ?? best.duration : '';
  const parts: string[] = [];
  if (weight && best.reps) parts.push(`${weight} × ${best.reps}`);
  else if (weight) parts.push(weight);
  else if (best.reps) parts.push(quarterBestFields({ ...best, weight: '', duration: '' }, ctx)[0]);
  if (duration) parts.push(duration);
  return parts.join(', ');
}

/** "Q4 PR" — the column's heading. */
export function quarterBestHeading(best: QuarterBest): string {
  return `Q${best.quarter} PR`;
}

/** "Best set this quarter (Q4), logged Oct 14: 185 lb × 5" — the cell's full text for a screen reader. */
export function quarterBestDescription(best: QuarterBest, ctx: WeightContext | null): string {
  return `Best set this quarter (Q${best.quarter}), logged ${format(parseISO(best.date), 'MMM d')}: ${quarterBestSummary(best, ctx)}`;
}
