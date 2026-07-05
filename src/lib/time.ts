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
