import { addDays, format, parseISO } from 'date-fns';
import { parseRRule, serializeRRule, WEEKDAYS, type Weekday } from '../recurrence/index.js';

// ─── The builder's repeat model ──────────────────────────────────────────────
// Day-of-week chips + "every N weeks" + an optional end date — the weekly
// subset of the recurrence engine, which covers everything the builder
// authors. Rules the picker cannot express (DAILY/MONTHLY, COUNT, weekly
// without BYDAY) survive round-trips verbatim through `custom` and are never
// rewritten.

export interface DraftRepeat {
  enabled: boolean;
  days: Weekday[];
  /** String, like every numeric draft field: an input must be clearable. */
  interval: string;
  /** 'YYYY-MM-DD' inclusive; '' = never ends. */
  until: string;
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

export function repeatFromRule(rule?: string): DraftRepeat {
  if (!rule) return REPEAT_OFF;
  try {
    const parsed = parseRRule(rule);
    if (parsed.freq === 'WEEKLY' && parsed.byDay?.length && parsed.count === undefined) {
      return {
        enabled: true,
        days: parsed.byDay,
        interval: String(parsed.interval),
        until: parsed.until ?? '',
      };
    }
  } catch {
    // Unparseable columns exist only on rows predating validation — treat
    // like any other rule the picker can't express.
  }
  return { ...REPEAT_OFF, enabled: true, custom: rule };
}

/** The canonical RRULE value for the picker state; undefined when off. */
export function ruleFromRepeat(repeat: DraftRepeat): string | undefined {
  if (!repeat.enabled) return undefined;
  if (repeat.custom) return repeat.custom;
  if (!repeat.days.length) return undefined;
  const interval = parseInt(repeat.interval, 10);
  return serializeRRule({
    freq: 'WEEKLY',
    interval: Number.isFinite(interval) && interval >= 1 ? interval : 1,
    byDay: [...repeat.days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)),
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
  if (!repeat.days.length) return 'Pick at least one day to repeat on';
  const interval = parseInt(repeat.interval, 10);
  if (!Number.isFinite(interval) || interval < 1) return 'Repeat interval must be at least 1';
  if (repeat.until && repeat.until < snapAnchorDate(anchorDate, repeat.days)) {
    return 'The repeat end date is before the first occurrence';
  }
  return null;
}
