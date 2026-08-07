import { timeToMinutes } from '../time';

// Column layout for the week view's timed events: overlapping events split
// the day column side by side, calendar-style. Extracted from WeekView so
// the O(n²) interval logic is testable pure code.

export interface TimedEvent {
  startTime?: string;
  /** Minutes. */
  estimatedDuration: number;
}

export interface WeekLayout {
  /** Column index per event (same order as the input). */
  columns: number[];
  /** Total columns each event shares its width with (max overlapping column + 1). */
  colCounts: number[];
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart < bEnd && aEnd > bStart;

/**
 * Assigns each event the lowest column not taken by an earlier overlapping
 * event, then sizes every event by the highest column among its overlaps.
 * Events must have a startTime.
 */
export function layoutDayEvents(events: TimedEvent[]): WeekLayout {
  const starts = events.map(e => timeToMinutes(e.startTime));
  const ends = events.map((e, i) => starts[i] + e.estimatedDuration);

  const columns: number[] = [];
  events.forEach((_, i) => {
    const taken = new Set<number>();
    for (let j = 0; j < i; j++) {
      if (overlaps(starts[i], ends[i], starts[j], ends[j])) taken.add(columns[j]);
    }
    let col = 0;
    while (taken.has(col)) col++;
    columns[i] = col;
  });

  const colCounts = events.map((_, i) => {
    let maxCol = columns[i];
    events.forEach((_, j) => {
      if (i !== j && overlaps(starts[i], ends[i], starts[j], ends[j])) {
        maxCol = Math.max(maxCol, columns[j]);
      }
    });
    return maxCol + 1;
  });

  return { columns, colCounts };
}
