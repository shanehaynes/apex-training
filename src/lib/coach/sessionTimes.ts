// edit_session_times: correcting when a finished session actually started
// and ended (docs/specs/coach-session-times). The executor in tools.ts and its
// card label both read from here, so the card names the instants the executor
// will store. Pure: the recorded session arrives as an argument, and the
// server's applyEditTimes re-checks every bound that needs the clock or the
// database (finished only, tracked only, not synced, not in the future).

/** ISO 8601 with an explicit zone: a bare wall-clock time means nothing on a UTC server. */
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A week: longer than any session one sitting holds, short enough that no
 *  duration overflows a Date or reads as anything but a mistake. */
export const MAX_SESSION_MINUTES = 7 * 24 * 60;

/** True for a YYYY-MM-DD that names a real day; Date.parse rolls Feb 30 into March. */
function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** A session as it is recorded now. */
export interface RecordedSessionTimes {
  /** The session row's own event id: the occurrence id (base__date) for a recurring workout. */
  eventId: string;
  title?: string;
  startedAt: string;
  finishedAt: string | null;
  totalDurationSeconds: number | null;
}

export interface SessionTimesRequest {
  eventId: string;
  date: string;
  /** Epoch ms; absent keeps the recorded start. */
  startedAt?: number;
  /** Epoch ms; exactly one of finishedAt / durationMinutes is set. */
  finishedAt?: number;
  durationMinutes?: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function zonedInstant(value: unknown, field: string): Parsed<number | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string' || !ZONED_ISO.test(value.trim()) || !isCalendarDate(value.trim().slice(0, 10))) {
    return {
      ok: false,
      reason: `${field} must be an ISO 8601 timestamp with a UTC offset or Z (e.g. 2026-09-02T01:30:00Z). ` +
        'If you do not know the athlete\'s offset, send duration_minutes instead.',
    };
  }
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) return { ok: false, reason: `${field} is not a real date and time.` };
  return { ok: true, value: ms };
}

/** Check the tool input's shape; nothing here needs the recorded session. */
export function parseSessionTimesInput(input: Record<string, unknown>): Parsed<SessionTimesRequest> {
  const eventId = typeof input.event_id === 'string' ? input.event_id.trim() : '';
  if (!eventId) return { ok: false, reason: 'event_id is required: the bracketed id of the workout.' };
  const date = typeof input.date === 'string' ? input.date.trim() : '';
  if (!isCalendarDate(date)) return { ok: false, reason: "date is required: the session's workout date, YYYY-MM-DD." };

  const started = zonedInstant(input.started_at, 'started_at');
  if (!started.ok) return started;
  const finished = zonedInstant(input.finished_at, 'finished_at');
  if (!finished.ok) return finished;

  const hasDuration = input.duration_minutes !== undefined && input.duration_minutes !== null;
  if (hasDuration === (finished.value !== undefined)) {
    return { ok: false, reason: 'Send exactly one of finished_at or duration_minutes. Nothing was changed.' };
  }
  let durationMinutes: number | undefined;
  if (hasDuration) {
    const d = input.duration_minutes;
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > MAX_SESSION_MINUTES) {
      return { ok: false, reason: `duration_minutes must be a number of minutes greater than zero and at most ${MAX_SESSION_MINUTES}.` };
    }
    durationMinutes = d;
  }
  if (started.value !== undefined && finished.value !== undefined && finished.value <= started.value) {
    return { ok: false, reason: 'finished_at must be after started_at. Nothing was changed.' };
  }
  return {
    ok: true,
    value: { eventId, date, startedAt: started.value, finishedAt: finished.value, durationMinutes },
  };
}

export interface ResolvedSessionTimes {
  startedAt: Date;
  finishedAt: Date;
  totalDurationSeconds: number;
}

/** The instants to store: the request's, with the recorded start where it gave none. */
export function resolveSessionTimes(
  request: SessionTimesRequest,
  recorded: Pick<RecordedSessionTimes, 'startedAt'>,
): Parsed<ResolvedSessionTimes> {
  const start = request.startedAt ?? Date.parse(recorded.startedAt);
  if (Number.isNaN(start)) return { ok: false, reason: 'The recorded start is unreadable; send started_at.' };
  const finish = endOf(request, start);
  if (Math.round((finish - start) / 1000) < 1) {
    return { ok: false, reason: 'That finish is not after the session\'s start. Nothing was changed.' };
  }
  return {
    ok: true,
    value: {
      startedAt: new Date(start),
      finishedAt: new Date(finish),
      totalDurationSeconds: Math.round((finish - start) / 1000),
    },
  };
}

/** The finish a request names: its own, or the start plus its duration. */
function endOf(request: Pick<SessionTimesRequest, 'finishedAt' | 'durationMinutes'>, start: number): number {
  return request.finishedAt ?? start + Math.round((request.durationMinutes ?? 0) * 60_000);
}

/** What the recorded duration reads as today: the stored total, else finish − start. */
export function recordedSeconds(recorded: RecordedSessionTimes): number | null {
  if (recorded.totalDurationSeconds != null) return recorded.totalDurationSeconds;
  if (!recorded.finishedAt) return null;
  const ms = Date.parse(recorded.finishedAt) - Date.parse(recorded.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

/** "16 min", "28,264 min" — whole minutes, as the history and the review show them. */
export function formatDurationMinutes(seconds: number): string {
  return `${Math.round(seconds / 60).toLocaleString('en-US')} min`;
}

function formatter(timeZone: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    // An unknown zone name: say UTC out loud rather than throw from a label.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
}

/**
 * "Sep 1, 9:14 PM EDT → 9:30 PM EDT" in `timeZone` (the runtime's own zone
 * when absent: the browser's, on the web). The zone is always named, so a
 * server label in UTC never passes for local time.
 */
export function formatTimeRange(start: number, finish: number, timeZone?: string): string {
  const day = formatter(timeZone, { month: 'short', day: 'numeric' });
  const clock = formatter(timeZone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const startDay = day.format(start);
  const finishDay = day.format(finish);
  const end = startDay === finishDay ? clock.format(finish) : `${finishDay}, ${clock.format(finish)}`;
  return `${startDay}, ${clock.format(start)} → ${end}`;
}

/**
 * The card's account of the new times, from the input alone (the card holds
 * no session rows). Total: an input the executor will refuse still gets a
 * line, and the refusal reaches the coach once confirmed.
 */
export function describeSessionTimes(input: Record<string, unknown>, timeZone?: string): string {
  const REJECTED = 'times the app will reject';
  const parsed = parseSessionTimesInput(input);
  if (!parsed.ok) return REJECTED;
  const r = parsed.value;
  try {
    if (r.startedAt !== undefined) {
      const finish = endOf(r, r.startedAt);
      // Seconds rounded first, as resolveSessionTimes stores them, so the card
      // and the record never land on different sides of a half minute.
      return `${formatTimeRange(r.startedAt, finish, timeZone)} · ${formatDurationMinutes(Math.round((finish - r.startedAt) / 1000))}`;
    }
    if (r.finishedAt !== undefined) {
      const finish = formatter(timeZone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      // The duration needs the recorded start, which the card does not hold;
      // the tool result states it once the edit lands.
      return `recorded start kept, finish ${finish.format(r.finishedAt)}`;
    }
    return `recorded start kept · ${formatDurationMinutes(Math.round((r.durationMinutes ?? 0) * 60))}`;
  } catch {
    return REJECTED;
  }
}
