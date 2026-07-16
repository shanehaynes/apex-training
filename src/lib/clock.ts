/**
 * Current-time source for date-semantic logic — "what day is it", which
 * period is current, where the now-line sits. NOT for write timestamps
 * (started_at, completed_at, updated_at): those must stay real so data
 * ordering is never corrupted, and keep calling `new Date()` directly.
 *
 * In dev the agent harness can freeze the date, so calendar renders and
 * screenshots are reproducible across days:
 *   - `window.__APEX_FAKE_NOW__ = '2026-03-02T08:00:00'` — per-run override
 *     (injected via addInitScript), wins over the env var, no restart needed.
 *   - `VITE_FAKE_NOW=2026-03-02T08:00:00` — env override, needs a restart.
 * Production builds compile the whole branch away.
 */
import { addDays, format, isSameDay } from 'date-fns';

export function now(): Date {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const fake = (window as unknown as { __APEX_FAKE_NOW__?: string }).__APEX_FAKE_NOW__
      ?? import.meta.env.VITE_FAKE_NOW;
    if (fake) return new Date(fake);
  }
  return new Date();
}

// Clock-aware replacements for the date-fns predicates of the same names,
// which read the real clock internally and would disagree with a fake now().
export function isToday(date: Date): boolean {
  return isSameDay(date, now());
}

export function isTomorrow(date: Date): boolean {
  return isSameDay(date, addDays(now(), 1));
}

export function isPast(date: Date): boolean {
  return date.getTime() < now().getTime();
}

/** Whole-day version of isPast: true only for days strictly before today. */
export function isPastDay(isoDate: string): boolean {
  return isoDate < format(now(), 'yyyy-MM-dd');
}
