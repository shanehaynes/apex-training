import { describe, expect, it } from 'vitest';
import { parseISO, startOfISOWeek } from 'date-fns';
import {
  blockCovering,
  blockCovers,
  blockPeriod,
  blockWeeks,
  currentWeekIndex,
  enumerateWeeks,
  weeksElapsed,
} from '../period';
import type { TrainingBlock } from '../../../types/blocks';

// 2026-03-02 and 2026-04-27 are both Mondays — an 8-week block.
const block = (over: Partial<TrainingBlock> = {}): TrainingBlock => ({
  id: 'blk-1',
  name: 'Fall Aerobic Foundation',
  intent: '',
  startDate: '2026-03-02',
  endDateExclusive: '2026-04-27',
  weeklyTargets: {},
  ...over,
});

describe('blockWeeks', () => {
  it('counts whole ISO weeks', () => {
    expect(blockWeeks(block())).toBe(8);
    expect(blockWeeks(block({ endDateExclusive: '2026-03-09' }))).toBe(1);
    expect(blockWeeks(block({ endDateExclusive: '2026-03-30' }))).toBe(4);
  });
});

describe('blockPeriod', () => {
  it('is a field rename with no date arithmetic', () => {
    const period = blockPeriod(block());
    expect(period.startDate).toBe('2026-03-02');
    expect(period.endDateExclusive).toBe('2026-04-27');
    expect(period.periodType).toBe('block');
    expect(period.weeksInPeriod).toBe(8);
  });

  it('labels the inclusive last day, not the exclusive end', () => {
    // Ends exclusive 2026-04-27 (Mon), so the readable end is Sun 2026-04-26.
    expect(blockPeriod(block()).label).toBe('Mar 2 – Apr 26, 2026');
  });
});

describe('enumerateWeeks', () => {
  it('produces contiguous half-open weeks covering the block exactly', () => {
    const weeks = enumerateWeeks(block());
    expect(weeks).toHaveLength(8);
    expect(weeks[0]).toEqual({ index: 1, startDate: '2026-03-02', endDateExclusive: '2026-03-09' });
    expect(weeks[7].endDateExclusive).toBe('2026-04-27');
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i].startDate).toBe(weeks[i - 1].endDateExclusive);
    }
  });

  // The composition claim the whole design rests on: block weeks line up with
  // the ISO weeks computeReviewStats already buckets by (stats.ts uses
  // startOfISOWeek), so block aggregation and review aggregation agree.
  it('week starts equal startOfISOWeek of every date inside them', () => {
    for (const week of enumerateWeeks(block())) {
      for (let d = 0; d < 7; d++) {
        const date = new Date(parseISO(week.startDate).getTime() + d * 86_400_000);
        expect(startOfISOWeek(date).toISOString().slice(0, 10)).toBe(week.startDate);
      }
    }
  });
});

describe('weeksElapsed', () => {
  it('is 0 before the block starts', () => {
    expect(weeksElapsed(block(), parseISO('2026-02-23'))).toBe(0);
  });

  it('is 0 during the first week — week 1 is not yet complete', () => {
    expect(weeksElapsed(block(), parseISO('2026-03-02'))).toBe(0);
    expect(weeksElapsed(block(), parseISO('2026-03-08'))).toBe(0);
  });

  it('counts only COMPLETED weeks', () => {
    expect(weeksElapsed(block(), parseISO('2026-03-09'))).toBe(1);
    expect(weeksElapsed(block(), parseISO('2026-03-18'))).toBe(2);
  });

  it('clamps to the block length once it has ended', () => {
    expect(weeksElapsed(block(), parseISO('2026-04-27'))).toBe(8);
    expect(weeksElapsed(block(), parseISO('2027-01-01'))).toBe(8);
  });
});

describe('currentWeekIndex', () => {
  it('is 1-based inside the block and null outside it', () => {
    expect(currentWeekIndex(block(), parseISO('2026-03-02'))).toBe(1);
    expect(currentWeekIndex(block(), parseISO('2026-03-10'))).toBe(2);
    expect(currentWeekIndex(block(), parseISO('2026-02-23'))).toBeNull();
    expect(currentWeekIndex(block(), parseISO('2026-04-27'))).toBeNull();
  });
});

describe('blockCovers / blockCovering', () => {
  it('is half-open: start inclusive, end exclusive', () => {
    expect(blockCovers(block(), '2026-03-02')).toBe(true);
    expect(blockCovers(block(), '2026-04-26')).toBe(true);
    expect(blockCovers(block(), '2026-04-27')).toBe(false);
    expect(blockCovers(block(), '2026-03-01')).toBe(false);
  });

  it('picks the single covering block, or null', () => {
    const a = block({ id: 'a' });
    const b = block({ id: 'b', startDate: '2026-04-27', endDateExclusive: '2026-05-25' });
    expect(blockCovering([a, b], '2026-03-10')?.id).toBe('a');
    expect(blockCovering([a, b], '2026-05-01')?.id).toBe('b');
    expect(blockCovering([a, b], '2026-06-01')).toBeNull();
  });
});
