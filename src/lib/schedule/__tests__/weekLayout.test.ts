import { describe, it, expect } from 'vitest';
import { layoutDayEvents } from '../weekLayout';

const ev = (startTime: string, estimatedDuration: number) => ({ startTime, estimatedDuration });

describe('layoutDayEvents', () => {
  it('gives non-overlapping events full width in column 0', () => {
    const { columns, colCounts } = layoutDayEvents([
      ev('6:00 AM', 60),
      ev('8:00 AM', 60),
    ]);
    expect(columns).toEqual([0, 0]);
    expect(colCounts).toEqual([1, 1]);
  });

  it('splits two overlapping events into two columns', () => {
    const { columns, colCounts } = layoutDayEvents([
      ev('6:00 AM', 90),
      ev('7:00 AM', 60),
    ]);
    expect(columns).toEqual([0, 1]);
    expect(colCounts).toEqual([2, 2]);
  });

  it('touching events (end == start) do not overlap', () => {
    const { columns, colCounts } = layoutDayEvents([
      ev('6:00 AM', 60),
      ev('7:00 AM', 60),
    ]);
    expect(columns).toEqual([0, 0]);
    expect(colCounts).toEqual([1, 1]);
  });

  it('stacks a triple overlap into three columns', () => {
    const { columns, colCounts } = layoutDayEvents([
      ev('6:00 AM', 180),
      ev('6:30 AM', 60),
      ev('7:00 AM', 60),
    ]);
    expect(columns).toEqual([0, 1, 2]);
    expect(colCounts).toEqual([3, 3, 3]);
  });

  it('reuses a freed column and only widens the events actually overlapped', () => {
    // A long event, one early overlap, one late overlap: the early slot's
    // column frees up for the late one, and each pair renders at half width.
    const { columns, colCounts } = layoutDayEvents([
      ev('6:00 AM', 240),
      ev('6:00 AM', 60),
      ev('8:00 AM', 60),
    ]);
    expect(columns).toEqual([0, 1, 1]);
    expect(colCounts).toEqual([2, 2, 2]);
  });

  it('handles PM times and empty input', () => {
    expect(layoutDayEvents([])).toEqual({ columns: [], colCounts: [] });
    const { columns } = layoutDayEvents([ev('12:00 PM', 60), ev('12:30 PM', 30)]);
    expect(columns).toEqual([0, 1]);
  });
});
