import type { RecurrenceRule } from './types';
import { WEEKDAYS } from './types';

const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;

/**
 * Throws a descriptive Error if the rule violates the supported RFC 5545
 * subset. Called internally by parseRRule, and exported for callers that
 * construct a RecurrenceRule programmatically.
 *
 * Note: a rule with neither COUNT nor UNTIL is valid per RFC 5545 (an
 * unbounded recurrence) — expandRecurrence requires a rangeEnd cap for those.
 */
export function validateRRule(rule: RecurrenceRule): void {
  if (!FREQS.includes(rule.freq)) {
    throw new Error(`Unsupported FREQ "${rule.freq}" — supported: ${FREQS.join(', ')}`);
  }

  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new Error(`INTERVAL must be a positive integer, got "${rule.interval}"`);
  }

  if (rule.count !== undefined && rule.until !== undefined) {
    throw new Error('COUNT and UNTIL are mutually exclusive — a rule may have at most one');
  }

  if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1)) {
    throw new Error(`COUNT must be a positive integer, got "${rule.count}"`);
  }

  if (rule.until !== undefined && !isValidIsoDate(rule.until)) {
    throw new Error(`UNTIL is not a valid calendar date: "${rule.until}"`);
  }

  if (rule.byDay !== undefined) {
    if (rule.freq !== 'WEEKLY') {
      throw new Error(`BYDAY is only valid with FREQ=WEEKLY, not FREQ=${rule.freq}`);
    }
    if (rule.byDay.length === 0) {
      throw new Error('BYDAY must list at least one weekday');
    }
    for (const day of rule.byDay) {
      if (!WEEKDAYS.includes(day)) {
        throw new Error(`Invalid BYDAY token "${day}" — supported: ${WEEKDAYS.join(', ')} (no ordinal prefixes)`);
      }
    }
    if (new Set(rule.byDay).size !== rule.byDay.length) {
      throw new Error(`BYDAY contains duplicate weekdays: ${rule.byDay.join(',')}`);
    }
  }

  if (rule.byMonthDay !== undefined) {
    if (rule.freq !== 'MONTHLY') {
      throw new Error(`BYMONTHDAY is only valid with FREQ=MONTHLY, not FREQ=${rule.freq}`);
    }
    if (rule.byMonthDay.length === 0) {
      throw new Error('BYMONTHDAY must list at least one day');
    }
    for (const day of rule.byMonthDay) {
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        throw new Error(`Invalid BYMONTHDAY value "${day}" — must be an integer 1-31 (negative values unsupported)`);
      }
    }
    if (new Set(rule.byMonthDay).size !== rule.byMonthDay.length) {
      throw new Error(`BYMONTHDAY contains duplicate days: ${rule.byMonthDay.join(',')}`);
    }
  }
}

/** True for 'YYYY-MM-DD' strings naming a real Gregorian calendar date. */
export function isValidIsoDate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number): number {
  // month is 1-12
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1];
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
