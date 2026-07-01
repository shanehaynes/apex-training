import type { RecurrenceRule, Weekday } from './types';
import { validateRRule, isValidIsoDate, daysInMonth } from './validate';
import { WEEKDAYS } from './types';

const DAY_MS = 86_400_000;

// All arithmetic is pure Gregorian calendar math on UTC millisecond values —
// never local-time instants — so DST transitions cannot skip or duplicate a
// date (the floating-time constraint from RECURRENCE_ENGINE_SPEC.md §5).
function toMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function weekdayIndex(ms: number): number {
  return new Date(ms).getUTCDay(); // 0=Sun … 6=Sat
}

/**
 * Expands a recurrence rule into the occurrence dates it generates *after*
 * dtstart — the base event itself is not included; callers add it separately.
 *
 * - dtstart counts as the first occurrence toward COUNT (RFC 5545: DTSTART
 *   is the first instance of the recurrence set), so a COUNT=10 rule yields
 *   at most 9 generated dates.
 * - UNTIL and rangeEnd are inclusive.
 * - exdates are removed after COUNT budgeting, per RFC 5545 (EXDATE excludes
 *   instances from the set the RRULE generates; it does not extend it).
 * - A rule with neither COUNT nor UNTIL requires rangeEnd, otherwise the
 *   expansion would be unbounded and this throws.
 */
export function expandRecurrence(
  rule: RecurrenceRule,
  dtstart: string,
  exdates: Set<string>,
  rangeEnd?: string,
): string[] {
  validateRRule(rule);
  if (!isValidIsoDate(dtstart)) {
    throw new Error(`Invalid dtstart "${dtstart}" — expected a real YYYY-MM-DD date`);
  }
  if (rangeEnd !== undefined && !isValidIsoDate(rangeEnd)) {
    throw new Error(`Invalid rangeEnd "${rangeEnd}" — expected a real YYYY-MM-DD date`);
  }
  if (rule.count === undefined && rule.until === undefined && rangeEnd === undefined) {
    throw new Error('Rule has neither COUNT nor UNTIL — pass rangeEnd to bound the expansion');
  }

  let cap: string | undefined;
  if (rule.until !== undefined && rangeEnd !== undefined) {
    cap = rule.until < rangeEnd ? rule.until : rangeEnd;
  } else {
    cap = rule.until ?? rangeEnd;
  }
  // COUNT-only rules are bounded by budget, but a pathological rule can
  // generate no occurrences at all (e.g. BYMONTHDAY=31 with INTERVAL=12
  // landing on a 30-day month forever). A wide hard horizon guarantees
  // termination without affecting any realistic rule.
  const horizon = cap ?? toIso(toMs(dtstart) + 366 * 100 * DAY_MS);

  let budget = rule.count !== undefined ? rule.count - 1 : Infinity;
  const out: string[] = [];

  for (const date of candidateDates(rule, dtstart, horizon)) {
    if (cap !== undefined && date > cap) break;
    if (budget <= 0) break;
    budget--;
    if (!exdates.has(date)) out.push(date);
  }

  return out;
}

// Yields candidate occurrence dates strictly after dtstart, in chronological
// order, stopping once a whole period starts beyond `horizon`.
function* candidateDates(rule: RecurrenceRule, dtstart: string, horizon: string): Generator<string> {
  const startMs = toMs(dtstart);
  const horizonMs = toMs(horizon);

  if (rule.freq === 'DAILY') {
    for (let ms = startMs + rule.interval * DAY_MS; ms <= horizonMs; ms += rule.interval * DAY_MS) {
      yield toIso(ms);
    }
    return;
  }

  if (rule.freq === 'WEEKLY') {
    // Default to dtstart's own weekday when BYDAY is absent (RFC 5545).
    // Weeks start on Monday (RFC 5545 default WKST=MO), which matters for
    // INTERVAL > 1 week-block alignment.
    const days = new Set((rule.byDay ?? [WEEKDAYS[weekdayIndex(startMs)] as Weekday]).map(d => WEEKDAYS.indexOf(d)));
    let weekStart = startMs - ((weekdayIndex(startMs) + 6) % 7) * DAY_MS;
    while (weekStart <= horizonMs) {
      for (let i = 0; i < 7; i++) {
        const ms = weekStart + i * DAY_MS;
        if (ms > startMs && days.has(weekdayIndex(ms))) yield toIso(ms);
      }
      weekStart += rule.interval * 7 * DAY_MS;
    }
    return;
  }

  // MONTHLY. Default to dtstart's own day-of-month when BYMONTHDAY is absent;
  // months too short for a listed day skip that occurrence (no clamping).
  const [startYear, startMonth, startDay] = dtstart.split('-').map(Number);
  const monthDays = [...(rule.byMonthDay ?? [startDay])].sort((a, b) => a - b);
  let year = startYear;
  let month = startMonth;
  while (Date.UTC(year, month - 1, 1) <= horizonMs) {
    for (const day of monthDays) {
      if (day > daysInMonth(year, month)) continue;
      const ms = Date.UTC(year, month - 1, day);
      if (ms > startMs) yield toIso(ms);
    }
    month += rule.interval;
    while (month > 12) {
      month -= 12;
      year += 1;
    }
  }
}
