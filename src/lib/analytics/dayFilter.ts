import { addDays, format, parseISO } from 'date-fns';
import type { CompletionRow } from '../db/types';
import type { DayFilter } from './spec';

// ─── Day-level joins ─────────────────────────────────────────────────────────
// "Protein on strength days" / "the day after a climb": a DayFilter keeps or
// drops measure rows by whether their date sits `offsetDays` after a day
// with a completed session of the given types. Pure set arithmetic over
// completion dates — the fetch window is already widened by the offset
// (window.ts unionWindow), so edge days resolve.

/**
 * The dates a filtered measure row may (include) or may not (exclude) land
 * on: each matching completion day, shifted forward by offsetDays.
 */
export function shiftedDaySet(completions: CompletionRow[], filter: DayFilter): Set<string> {
  const types = new Set<string>(filter.eventTypes);
  const days = new Set<string>();
  for (const c of completions) {
    if (!c.is_completed || !types.has(c.event_type)) continue;
    days.add(
      filter.offsetDays === 0
        ? c.event_date
        : format(addDays(parseISO(c.event_date), filter.offsetDays), 'yyyy-MM-dd'),
    );
  }
  return days;
}

/** Whether a row dated `date` survives the filter. */
export function passesDayFilter(date: string, days: Set<string>, mode: DayFilter['mode']): boolean {
  return mode === 'include' ? days.has(date) : !days.has(date);
}
