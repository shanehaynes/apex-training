import type { RecurrenceRule, Weekday } from './types.js';
import { validateRRule, isValidIsoDate } from './validate.js';

const KNOWN_KEYS = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL'] as const;
type KnownKey = (typeof KNOWN_KEYS)[number];

/**
 * Parses an RFC 5545 RRULE value string (no 'RRULE:' prefix) into a
 * RecurrenceRule, e.g. 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231'.
 *
 * Throws a descriptive Error on unknown keys, unsupported FREQ values,
 * ordinal BYDAY tokens, malformed dates, and invalid combinations
 * (see validateRRule).
 */
export function parseRRule(ruleString: string): RecurrenceRule {
  if (!ruleString || !ruleString.trim()) {
    throw new Error('Empty RRULE string');
  }

  const seen = new Set<string>();
  const parts: Partial<Record<KnownKey, string>> = {};

  for (const token of ruleString.trim().split(';')) {
    const eq = token.indexOf('=');
    if (eq === -1) {
      throw new Error(`Malformed RRULE part "${token}" — expected KEY=VALUE`);
    }
    const key = token.slice(0, eq).toUpperCase();
    const value = token.slice(eq + 1);
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unsupported RRULE part "${key}" — supported: ${KNOWN_KEYS.join(', ')}`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate RRULE part "${key}"`);
    }
    if (value === '') {
      throw new Error(`RRULE part "${key}" has an empty value`);
    }
    seen.add(key);
    parts[key as KnownKey] = value;
  }

  if (!parts.FREQ) {
    throw new Error('RRULE is missing required FREQ part');
  }
  const freq = parts.FREQ.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') {
    throw new Error(`Unsupported FREQ "${parts.FREQ}" — supported: DAILY, WEEKLY, MONTHLY`);
  }

  const rule: RecurrenceRule = { freq, interval: 1 };

  if (parts.INTERVAL !== undefined) {
    rule.interval = parsePositiveInt(parts.INTERVAL, 'INTERVAL');
  }

  if (parts.BYDAY !== undefined) {
    rule.byDay = parts.BYDAY.split(',').map(token => {
      const upper = token.toUpperCase();
      if (!/^(SU|MO|TU|WE|TH|FR|SA)$/.test(upper)) {
        throw new Error(`Invalid BYDAY token "${token}" — only plain weekday codes are supported (no ordinals like "2TU")`);
      }
      return upper as Weekday;
    });
  }

  if (parts.BYMONTHDAY !== undefined) {
    rule.byMonthDay = parts.BYMONTHDAY.split(',').map(token => parsePositiveInt(token, 'BYMONTHDAY'));
  }

  if (parts.COUNT !== undefined) {
    rule.count = parsePositiveInt(parts.COUNT, 'COUNT');
  }

  if (parts.UNTIL !== undefined) {
    rule.until = parseUntil(parts.UNTIL);
  }

  validateRRule(rule);
  return rule;
}

function parsePositiveInt(value: string, key: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${key} value "${value}" — expected a positive integer`);
  }
  const n = parseInt(value, 10);
  if (n < 1) {
    throw new Error(`Invalid ${key} value "${value}" — must be >= 1`);
  }
  return n;
}

// Accepts YYYYMMDD or YYYYMMDDTHHMMSS (floating — a trailing Z is rejected,
// see the floating-time constraint in RECURRENCE_ENGINE_SPEC.md §5).
// The time portion, if present, is discarded: the engine operates on
// calendar dates, and UNTIL is inclusive of its date.
function parseUntil(value: string): string {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(T\d{6})?$/);
  if (!m) {
    throw new Error(`Invalid UNTIL value "${value}" — expected YYYYMMDD or YYYYMMDDTHHMMSS (floating, no Z suffix)`);
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isValidIsoDate(iso)) {
    throw new Error(`UNTIL value "${value}" is not a real calendar date`);
  }
  return iso;
}
