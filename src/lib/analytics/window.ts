import { addDays, format, parseISO } from 'date-fns';
import { getIsoMonth, monthBoundaries, yearBoundaries, lastCompletedMonth, rangeLabel, type Period } from '../review/isoMonth.js';
import type { ChartSpec, DateRange } from './spec';
import { maxDayOffset } from './spec.js';

// ─── Date-range resolution ───────────────────────────────────────────────────
// A spec's DateRange resolves to a half-open Period against "today" (passed
// in — the engine never reads the clock) and, for the current-block preset,
// the active training block. All date I/O is 'YYYY-MM-DD' strings so period
// membership stays a lexicographic comparison (the isoMonth convention).

export interface ResolvedRange extends Period {
  label: string;
}

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/** Null only for 'current-block' with no active block — a spec-level problem, not an exception. */
export function resolveRange(
  range: DateRange,
  todayIso: string,
  activeBlock: Period | null,
): ResolvedRange | null {
  const today = parseISO(todayIso);

  if (range.kind === 'rolling') {
    const startDate = iso(addDays(today, -(range.days - 1)));
    const endDateExclusive = iso(addDays(today, 1));
    return { startDate, endDateExclusive, label: `Last ${range.days} days` };
  }

  if (range.kind === 'fixed') {
    return {
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
      label: rangeLabel(range.startDate, range.endDateExclusive),
    };
  }

  switch (range.preset) {
    case 'this-iso-month': {
      const m = getIsoMonth(today);
      return { ...monthBoundaries(m.isoYear, m.month), label: 'This training month' };
    }
    case 'last-iso-month': {
      const m = lastCompletedMonth(today);
      return { ...monthBoundaries(m.isoYear, m.month), label: 'Last training month' };
    }
    case 'this-iso-year': {
      const m = getIsoMonth(today);
      return { ...yearBoundaries(m.isoYear), label: `Training year ${m.isoYear}` };
    }
    case 'last-iso-year': {
      const m = getIsoMonth(today);
      return { ...yearBoundaries(m.isoYear - 1), label: `Training year ${m.isoYear - 1}` };
    }
    case 'current-block':
      return activeBlock
        ? { ...activeBlock, label: 'Current block' }
        : null;
  }
}

/**
 * The one window the dashboard fetches: the union of every tile's resolved
 * range, widened by the largest dayFilter offset so shifted day-joins still
 * find their completions at the edges.
 */
export function unionWindow(
  specs: ChartSpec[],
  todayIso: string,
  activeBlock: Period | null,
): Period | null {
  let start: string | null = null;
  let end: string | null = null;
  for (const spec of specs) {
    const r = resolveRange(spec.range, todayIso, activeBlock);
    if (!r) continue;
    if (start === null || r.startDate < start) start = r.startDate;
    if (end === null || r.endDateExclusive > end) end = r.endDateExclusive;
  }
  if (start === null || end === null) return null;
  const pad = maxDayOffset(specs);
  if (pad > 0) {
    start = iso(addDays(parseISO(start), -pad));
    end = iso(addDays(parseISO(end), pad));
  }
  return { startDate: start, endDateExclusive: end };
}

/** start <= d < end, lexicographic (the repo's date convention). */
export function inRange(date: string, period: Period): boolean {
  return date >= period.startDate && date < period.endDateExclusive;
}
