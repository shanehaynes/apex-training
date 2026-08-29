import { addDays, format, parseISO, startOfISOWeek } from 'date-fns';
import { getIsoMonth, monthBoundaries, type Period } from '../review/isoMonth';
import type { TimeBucket } from './spec';

// ─── Time bucketing ──────────────────────────────────────────────────────────
// A resolved range breaks into a COMPLETE, zero-fillable bucket list: every
// bucket in the window exists whether or not data landed in it, so a lazy
// month renders as a dip instead of silently vanishing. Bucket keys sort
// lexicographically ('YYYY-MM-DD' for day/week, 'YYYY-MNN' for iso months).

export interface Bucket {
  key: string;
  /** Short tick label; the tooltip shows the full date range. */
  label: string;
}

/** Charts refuse absurd resolutions rather than rendering 2000 ticks. */
export const MAX_BUCKETS = 400;

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

const monthKey = (isoYear: number, month: number) => `${isoYear}-M${String(month).padStart(2, '0')}`;

/**
 * All buckets covering the period, in order — or null when the combination
 * explodes past MAX_BUCKETS (the caller surfaces that as a tile problem).
 */
export function bucketsFor(period: Period, bucket: TimeBucket): Bucket[] | null {
  if (bucket === 'total') return [{ key: 'total', label: '' }];

  const out: Bucket[] = [];
  const end = period.endDateExclusive;

  if (bucket === 'day') {
    for (let d = parseISO(period.startDate); iso(d) < end; d = addDays(d, 1)) {
      if (out.length >= MAX_BUCKETS) return null;
      out.push({ key: iso(d), label: format(d, 'MMM d') });
    }
    return out;
  }

  if (bucket === 'week') {
    for (let d = startOfISOWeek(parseISO(period.startDate)); iso(d) < end; d = addDays(d, 7)) {
      if (out.length >= MAX_BUCKETS) return null;
      out.push({ key: iso(d), label: format(d, 'MMM d') });
    }
    return out;
  }

  // iso-month: walk 4-week training months from the one containing the start.
  let m = getIsoMonth(parseISO(period.startDate));
  for (;;) {
    const bounds = monthBoundaries(m.isoYear, m.month);
    if (bounds.startDate >= end) break;
    if (out.length >= MAX_BUCKETS) return null;
    out.push({ key: monthKey(m.isoYear, m.month), label: format(parseISO(bounds.startDate), 'MMM d') });
    m = m.month < 13 ? { isoYear: m.isoYear, month: m.month + 1 } : { isoYear: m.isoYear + 1, month: 1 };
  }
  return out;
}

/** The bucket key a dated row lands in. */
export function bucketOf(date: string, bucket: TimeBucket): string {
  if (bucket === 'total') return 'total';
  if (bucket === 'day') return date;
  const d = parseISO(date);
  if (bucket === 'week') return iso(startOfISOWeek(d));
  const m = getIsoMonth(d);
  return monthKey(m.isoYear, m.month);
}
