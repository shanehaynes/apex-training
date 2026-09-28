import { describe, it, expect } from 'vitest';
import { visibleAnnotationRange } from '../annotations';

// The provider fetches one range per calendar date: the Monday-aligned month
// grid that holds it. Pinned here because every view reads from it — a
// range that missed the grid's leading or trailing week would render a day
// with no chips for no visible reason.

describe('visibleAnnotationRange', () => {
  it('covers the whole six-week grid around a mid-month date', () => {
    // September 2026: the 1st is a Tuesday, the 30th a Wednesday.
    expect(visibleAnnotationRange(new Date(2026, 8, 7))).toEqual({ from: '2026-08-31', to: '2026-10-04' });
  });

  it('is the same range for every date in the month, so a week or day step never refetches', () => {
    const first = visibleAnnotationRange(new Date(2026, 8, 1));
    const last = visibleAnnotationRange(new Date(2026, 8, 30));
    expect(first).toEqual(last);
  });

  it('starts on the 1st when the month begins on a Monday', () => {
    // June 2026 begins on a Monday and ends on a Tuesday.
    expect(visibleAnnotationRange(new Date(2026, 5, 15))).toEqual({ from: '2026-06-01', to: '2026-07-05' });
  });
});
