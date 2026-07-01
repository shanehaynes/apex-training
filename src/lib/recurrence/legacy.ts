import type { Weekday } from './types';
import { WEEKDAYS } from './types';

/**
 * Derives a canonical RRULE value string from the deprecated
 * recurring_frequency / recurring_days / recurring_end_date columns, for
 * rows the phase3_recurrence_rule.sql backfill hasn't reached (and for the
 * schedule.json fallback dataset). Returns null for patterns the engine
 * doesn't support ('custom') so callers treat the event as non-recurring
 * instead of mis-expanding it.
 */
export function ruleFromLegacyColumns(
  frequency: string | null | undefined,
  daysOfWeek: number[] | null | undefined,
  endDate: string | null | undefined, // 'YYYY-MM-DD'
): string | null {
  if (frequency !== 'daily' && frequency !== 'weekly') return null;

  let rule = `FREQ=${frequency.toUpperCase()}`;
  if (frequency === 'weekly' && daysOfWeek && daysOfWeek.length > 0) {
    const tokens = daysOfWeek.map(d => WEEKDAYS[d] as Weekday | undefined);
    if (tokens.some(t => t === undefined)) return null;
    rule += `;BYDAY=${tokens.join(',')}`;
  }
  if (endDate) rule += `;UNTIL=${endDate.replace(/-/g, '')}`;
  return rule;
}
