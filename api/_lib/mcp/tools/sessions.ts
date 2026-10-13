import type { McpToolDef } from '../protocol.js';
import { ToolInputError } from '../protocol.js';
import { optionalInt, requireDate } from '../args.js';
import { todayIso } from '../data.js';
import type { WorkoutSessionRow } from '../../../../src/lib/db/types.js';
import { baseIdOf } from '../../../../src/lib/schedule/occurrence.js';

// Post-workout summaries: the coach's own write-up of each finished session
// (workout_sessions.coach_summary, saved once at Finish). Read back so the
// coach can periodize from what it said last time instead of from a blank
// slate.

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_LIMIT = 50;

function optionalDate(args: Record<string, unknown>, key: string): string | undefined {
  return args[key] === undefined || args[key] === null ? undefined : requireDate(args, key);
}

function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

function durationMinutesOf(row: WorkoutSessionRow): number | null {
  if (row.total_duration_seconds != null) return Math.round(row.total_duration_seconds / 60);
  if (row.finished_at) {
    const ms = Date.parse(row.finished_at) - Date.parse(row.started_at);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms / 60_000);
  }
  return null;
}

export const getSessionSummariesTool: McpToolDef = {
  name: 'get_session_summaries',
  description:
    'The coach\'s post-workout summaries for finished sessions in a date range (default: the last 30 days), ' +
    'newest first. Each carries the workout title, date, duration and the summary text written at Finish. ' +
    'Use get_workout_detail (event_id + date) for the sets behind a session.',
  inputSchema: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'Range start, YYYY-MM-DD (inclusive). Default: 30 days before end.' },
      end: { type: 'string', description: 'Range end, YYYY-MM-DD (inclusive). Default: today.' },
      limit: { type: 'integer', description: 'Sessions to return (default 20, max 50).' },
    },
  },
  async run(supabase, userId, args) {
    const end = optionalDate(args, 'end') ?? todayIso();
    const start = optionalDate(args, 'start') ?? shiftDays(end, -DEFAULT_WINDOW_DAYS);
    if (end < start) throw new ToolInputError('end must be on or after start.');
    const limit = optionalInt(args, 'limit', 20, 1, MAX_LIMIT);

    const { data, error } = await supabase
      .from('workout_sessions')
      .select('*')
      .eq('user_id', userId)
      .gte('event_date', start)
      .lte('event_date', end)
      .not('coach_summary', 'is', null)
      .neq('coach_summary', '')
      .order('event_date', { ascending: false })
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`workout_sessions fetch failed: ${error.message}`);
    const sessions = (data ?? []) as WorkoutSessionRow[];
    if (sessions.length === 0) return { start, end, sessions: [] };

    // Title join. The session's event_id is the occurrence id the completion
    // row shares, and workout_completions.event_title is the title the review
    // stats use for the same session — the first choice. A session that was
    // never marked complete falls back to the base event's current title.
    const occurrenceIds = [...new Set(sessions.map(s => s.event_id))];
    const baseIds = [...new Set(occurrenceIds.map(baseIdOf))];
    const [completionsRes, eventsRes] = await Promise.all([
      supabase
        .from('workout_completions')
        .select('event_id, event_date, event_title')
        .eq('user_id', userId)
        .in('event_id', occurrenceIds),
      supabase.from('workout_events').select('id, title').eq('user_id', userId).in('id', baseIds),
    ]);
    if (completionsRes.error) throw new Error(`workout_completions fetch failed: ${completionsRes.error.message}`);
    if (eventsRes.error) throw new Error(`workout_events fetch failed: ${eventsRes.error.message}`);

    const completionTitles = new Map(
      ((completionsRes.data ?? []) as Array<{ event_id: string; event_date: string; event_title: string }>).map(
        c => [`${c.event_id}|${c.event_date}`, c.event_title],
      ),
    );
    const eventTitles = new Map(
      ((eventsRes.data ?? []) as Array<{ id: string; title: string }>).map(e => [e.id, e.title]),
    );

    return {
      start,
      end,
      sessions: sessions.map(s => ({
        date: s.event_date,
        eventId: s.event_id,
        title:
          completionTitles.get(`${s.event_id}|${s.event_date}`) ??
          eventTitles.get(baseIdOf(s.event_id)) ??
          'Workout',
        durationMinutes: durationMinutesOf(s),
        summary: s.coach_summary as string,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// list_sessions — the workout history. Every past session, newest first,
// behind an opaque keyset cursor; unlike get_session_summaries it does not
// require a coach summary or a date window. One tool serves the web History
// overlay (through /api/query) and iOS.

const LIST_DEFAULT_LIMIT = 20;
/** Rows examined per round trip while a filter is on; the first page can scan up to LIST_MAX_BATCHES of them. */
const LIST_SCAN_BATCH = 200;
const LIST_MAX_BATCHES = 10;
const LIST_FILTER_MAX_CHARS = 100;

export interface SessionCursor {
  eventDate: string;
  startedAt: string;
}

/** Opaque to callers: base64url of the (event_date, started_at) keyset so an insert never shifts a page. */
export function encodeSessionCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify({ d: cursor.eventDate, t: cursor.startedAt }), 'utf8').toString('base64url');
}

export function decodeSessionCursor(raw: string): SessionCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ToolInputError('cursor is not a cursor this tool issued.');
  }
  const obj = parsed as { d?: unknown; t?: unknown } | null;
  if (
    typeof obj !== 'object' || obj === null ||
    typeof obj.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.d) ||
    typeof obj.t !== 'string' || !Number.isFinite(Date.parse(obj.t))
  ) {
    throw new ToolInputError('cursor is not a cursor this tool issued.');
  }
  return { eventDate: obj.d, startedAt: obj.t };
}

/**
 * The PostgREST `or` predicate for "strictly after the cursor" in
 * (event_date desc, started_at desc) order. Values are quoted so a
 * timestamp's punctuation can never be read as filter syntax.
 */
export function sessionCursorPredicate(cursor: SessionCursor): string {
  return `event_date.lt."${cursor.eventDate}",and(event_date.eq."${cursor.eventDate}",started_at.lt."${cursor.startedAt}")`;
}

export interface SessionListFilters {
  type?: string;
  sport?: string;
  tag?: string;
  /** Case-insensitive substring of the title. */
  q?: string;
  /** Case-insensitive substring of any logged exercise name. */
  exercise?: string;
}

/** What one session looks like once its event and logs are joined in. */
export interface JoinedSession {
  title: string;
  type: string | null;
  sport: string | null;
  tags: string[];
  exerciseNames: string[];
}

const fold = (s: string) => s.trim().toLowerCase();

/** Every filter present must hold (AND); an absent filter holds trivially. */
export function matchesSessionFilters(joined: JoinedSession, filters: SessionListFilters): boolean {
  if (filters.type !== undefined && fold(joined.type ?? '') !== fold(filters.type)) return false;
  if (filters.sport !== undefined && fold(joined.sport ?? '') !== fold(filters.sport)) return false;
  if (filters.tag !== undefined && !joined.tags.some(t => fold(t) === fold(filters.tag!))) return false;
  if (filters.q !== undefined && !fold(joined.title).includes(fold(filters.q))) return false;
  if (filters.exercise !== undefined && !joined.exerciseNames.some(n => fold(n).includes(fold(filters.exercise!)))) return false;
  return true;
}

function optionalFilter(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > LIST_FILTER_MAX_CHARS) {
    throw new ToolInputError(`${key} must be at most ${LIST_FILTER_MAX_CHARS} characters.`);
  }
  return trimmed;
}

/** `%`, `_` and `\` are LIKE metacharacters; a user typing them means the literal. */
function ilikePattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
}

function durationSecondsOf(row: WorkoutSessionRow): number | null {
  if (row.total_duration_seconds != null) return row.total_duration_seconds;
  if (row.finished_at) {
    const ms = Date.parse(row.finished_at) - Date.parse(row.started_at);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms / 1000);
  }
  return null;
}

export interface SessionListRow {
  id: string;
  eventId: string;
  eventDate: string;
  title: string;
  type: string | null;
  sport: string | null;
  tags: string[];
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  hasSummary: boolean;
  score: { type: string; timeSeconds: number | null; rounds: number | null; reps: number | null } | null;
}

const cursorOf = (row: WorkoutSessionRow): SessionCursor => ({ eventDate: row.event_date, startedAt: row.started_at });

export const listSessionsTool: McpToolDef = {
  name: 'list_sessions',
  description:
    'The workout history: every tracked session, newest first, in pages. Each row carries the workout title, ' +
    'type, sport, tags, when it started and finished, its duration, whether a coach summary exists and any ' +
    'for-time/AMRAP score. Filters combine with AND: type and sport match exactly, tag matches one of the ' +
    'event\'s tags, q is a case-insensitive substring of the title, exercise a substring of any logged exercise ' +
    'name. Pass nextCursor back as cursor for the next page; null means the end. A page may come back shorter ' +
    'than limit with a cursor still set when a filter is sparse — keep paging. Use get_workout_detail ' +
    '(event_id + date) for the sets behind a session and get_session_summaries for the coach\'s write-ups.',
  inputSchema: {
    type: 'object',
    properties: {
      cursor: { type: 'string', description: 'The nextCursor of the previous page. Omit for the newest page.' },
      limit: { type: 'integer', description: 'Sessions per page (default 20, max 50).' },
      type: { type: 'string', description: 'Workout type, e.g. weights, climbing, cardio, stretching.' },
      sport: { type: 'string', description: 'Sport, e.g. running, biking, swimming, climbing.' },
      exercise: { type: 'string', description: 'Only sessions that logged an exercise whose name contains this.' },
      tag: { type: 'string', description: 'Only sessions whose event carries this tag.' },
      q: { type: 'string', description: 'Case-insensitive substring of the workout title.' },
    },
  },
  async run(supabase, userId, args) {
    const limit = optionalInt(args, 'limit', LIST_DEFAULT_LIMIT, 1, MAX_LIMIT);
    const rawCursor = optionalFilter(args, 'cursor');
    let cursor = rawCursor === undefined ? null : decodeSessionCursor(rawCursor);
    const filters: SessionListFilters = {
      type: optionalFilter(args, 'type'),
      sport: optionalFilter(args, 'sport'),
      tag: optionalFilter(args, 'tag'),
      q: optionalFilter(args, 'q'),
      exercise: optionalFilter(args, 'exercise'),
    };
    const filtering = Object.values(filters).some(v => v !== undefined);
    // Unfiltered, one page is one query. Filtered, rows are judged after the
    // joins, so each round trip looks at a bigger slice and keeps going until
    // the page fills, the table ends, or the scan cap is hit (then the cursor
    // marks how far it got and the caller pages on).
    const batchSize = filtering ? LIST_SCAN_BATCH : limit;

    const sessions: SessionListRow[] = [];
    let nextCursor: string | null = null;

    for (let batch = 0; batch < (filtering ? LIST_MAX_BATCHES : 1); batch++) {
      let query = supabase
        .from('workout_sessions')
        .select('*')
        .eq('user_id', userId)
        .order('event_date', { ascending: false })
        .order('started_at', { ascending: false })
        .limit(batchSize);
      if (cursor) query = query.or(sessionCursorPredicate(cursor));
      const { data, error } = await query;
      if (error) throw new Error(`workout_sessions fetch failed: ${error.message}`);
      const rows = (data ?? []) as WorkoutSessionRow[];
      if (rows.length === 0) {
        nextCursor = null;
        break;
      }
      const exhausted = rows.length < batchSize;

      const joined = await joinSessions(supabase, userId, rows, filters.exercise);
      let filled = false;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const j = joined.get(row.id)!;
        if (!matchesSessionFilters(j, filters)) continue;
        sessions.push({
          id: row.id,
          eventId: row.event_id,
          eventDate: row.event_date,
          title: j.title,
          type: j.type,
          sport: j.sport,
          tags: j.tags,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          durationSeconds: durationSecondsOf(row),
          hasSummary: !!row.coach_summary && row.coach_summary.trim() !== '',
          score: row.score_type
            ? { type: row.score_type, timeSeconds: row.score_time_seconds, rounds: row.score_rounds, reps: row.score_reps }
            : null,
        });
        if (sessions.length === limit) {
          nextCursor = exhausted && i === rows.length - 1 ? null : encodeSessionCursor(cursorOf(row));
          filled = true;
          break;
        }
      }
      if (filled) break;
      if (exhausted) {
        nextCursor = null;
        break;
      }
      cursor = cursorOf(rows[rows.length - 1]);
      nextCursor = encodeSessionCursor(cursor);
    }

    return { sessions, nextCursor };
  },
};

type Admin = Parameters<McpToolDef['run']>[0];

/**
 * Title, type, sport and tags for each session row, by session id. Title
 * prefers the completion row (what the review stats use), then the base
 * event; type likewise. Exercise names are joined only when the exercise
 * filter asks for them, and only the names that match it.
 */
async function joinSessions(
  supabase: Admin,
  userId: string,
  rows: WorkoutSessionRow[],
  exercise: string | undefined,
): Promise<Map<string, JoinedSession>> {
  const occurrenceIds = [...new Set(rows.map(s => s.event_id))];
  const baseIds = [...new Set(occurrenceIds.map(baseIdOf))];
  const [completionsRes, eventsRes, setLogsRes, cardioLogsRes] = await Promise.all([
    supabase
      .from('workout_completions')
      .select('event_id, event_date, event_title, event_type')
      .eq('user_id', userId)
      .in('event_id', occurrenceIds),
    supabase.from('workout_events').select('id, title, type, sport, tags').eq('user_id', userId).in('id', baseIds),
    exercise === undefined
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from('workout_set_logs')
          .select('event_id, event_date, exercise_name')
          .eq('user_id', userId)
          .in('event_id', occurrenceIds)
          .ilike('exercise_name', ilikePattern(exercise)),
    exercise === undefined
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from('workout_cardio_logs')
          .select('event_id, event_date, exercise_name')
          .eq('user_id', userId)
          .in('event_id', occurrenceIds)
          .ilike('exercise_name', ilikePattern(exercise)),
  ]);
  if (completionsRes.error) throw new Error(`workout_completions fetch failed: ${completionsRes.error.message}`);
  if (eventsRes.error) throw new Error(`workout_events fetch failed: ${eventsRes.error.message}`);
  if (setLogsRes.error) throw new Error(`workout_set_logs fetch failed: ${setLogsRes.error.message}`);
  if (cardioLogsRes.error) throw new Error(`workout_cardio_logs fetch failed: ${cardioLogsRes.error.message}`);

  const key = (eventId: string, eventDate: string) => `${eventId}|${eventDate}`;
  const completions = new Map(
    ((completionsRes.data ?? []) as Array<{ event_id: string; event_date: string; event_title: string; event_type: string }>)
      .map(c => [key(c.event_id, c.event_date), c]),
  );
  const events = new Map(
    ((eventsRes.data ?? []) as Array<{ id: string; title: string; type: string; sport: string | null; tags: string[] | null }>)
      .map(e => [e.id, e]),
  );
  const exerciseNames = new Map<string, string[]>();
  for (const log of [...(setLogsRes.data ?? []), ...(cardioLogsRes.data ?? [])] as Array<{ event_id: string; event_date: string; exercise_name: string }>) {
    const k = key(log.event_id, log.event_date);
    const names = exerciseNames.get(k) ?? [];
    if (!names.includes(log.exercise_name)) names.push(log.exercise_name);
    exerciseNames.set(k, names);
  }

  return new Map(rows.map(s => {
    const completion = completions.get(key(s.event_id, s.event_date));
    const event = events.get(baseIdOf(s.event_id));
    return [s.id, {
      title: completion?.event_title ?? event?.title ?? 'Workout',
      type: completion?.event_type ?? event?.type ?? null,
      sport: event?.sport ?? null,
      tags: event?.tags ?? [],
      exerciseNames: exerciseNames.get(key(s.event_id, s.event_date)) ?? [],
    }];
  }));
}
