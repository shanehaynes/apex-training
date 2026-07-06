// Time-of-day parsing and duration formatting shared by the app and the
// /api functions (calendar-feed imports parseTimeOfDay).

/** Parses "5:30 PM", "17:30", "5:30 pm", etc. → { h: 17, m: 30 }. */
export function parseTimeOfDay(timeStr: string): { h: number; m: number } | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && h !== 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return { h, m };
}

/** Minutes since midnight for sorting; missing/unparseable times sort last. */
export function timeToMinutes(timeStr?: string): number {
  if (!timeStr) return Infinity;
  const parsed = parseTimeOfDay(timeStr.trim());
  return parsed ? parsed.h * 60 + parsed.m : Infinity;
}

/** Stored time ("5:30 PM" or "17:30") → <input type="time"> value ("17:30"); '' when absent/unparseable. */
export function toInputTime(timeStr?: string): string {
  if (!timeStr) return '';
  const parsed = parseTimeOfDay(timeStr.trim());
  if (!parsed) return '';
  return `${String(parsed.h).padStart(2, '0')}:${String(parsed.m).padStart(2, '0')}`;
}

/** Minutes since midnight (clamped to the same day) → the stored display convention ("5:30 PM"). */
export function minutesToDisplayTime(totalMinutes: number): string {
  const m = Math.max(0, Math.min(Math.round(totalMinutes), 23 * 60 + 59));
  const h = Math.floor(m / 60);
  const meridiem = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, '0')} ${meridiem}`;
}

/** <input type="time"> value ("17:30") → the stored display convention ("5:30 PM"); null when unparseable. */
export function toDisplayTime(hhmm: string): string | null {
  const parsed = parseTimeOfDay(hhmm);
  if (!parsed) return null;
  const meridiem = parsed.h < 12 ? 'AM' : 'PM';
  const h12 = parsed.h % 12 === 0 ? 12 : parsed.h % 12;
  return `${h12}:${String(parsed.m).padStart(2, '0')} ${meridiem}`;
}

/** Workout timer format: "05:30", "1:05:30" — always-padded mm:ss. */
export function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Record format: "90s" under a minute, "2:30" beyond, "1:05:00" beyond an hour. */
export function formatSeconds(total: number): string {
  const s = Math.round(total);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
