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
