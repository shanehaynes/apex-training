import { describe, it, expect } from 'vitest';
import {
  getIsoMonth,
  isoWeeksInYear,
  lastCompletedIsoYear,
  lastCompletedMonth,
  monthBoundaries,
  periodLabel,
  weeksInMonth,
  yearBoundaries,
} from '../isoMonth';

describe('isoWeeksInYear', () => {
  it('knows 52- and 53-week ISO years', () => {
    expect(isoWeeksInYear(2020)).toBe(53);
    expect(isoWeeksInYear(2024)).toBe(52);
    expect(isoWeeksInYear(2025)).toBe(52);
    expect(isoWeeksInYear(2026)).toBe(53);
  });
});

describe('getIsoMonth', () => {
  it('maps weeks 1–4 to month 1 and weeks 49–52 to month 13', () => {
    // ISO 2024 starts Mon Jan 1.
    expect(getIsoMonth(new Date(2024, 0, 1))).toEqual({ isoYear: 2024, month: 1 });
    expect(getIsoMonth(new Date(2024, 0, 28))).toEqual({ isoYear: 2024, month: 1 });
    expect(getIsoMonth(new Date(2024, 0, 29))).toEqual({ isoYear: 2024, month: 2 });
    expect(getIsoMonth(new Date(2024, 11, 29))).toEqual({ isoYear: 2024, month: 13 });
  });

  it('folds week 53 into month 13', () => {
    // Jan 1 2027 is a Friday in ISO week 2026-W53.
    expect(getIsoMonth(new Date(2027, 0, 1))).toEqual({ isoYear: 2026, month: 13 });
  });

  it('assigns late-December days to the next ISO year', () => {
    // Dec 29 2025 is the Monday of ISO 2026-W01.
    expect(getIsoMonth(new Date(2025, 11, 29))).toEqual({ isoYear: 2026, month: 1 });
  });

  it('places leap day in the right month', () => {
    // Feb 29 2020 (Saturday) is in ISO week 9 → month 3.
    expect(getIsoMonth(new Date(2020, 1, 29))).toEqual({ isoYear: 2020, month: 3 });
    const m3 = monthBoundaries(2020, 3);
    expect('2020-02-29' >= m3.startDate && '2020-02-29' < m3.endDateExclusive).toBe(true);
  });
});

describe('monthBoundaries', () => {
  it('anchors month 1 on the Monday of ISO week 1', () => {
    expect(monthBoundaries(2024, 1)).toEqual({ startDate: '2024-01-01', endDateExclusive: '2024-01-29' });
    expect(monthBoundaries(2026, 1).startDate).toBe('2025-12-29');
  });

  it('gives month 13 four weeks in a 52-week year', () => {
    expect(monthBoundaries(2024, 13)).toEqual({ startDate: '2024-12-02', endDateExclusive: '2024-12-30' });
    expect(weeksInMonth(2024, 13)).toBe(4);
  });

  it('gives month 13 five weeks in a 53-week year', () => {
    expect(monthBoundaries(2026, 13)).toEqual({ startDate: '2026-11-30', endDateExclusive: '2027-01-04' });
    expect(weeksInMonth(2026, 13)).toBe(5);
    expect(weeksInMonth(2026, 12)).toBe(4);
  });

  it('rejects out-of-range months', () => {
    expect(() => monthBoundaries(2024, 0)).toThrow();
    expect(() => monthBoundaries(2024, 14)).toThrow();
  });

  it('tiles every ISO year contiguously with no gaps or overlaps', () => {
    for (let year = 2015; year <= 2030; year++) {
      for (let m = 1; m < 13; m++) {
        expect(monthBoundaries(year, m).endDateExclusive).toBe(monthBoundaries(year, m + 1).startDate);
      }
      // Month 13 hands off exactly to the next year's month 1.
      expect(monthBoundaries(year, 13).endDateExclusive).toBe(monthBoundaries(year + 1, 1).startDate);
    }
  });
});

describe('yearBoundaries', () => {
  it('spans months 1–13', () => {
    expect(yearBoundaries(2026)).toEqual({ startDate: '2025-12-29', endDateExclusive: '2027-01-04' });
  });
});

describe('lastCompletedMonth', () => {
  it('returns the previous month mid-year', () => {
    // Jun 16 2026 is in month 7 (weeks 25–28).
    expect(lastCompletedMonth(new Date(2026, 5, 16))).toEqual({ isoYear: 2026, month: 6 });
  });

  it('wraps to month 13 of the prior ISO year', () => {
    // Jan 2 2026 is in ISO 2026-W01 → month 1 → last completed is 2025-M13.
    expect(lastCompletedMonth(new Date(2026, 0, 2))).toEqual({ isoYear: 2025, month: 13 });
  });
});

describe('lastCompletedIsoYear', () => {
  it('uses the ISO year, not the calendar year', () => {
    // Dec 29 2025 already belongs to ISO 2026.
    expect(lastCompletedIsoYear(new Date(2025, 11, 29))).toBe(2025);
    expect(lastCompletedIsoYear(new Date(2026, 5, 15))).toBe(2025);
  });
});

describe('periodLabel', () => {
  it('renders month ranges and bare years', () => {
    expect(periodLabel({ isoYear: 2024, month: 1 })).toBe('Jan 1 – Jan 28, 2024');
    expect(periodLabel({ isoYear: 2026, month: 13 })).toBe('Nov 30, 2026 – Jan 3, 2027');
    expect(periodLabel(2025)).toBe('2025');
  });
});
