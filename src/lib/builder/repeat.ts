import { addDays, format, parseISO } from 'date-fns';
import { parseRRule, serializeRRule, WEEKDAYS, type Weekday } from '../recurrence/index.js';

// ─── The builder's repeat model ──────────────────────────────────────────────
// Weekly (day-of-week chips, every N weeks) or daily (every N days), ending
// never, on a date, or after N times — the subset of the recurrence engine
// the builder authors. Rules the picker cannot express (MONTHLY, weekly
// without BYDAY, anything unparseable) survive round-trips verbatim through
// `custom` and are never rewritten.

export type RepeatFreq = 'WEEKLY' | 'DAILY';

export interface DraftRepeat {
  enabled: boolean;
  /** Absent = WEEKLY, so a client that predates daily rules (and the coach's
   *  weekly-only `repeat`) keeps its shape. */
  freq?: RepeatFreq;
  /** WEEKLY only; a DAILY rule ignores them. */
  days: Weekday[];
  /** String, like every numeric draft field: an input must be clearable. */
  interval: string;
  /** 'YYYY-MM-DD' inclusive; '' = never ends. */
  until: string;
  /** "After N times", the anchor included; '' or absent = no count. Exclusive
   *  with `until` — the picker clears one when the other is set. */
  count?: string;
  /** A rule the picker can't express — kept verbatim, saved untouched. */
  custom?: string;
}

export const REPEAT_OFF: DraftRepeat = { enabled: false, days: [], interval: '1', until: '' };

/** Chip order (training weeks start Monday); serialization re-sorts to the
 *  engine's canonical SU-first order so equal rules compare equal. */
export const REPEAT_DAY_ORDER: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export const REPEAT_DAY_LABELS: Record<Weekday, string> = {
  MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S', SU: 'S',
};

export const repeatFreq = (repeat: DraftRepeat): RepeatFreq => repeat.freq ?? 'WEEKLY';

const parsedCount = (repeat: DraftRepeat): number | undefined => {
  const text = (repeat.count ?? '').trim();
  if (!text) return undefined;
  const n = parseInt(text, 10);
  return /^\d+$/.test(text) && n >= 1 ? n : undefined;
};

export function repeatFromRule(rule?: string): DraftRepeat {
  if (!rule) return REPEAT_OFF;
  try {
    const parsed = parseRRule(rule);
    // Keys stay absent when at their default so a weekly, count-less rule
    // reads back as exactly the shape older clients produce.
    const end = {
      until: parsed.until ?? '',
      ...(parsed.count !== undefined ? { count: String(parsed.count) } : {}),
    };
    if (parsed.freq === 'WEEKLY' && parsed.byDay?.length) {
      return { enabled: true, days: parsed.byDay, interval: String(parsed.interval), ...end };
    }
    if (parsed.freq === 'DAILY') {
      return { enabled: true, freq: 'DAILY', days: [], interval: String(parsed.interval), ...end };
    }
  } catch {
    // Unparseable columns exist only on rows predating validation — treat
    // like any other rule the picker can't express.
  }
  return { ...REPEAT_OFF, enabled: true, custom: rule };
}

/** The canonical RRULE value for the picker state; undefined when off.
 *  Never throws: a bad interval falls back to 1, a bad count is dropped, and
 *  when both ends are set the date wins — `repeatProblem` is where a user
 *  hears about any of that. */
export function ruleFromRepeat(repeat: DraftRepeat): string | undefined {
  if (!repeat.enabled) return undefined;
  if (repeat.custom) return repeat.custom;
  const freq = repeatFreq(repeat);
  if (freq === 'WEEKLY' && !repeat.days.length) return undefined;
  const interval = parseInt(repeat.interval, 10);
  const count = parsedCount(repeat);
  return serializeRRule({
    freq,
    interval: Number.isFinite(interval) && interval >= 1 ? interval : 1,
    ...(freq === 'WEEKLY'
      ? { byDay: [...repeat.days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)) }
      : {}),
    ...(count !== undefined && !repeat.until ? { count } : {}),
    until: repeat.until || undefined,
  });
}

/**
 * Move the anchor date forward (at most six days) to the first selected
 * weekday. The recurrence engine renders the anchor row at its own date and
 * generates dates strictly after it — an anchor on an unselected weekday
 * would put a stray occurrence on a day the user never picked.
 */
export function snapAnchorDate(date: string, days: Weekday[]): string {
  if (!days.length) return date;
  let candidate = parseISO(date);
  for (let i = 0; i < 7; i++) {
    if (days.includes(WEEKDAYS[candidate.getDay()])) return format(candidate, 'yyyy-MM-dd');
    candidate = addDays(candidate, 1);
  }
  return date;
}

/** First user-facing validation problem with the repeat state, or null. */
export function repeatProblem(repeat: DraftRepeat, anchorDate: string): string | null {
  if (!repeat.enabled || repeat.custom) return null;
  const freq = repeatFreq(repeat);
  if (freq === 'WEEKLY' && !repeat.days.length) return 'Pick at least one day to repeat on';
  const interval = parseInt(repeat.interval, 10);
  if (!Number.isFinite(interval) || interval < 1) return 'Repeat interval must be at least 1';
  if ((repeat.count ?? '').trim()) {
    if (parsedCount(repeat) === undefined) return 'Repeat count must be at least 1';
    if (repeat.until) return 'Choose an end date or a number of times, not both';
  }
  if (repeat.until && repeat.until < snapAnchorDate(anchorDate, freq === 'WEEKLY' ? repeat.days : [])) {
    return 'The repeat end date is before the first occurrence';
  }
  return null;
}

/** One line for prompts and summaries: "MO,WE every 2 weeks, 6 times". */
export function describeRepeat(repeat: DraftRepeat): string {
  if (repeat.custom) return repeat.custom;
  const freq = repeatFreq(repeat);
  const unit = freq === 'WEEKLY' ? 'week' : 'day';
  const every = `every ${repeat.interval} ${unit}(s)`;
  const head = freq === 'WEEKLY' ? `${repeat.days.join(',')} ${every}` : every;
  if (repeat.until) return `${head} until ${repeat.until}`;
  const count = parsedCount(repeat);
  return count !== undefined ? `${head}, ${count} times` : head;
}
