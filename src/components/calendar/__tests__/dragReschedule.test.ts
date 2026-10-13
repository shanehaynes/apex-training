import { describe, it, expect } from 'vitest';
import {
  exceedsThreshold,
  snapMinutes,
  eventDurationMinutes,
  weekStartMinutes,
  weekMinutesToTop,
  monthDropFields,
  weekDropFields,
  WEEK_GRID,
  WEEK_DAY_END,
} from '../useDragReschedule';

// The geometry behind drag-to-reschedule, kept pure so it is provable without
// a DOM: when a press becomes a drag, where a week block lands, and what a
// drop sends to rescheduleEvent. The gestures themselves are proved in
// e2e/mock/calendar-drag.spec.ts.

const STRETCH = { date: '2026-09-08', startTime: '9:30 PM', endTime: '10:00 PM', estimatedDuration: 30 };

describe('exceedsThreshold', () => {
  it('a press that wanders under 5px is still a click', () => {
    expect(exceedsThreshold(3, 3)).toBe(false);
    expect(exceedsThreshold(0, 4.9)).toBe(false);
  });

  it('5px of travel in any direction is a drag', () => {
    expect(exceedsThreshold(5, 0)).toBe(true);
    expect(exceedsThreshold(-4, -3)).toBe(true);
  });
});

describe('snapMinutes', () => {
  it('rounds to the nearest quarter hour', () => {
    expect(snapMinutes(1167)).toBe(1170);  // 19:27 → 19:30
    expect(snapMinutes(1172)).toBe(1170);
    expect(snapMinutes(1178)).toBe(1185);  // 19:38 → 19:45
  });
});

describe('eventDurationMinutes', () => {
  it('is end − start when both are set', () => {
    expect(eventDurationMinutes(STRETCH)).toBe(30);
  });

  it('falls back to the estimate without an end, or with an end before the start', () => {
    expect(eventDurationMinutes({ startTime: '9:30 PM', estimatedDuration: 45 })).toBe(45);
    expect(eventDurationMinutes({ startTime: '9:30 PM', endTime: '9:00 PM', estimatedDuration: 45 })).toBe(45);
  });
});

describe('weekStartMinutes', () => {
  const colTop = 100;

  it('maps the block top back through the grid and snaps to 15 minutes', () => {
    // 9:30 PM sits at 16.5h × 56px = 924px from the column top.
    expect(weekStartMinutes(colTop + 924, colTop, 30)).toBe(21 * 60 + 30);
    // Two hours up (112px) lands at 7:30 PM.
    expect(weekStartMinutes(colTop + 924 - 112, colTop, 30)).toBe(19 * 60 + 30);
    // 20px off the hour (~21 min) rounds to the quarter.
    expect(weekStartMinutes(colTop + 924 - 20, colTop, 30)).toBe(21 * 60 + 15);
  });

  it('never leaves the grid: not before 5 AM, not past the bottom with the block attached', () => {
    expect(weekStartMinutes(colTop - 500, colTop, 30)).toBe(WEEK_GRID.dayStart);
    expect(weekStartMinutes(colTop + 5000, colTop, 30)).toBe(WEEK_DAY_END - 30);
    // A block longer than the grid pins to the top rather than going negative.
    expect(weekStartMinutes(colTop + 5000, colTop, 24 * 60)).toBe(WEEK_GRID.dayStart);
  });

  it('round-trips with weekMinutesToTop', () => {
    const minutes = 7 * 60 + 15;
    expect(weekStartMinutes(colTop + weekMinutesToTop(minutes), colTop, 30)).toBe(minutes);
  });
});

describe('monthDropFields', () => {
  it('moves only the date', () => {
    expect(monthDropFields(STRETCH, '2026-09-10')).toEqual({ date: '2026-09-10' });
  });

  it('is a no-op on the same day', () => {
    expect(monthDropFields(STRETCH, '2026-09-08')).toBeNull();
  });
});

describe('weekDropFields', () => {
  it('moves the start and drags the end along, keeping the duration', () => {
    expect(weekDropFields(STRETCH, '2026-09-08', 19 * 60 + 30))
      .toEqual({ date: '2026-09-08', startTime: '7:30 PM', endTime: '8:00 PM' });
  });

  it('carries a column change as a date change', () => {
    expect(weekDropFields(STRETCH, '2026-09-11', 21 * 60 + 30))
      .toEqual({ date: '2026-09-11', startTime: '9:30 PM', endTime: '10:00 PM' });
  });

  it('leaves the end alone when the event never had one', () => {
    expect(weekDropFields({ ...STRETCH, endTime: undefined }, '2026-09-08', 19 * 60 + 30))
      .toEqual({ date: '2026-09-08', startTime: '7:30 PM' });
  });

  it('is a no-op when neither the day nor the snapped start changed', () => {
    expect(weekDropFields(STRETCH, '2026-09-08', 21 * 60 + 30)).toBeNull();
    // Stored as 24h, compared by minutes rather than string.
    expect(weekDropFields({ ...STRETCH, startTime: '21:30' }, '2026-09-08', 21 * 60 + 30)).toBeNull();
  });
});
