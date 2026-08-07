import { addDays, differenceInCalendarDays, format, parseISO, startOfISOWeek } from 'date-fns';
import type { StatsPeriod } from '../review/types';
import { rangeLabel } from '../review/isoMonth';
import type { TrainingBlock } from '../../types/blocks';

// ─── Block date windows ───────────────────────────────────────────────────────
// Deliberately NOT in src/lib/review/isoMonth.ts — that module is specifically
// the 13-month training calendar. A block is an arbitrary Monday-aligned range.
//
// Blocks store [startDate, endDateExclusive) with both ends on a Monday, the
// same convention as Period, so building a StatsPeriod is a field rename with
// no date arithmetic and weeksInPeriod is always a whole number.

export const DAY_MS = 86_400_000;

/** Whole ISO weeks in a block. Exact by construction: both ends are Mondays. */
export function blockWeeks(block: Pick<TrainingBlock, 'startDate' | 'endDateExclusive'>): number {
  const days = differenceInCalendarDays(
    parseISO(block.endDateExclusive),
    parseISO(block.startDate),
  );
  return Math.round(days / 7);
}

/** The whole block as an aggregation window. */
export function blockPeriod(block: TrainingBlock): StatsPeriod {
  return {
    startDate:        block.startDate,
    endDateExclusive: block.endDateExclusive,
    periodType:       'block',
    label:            rangeLabel(block.startDate, block.endDateExclusive),
    weeksInPeriod:    blockWeeks(block),
  };
}

export interface BlockWeek {
  /** 1-based, as displayed ("week 3 of 8"). */
  index: number;
  startDate: string;
  endDateExclusive: string;
}

/** Every ISO week in the block, in order. */
export function enumerateWeeks(block: TrainingBlock): BlockWeek[] {
  const total = blockWeeks(block);
  const start = parseISO(block.startDate);
  const weeks: BlockWeek[] = [];
  for (let i = 0; i < total; i++) {
    weeks.push({
      index:            i + 1,
      startDate:        format(addDays(start, i * 7), 'yyyy-MM-dd'),
      endDateExclusive: format(addDays(start, (i + 1) * 7), 'yyyy-MM-dd'),
    });
  }
  return weeks;
}

/**
 * Whole weeks COMPLETED as of `today`, clamped to [0, blockWeeks].
 *
 * Block-to-date attainment prorates by this, not by the block length —
 * otherwise week 1 of an 8-week block always reads as 12% and looks like
 * failure. The in-progress week is reported separately.
 *
 * `today` is a parameter, never `new Date()` inside, so tests and the fake
 * clock can drive it.
 */
export function weeksElapsed(block: TrainingBlock, today: Date): number {
  const dayString = format(today, 'yyyy-MM-dd');
  if (dayString < block.startDate) return 0;
  if (dayString >= block.endDateExclusive) return blockWeeks(block);
  const weekStart = format(startOfISOWeek(today), 'yyyy-MM-dd');
  const elapsed = differenceInCalendarDays(parseISO(weekStart), parseISO(block.startDate)) / 7;
  return Math.max(0, Math.min(blockWeeks(block), Math.round(elapsed)));
}

/** The in-progress week (1-based), or null when the block hasn't started or has ended. */
export function currentWeekIndex(block: TrainingBlock, today: Date): number | null {
  const dayString = format(today, 'yyyy-MM-dd');
  if (dayString < block.startDate || dayString >= block.endDateExclusive) return null;
  return weeksElapsed(block, today) + 1;
}

/** True when `date` (YYYY-MM-DD) falls inside the block's half-open range. */
export function blockCovers(block: TrainingBlock, date: string): boolean {
  return date >= block.startDate && date < block.endDateExclusive;
}

/**
 * The block covering `date`, or null. Single-valued because the DB exclusion
 * constraint forbids overlap — this is what makes block membership derivable
 * from event_date alone, with no block_id column on workout_events.
 */
export function blockCovering(blocks: TrainingBlock[], date: string): TrainingBlock | null {
  return blocks.find(b => blockCovers(b, date)) ?? null;
}
