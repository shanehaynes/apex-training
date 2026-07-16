import { addDays, format, getISOWeek, getISOWeekYear, getISOWeeksInYear, parseISO } from 'date-fns';
import { startOfISOWeek } from 'date-fns';

// ─── The 13-month training calendar ───────────────────────────────────────────
// A training "month" is exactly 4 ISO weeks (Mon–Sun), giving 13 months per
// ISO week-numbering year. Month m covers ISO weeks 4(m-1)+1 .. 4m, except
// month 13, which extends to week 53 in 53-week ISO years (e.g. 2020, 2026) —
// that is where the calendar absorbs the 1–2 days a plain 364-day year would
// drop, so leap years need no special casing beyond ISO week rules.
//
// All date I/O is 'YYYY-MM-DD' strings (the event_date convention), so period
// membership is a lexicographic comparison: startDate <= d < endDateExclusive.

export interface IsoMonth {
  isoYear: number;
  /** 1–13. */
  month: number;
}

export interface Period {
  startDate: string;
  endDateExclusive: string;
}

/** ISO weeks in the given ISO week-numbering year: 52 or 53. */
export function isoWeeksInYear(isoYear: number): number {
  // Mid-June is always inside the ISO year of the same calendar year.
  return getISOWeeksInYear(new Date(isoYear, 5, 15));
}

/** The 4-week training month containing the given date. */
export function getIsoMonth(date: Date): IsoMonth {
  const week = getISOWeek(date);
  return { isoYear: getISOWeekYear(date), month: Math.min(13, Math.ceil(week / 4)) };
}

/** Monday of ISO week 1 — Jan 4 is always in week 1 (ISO 8601). */
function week1Monday(isoYear: number): Date {
  return startOfISOWeek(new Date(isoYear, 0, 4, 12));
}

/** Weeks in the given training month: 4, or 5 for month 13 of a 53-week year. */
export function weeksInMonth(isoYear: number, month: number): number {
  return month === 13 ? isoWeeksInYear(isoYear) - 48 : 4;
}

/**
 * Half-open date range of a training month. Built by day arithmetic from the
 * week-1 Monday anchor — no setISOWeek round-trips, no DST edge cases.
 */
export function monthBoundaries(isoYear: number, month: number): Period {
  if (!Number.isInteger(month) || month < 1 || month > 13) {
    throw new Error(`Training month out of range: ${month}`);
  }
  const anchor = week1Monday(isoYear);
  const endWeek = month === 13 ? isoWeeksInYear(isoYear) : 4 * month;
  return {
    startDate: format(addDays(anchor, (month - 1) * 28), 'yyyy-MM-dd'),
    endDateExclusive: format(addDays(anchor, endWeek * 7), 'yyyy-MM-dd'),
  };
}

/** Half-open date range of a whole ISO year (months 1–13). */
export function yearBoundaries(isoYear: number): Period {
  return {
    startDate: monthBoundaries(isoYear, 1).startDate,
    endDateExclusive: monthBoundaries(isoYear, 13).endDateExclusive,
  };
}

/** The most recent fully-elapsed training month as of `today`. */
export function lastCompletedMonth(today: Date): IsoMonth {
  const current = getIsoMonth(today);
  return current.month > 1
    ? { isoYear: current.isoYear, month: current.month - 1 }
    : { isoYear: current.isoYear - 1, month: 13 };
}

/** The most recent fully-elapsed ISO year as of `today`. */
export function lastCompletedIsoYear(today: Date): number {
  return getISOWeekYear(today) - 1;
}

/**
 * Human label for a period: months as their date range ("Jun 15 – Jul 12,
 * 2026", spelling out both years when the month straddles one), years as
 * the bare year.
 */
export function periodLabel(p: IsoMonth | number): string {
  if (typeof p === 'number') return String(p);
  const { startDate, endDateExclusive } = monthBoundaries(p.isoYear, p.month);
  const start = parseISO(startDate);
  const end = addDays(parseISO(endDateExclusive), -1);
  return start.getFullYear() === end.getFullYear()
    ? `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`
    : `${format(start, 'MMM d, yyyy')} – ${format(end, 'MMM d, yyyy')}`;
}
