import { repeatProblem, ruleFromRepeat, snapAnchorDate, REPEAT_DAY_ORDER, type DraftRepeat } from '../builder/repeat.js';
import { expandRecurrence, parseRRule, WEEKDAYS, type Weekday } from '../recurrence/index.js';

// create_event's `repeat` input (schemas.ts): the builder coach's weekly
// repeat shape, so the model meets one vocabulary for "every Monday and
// Thursday until November 5" wherever it schedules. The executor and the
// confirm-card preview both go through here, so the anchor the card shows is
// the anchor the row gets: the recurrence engine draws the anchor on its own
// date and generates dates strictly after it, so an anchor on an unselected
// weekday would put a stray workout on a day nobody picked — the date is
// moved forward to the first selected weekday, exactly as the builder does.

export interface ParsedRepeat {
  /** The anchor date after snapping to the first selected weekday. */
  date: string;
  /** The canonical RRULE value the row stores. */
  rule: string;
  /** "every Mon, Thu until 2026-11-05" — the card's and the result's wording. */
  description: string;
  /** Workouts the series holds, counting the anchor; null when it never ends. */
  occurrences: number | null;
}

const DAY_NAMES: Record<Weekday, string> = {
  MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'string' && (WEEKDAYS as readonly string[]).includes(value);
}

/**
 * The series a `repeat` input describes, anchored on `date`; null when the
 * input is absent (a one-off event); an `error` the model can act on when
 * the input is malformed or impossible. Total: never throws on model input.
 */
export function parseRepeatInput(
  repeat: unknown,
  date: string,
): ParsedRepeat | { error: string } | null {
  if (repeat === undefined || repeat === null) return null;
  if (typeof repeat !== 'object' || Array.isArray(repeat)) return { error: 'repeat must be an object with days (MO…SU), optional interval_weeks and until.' };
  const { days, interval_weeks, until } = repeat as { days?: unknown; interval_weeks?: unknown; until?: unknown };

  if (!Array.isArray(days) || days.length === 0 || !days.every(isWeekday)) {
    return { error: 'repeat.days must list at least one weekday code: MO, TU, WE, TH, FR, SA, SU.' };
  }
  if (interval_weeks !== undefined && (typeof interval_weeks !== 'number' || !Number.isInteger(interval_weeks) || interval_weeks < 1)) {
    return { error: 'repeat.interval_weeks must be a whole number of weeks, 1 or more.' };
  }
  if (until !== undefined && (typeof until !== 'string' || !ISO_DATE.test(until))) {
    return { error: 'repeat.until must be a YYYY-MM-DD date.' };
  }
  if (!ISO_DATE.test(date)) return { error: 'date must be YYYY-MM-DD.' };

  const uniqueDays = REPEAT_DAY_ORDER.filter(d => (days as Weekday[]).includes(d));
  const draft: DraftRepeat = {
    enabled: true,
    days: uniqueDays,
    interval: String(interval_weeks ?? 1),
    until: until ?? '',
  };
  const problem = repeatProblem(draft, date);
  if (problem) return { error: `${problem}.` };
  const rule = ruleFromRepeat(draft);
  if (!rule) return { error: 'repeat.days must list at least one weekday code: MO, TU, WE, TH, FR, SA, SU.' };

  const anchor = snapAnchorDate(date, uniqueDays);
  const names = uniqueDays.map(d => DAY_NAMES[d]).join(', ');
  const interval = interval_weeks ?? 1;
  const cadence = interval === 1 ? `every ${names}` : `every ${interval} weeks on ${names}`;
  const description = until ? `${cadence} until ${until}` : cadence;
  let occurrences: number | null = null;
  if (until) {
    try {
      occurrences = expandRecurrence(parseRRule(rule), anchor, new Set(), until).length + 1;
    } catch {
      occurrences = null;
    }
  }
  return { date: anchor, rule, description, occurrences };
}
