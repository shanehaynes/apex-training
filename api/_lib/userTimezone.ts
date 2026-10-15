import type { getSupabaseAdmin } from './supabaseAdmin.js';

// The athlete's time zone (profiles.timezone, phase58) and the calendar
// arithmetic the server does in it. Every path with no browser to ask —
// MCP tools called without `today`, the nightly reflection, the starter-plan
// copy, the provider cron — resolves "today" here instead of from the UTC
// clock. Unknown or invalid zones read as UTC, which is what every one of
// those paths did before the column existed.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export const DEFAULT_TIMEZONE = 'UTC';

/** True for a zone name this runtime's Intl accepts. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    // Constructing is the check: the constructor throws a RangeError for an
    // unknown zone, and no query API accepts exactly the same names.
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone to compute in: the stored one when valid, else UTC. */
export function effectiveTimezone(tz: unknown): string {
  return isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

function wallClock(instant: number, timeZone: string): WallClock {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    // en-CA emits hour '24' for midnight in some runtimes; normalize.
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** The calendar date (YYYY-MM-DD) at `now` in `timeZone`. */
export function localDate(timeZone: string, now: Date = new Date()): string {
  const w = wallClock(now.getTime(), effectiveTimezone(timeZone));
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** The day before `day` (YYYY-MM-DD), by the calendar. */
export function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** Minutes `timeZone` is ahead of UTC at `instant`. */
function offsetMinutes(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** The UTC instant at which `day` begins in `timeZone`. */
function startOfLocalDay(day: string, timeZone: string): number {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);
  // Two passes settle a midnight that sits on the other side of a DST change
  // from the first guess.
  const first = midnightUtc - offsetMinutes(midnightUtc, timeZone) * 60_000;
  let start = midnightUtc - offsetMinutes(first, timeZone) * 60_000;
  // Where the clocks jump from 23:59 to 01:00 (Santiago, Havana) there is no
  // local midnight, and the passes land an hour early, in the day before.
  // The day starts at the first instant whose local date is the day: step
  // forward in quarter hours (every real offset is a multiple) until it is.
  for (let i = 0; i < 8 && localDate(timeZone, new Date(start)) < day; i++) start += 15 * 60_000;
  return start;
}

/** [start, end) of `day` in `timeZone`, as ISO instants for a timestamptz range filter. */
export function localDayBounds(day: string, timeZone: string): { start: string; end: string } {
  const tz = effectiveTimezone(timeZone);
  return {
    start: new Date(startOfLocalDay(day, tz)).toISOString(),
    end: new Date(startOfLocalDay(nextDay(day), tz)).toISOString(),
  };
}

/** True when the column has not reached this database yet. */
function isTimezoneColumnMissing(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === '42703' || error.code === 'PGRST204')
    && /timezone/.test(error.message ?? '');
}

/** One athlete's zone, UTC when unset, invalid, or the column is not there yet. */
export async function fetchUserTimezone(supabase: Admin, userId: string): Promise<string> {
  return (await fetchUserTimezones(supabase, [userId])).get(userId) ?? DEFAULT_TIMEZONE;
}

/**
 * Zones for many athletes in one read; anyone missing from the map is UTC.
 * Never throws: every caller is computing a fallback "today", and a failed
 * read costs the athlete their zone for this call, not the call itself.
 */
export async function fetchUserTimezones(supabase: Admin, userIds: string[]): Promise<Map<string, string>> {
  const zones = new Map<string, string>();
  if (userIds.length === 0) return zones;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, timezone')
      .in('id', userIds);
    if (error) {
      if (!isTimezoneColumnMissing(error)) console.warn('[timezone] profiles read failed:', error.message);
      return zones;
    }
    if (!Array.isArray(data)) return zones;
    for (const row of data as Array<{ id: string; timezone: string | null }>) {
      if (isValidTimezone(row.timezone)) zones.set(row.id, row.timezone);
    }
  } catch (err) {
    console.warn('[timezone] profiles read failed:', err instanceof Error ? err.message : err);
  }
  return zones;
}

/** Today in the athlete's zone — the server-side stand-in for the client's `today`. */
export async function userToday(supabase: Admin, userId: string, now: Date = new Date()): Promise<string> {
  return localDate(await fetchUserTimezone(supabase, userId), now);
}
