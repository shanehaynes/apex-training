import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { enforceRateLimit } from './_lib/rateLimit.js';
import { parseRRule, serializeRRule, ruleFromLegacyColumns } from '../src/lib/recurrence/index.js';
import type { RecurrenceRule } from '../src/lib/recurrence/index.js';
import { parseTimeOfDay } from '../src/lib/time.js';

export interface FeedEventRow {
  id: string;
  type: string;
  title: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  estimated_duration: number;
  location: string | null;
  is_recurring: boolean;
  recurrence_rule: string | null;
  recurring_frequency: string | null;
  recurring_days: number[] | null;
  recurring_end_date: string | null;
}

export interface FeedExceptionRow {
  event_id: string;
  skipped_date: string; // 'YYYY-MM-DD'
  // Set when the occurrence was rescheduled rather than removed — it becomes
  // an EXDATE plus a standalone VEVENT at the overridden date/time.
  override_date?: string | null;
  override_start_time?: string | null;
  override_end_time?: string | null;
}

// A bare CR (or CRLF) in any interpolated value would end the content line
// and inject arbitrary ICS properties into the feed, so CR is stripped
// outright — RFC 5545 text values have no way to express it anyway.
function escapeIcs(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// All event datetimes are FLOATING (no Z, no TZID) so they display at the
// same wall-clock time on every device — see commit fb62d6a. Do not add
// timezone qualifiers here.
function toIcsDate(dateStr: string, timeStr: string | null): string {
  const d = dateStr.replace(/-/g, '');
  if (!timeStr) return d;
  const parsed = parseTimeOfDay(timeStr);
  if (!parsed) return d;
  const t = String(parsed.h).padStart(2, '0') + String(parsed.m).padStart(2, '0') + '00';
  return `${d}T${t}`;
}

// DTSTAMP is metadata (when the feed was generated), not an event time, so
// it is legitimately UTC per RFC 5545.
function dtstamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

/**
 * End time for a rescheduled occurrence. /api/event-instances allows a
 * startTime-only override, and keeping the base end_time in that case
 * produced DTEND ≤ DTSTART whenever the occurrence moved later — so when
 * only the start moved, the end shifts by the same delta (wrapping past
 * midnight, matching the estimated_duration DTEND behavior below).
 */
function shiftedEndTime(base: FeedEventRow, ex: FeedExceptionRow): string | null {
  if (ex.override_end_time) return ex.override_end_time;
  if (!ex.override_start_time || !base.start_time || !base.end_time) return base.end_time;
  const oldStart = parseTimeOfDay(base.start_time);
  const newStart = parseTimeOfDay(ex.override_start_time);
  const oldEnd = parseTimeOfDay(base.end_time);
  if (!oldStart || !newStart || !oldEnd) return base.end_time;
  const delta = (newStart.h * 60 + newStart.m) - (oldStart.h * 60 + oldStart.m);
  const shifted = (((oldEnd.h * 60 + oldEnd.m + delta) % 1440) + 1440) % 1440;
  return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`;
}

function parseRuleForEvent(ev: FeedEventRow): RecurrenceRule | null {
  const ruleString =
    ev.recurrence_rule ??
    ruleFromLegacyColumns(ev.recurring_frequency, ev.recurring_days, ev.recurring_end_date);
  if (!ruleString) return null;
  try {
    return parseRRule(ruleString);
  } catch (err) {
    console.error(`[api/calendar-feed] Event ${ev.id} has invalid recurrence rule "${ruleString}":`, err);
    return null;
  }
}

export function buildIcs(events: FeedEventRow[], exceptions: FeedExceptionRow[]): string {
  const exdatesByEvent = new Map<string, string[]>();
  for (const ex of exceptions) {
    const list = exdatesByEvent.get(ex.event_id) ?? [];
    list.push(ex.skipped_date);
    exdatesByEvent.set(ex.event_id, list);
  }

  // Rescheduled occurrences: the original slot is vacated by its EXDATE
  // (above); the occurrence itself is re-emitted as a one-off VEVENT at the
  // overridden date/time.
  const byId = new Map(events.map(e => [e.id, e]));
  const movedEvents: FeedEventRow[] = [];
  for (const ex of exceptions) {
    if (!ex.override_date && !ex.override_start_time && !ex.override_end_time) continue;
    const base = byId.get(ex.event_id);
    if (!base) continue;
    movedEvents.push({
      ...base,
      id:         `${base.id}__${ex.skipped_date}`,
      date:       ex.override_date ?? ex.skipped_date,
      start_time: ex.override_start_time ?? base.start_time,
      end_time:   shiftedEndTime(base, ex),
      is_recurring: false,
      recurrence_rule: null,
      recurring_frequency: null,
      recurring_days: null,
      recurring_end_date: null,
    });
  }

  const stamp = dtstamp();
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apex Training//Workout Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Apex Training',
  ];

  for (const ev of [...events, ...movedEvents]) {
    const hasTime = !!ev.start_time;
    const dtstart = toIcsDate(ev.date, ev.start_time);
    const uid = `${ev.id}@apex-training`;

    let dtend: string;
    if (ev.end_time) {
      dtend = toIcsDate(ev.date, ev.end_time);
    } else if (hasTime) {
      const parsed = parseTimeOfDay(ev.start_time!);
      if (parsed) {
        const totalMin = parsed.h * 60 + parsed.m + ev.estimated_duration;
        const eh = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
        const em = String(totalMin % 60).padStart(2, '0');
        dtend = toIcsDate(ev.date, `${eh}:${em}`);
      } else {
        dtend = toIcsDate(ev.date, null);
      }
    } else {
      // All-day: DTEND is next day
      const d = new Date(ev.date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      dtend = d.toISOString().slice(0, 10).replace(/-/g, '');
    }

    lines.push('BEGIN:VEVENT');
    // Ids are validated on insert (EVENT_ID_PATTERN in api/events.ts), but
    // pre-validation rows exist — escape anyway so a hostile id can never
    // break out of the UID line.
    lines.push(`UID:${escapeIcs(uid)}`);
    lines.push(`DTSTAMP:${stamp}`);

    if (hasTime) {
      lines.push(`DTSTART:${dtstart}`);
      lines.push(`DTEND:${dtend}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dtstart}`);
      lines.push(`DTEND;VALUE=DATE:${dtend}`);
    }

    lines.push(`SUMMARY:${escapeIcs(ev.title)}`);

    if (ev.location) {
      lines.push(`LOCATION:${escapeIcs(ev.location)}`);
    }

    if (ev.is_recurring) {
      // serializeRRule re-validates, so an unsupported pattern (e.g. the old
      // 'custom' frequency) can never leak into the feed as a bogus RRULE —
      // the event falls back to a single occurrence instead.
      const rule = parseRuleForEvent(ev);
      if (rule) {
        lines.push(`RRULE:${serializeRRule(rule)}`);

        // Skipped instances (recurring_exceptions) become EXDATEs. The value
        // type must match DTSTART: date-time events exclude the instance at
        // the event's own (floating) start time, all-day events by date.
        const skipped = exdatesByEvent.get(ev.id);
        if (skipped && skipped.length > 0) {
          const values = [...skipped].sort().map(d => toIcsDate(d, ev.start_time));
          if (hasTime) {
            lines.push(`EXDATE:${values.join(',')}`);
          } else {
            lines.push(`EXDATE;VALUE=DATE:${values.join(',')}`);
          }
        }
      }
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return lines.map(foldIcsLine).join('\r\n');
}

/**
 * RFC 5545 §3.1: content lines fold at 75 OCTETS (UTF-8 bytes, not JS code
 * units), and a fold must not split a multi-byte character. Walking by code
 * point keeps surrogate pairs (emoji in titles) intact.
 */
export function foldIcsLine(line: string): string {
  const chunks: string[] = [];
  let chunk = '';
  let budget = 75;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (bytes > budget) {
      chunks.push(chunk);
      chunk = ' ';
      budget = 74; // continuation lines lead with a space
    }
    chunk += ch;
    budget -= bytes;
  }
  chunks.push(chunk);
  return chunks.join('\r\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  // Calendar apps can't send auth headers, so the feed is authorized by a
  // per-user capability token (profiles.ics_token) in the URL instead.
  const token = typeof req.query.token === 'string' ? req.query.token : undefined;
  if (!token) {
    res.status(401).send('Missing feed token');
    return;
  }

  // This is the one unauthenticated endpoint — error bodies stay generic
  // (details go to the server log only), matching every other handler.
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('id')
    .eq('ics_token', token)
    .maybeSingle();
  if (profileErr) {
    console.error('[api/calendar-feed] token lookup failed:', profileErr.message);
    res.status(500).send('Failed to load feed');
    return;
  }
  if (!profile) {
    res.status(401).send('Unknown feed token');
    return;
  }

  // Keyed by the resolved user, so a leaked feed URL can't be used to
  // hammer the database. (Bad-token guesses never reach this point and are
  // UUIDv4-hard anyway.)
  if (!(await enforceRateLimit(supabase, res, profile.id, 'feed'))) return;

  const [eventsRes, exceptionsRes] = await Promise.all([
    supabase
      .from('workout_events')
      .select('id, type, title, date, start_time, end_time, estimated_duration, location, is_recurring, recurrence_rule, recurring_frequency, recurring_days, recurring_end_date')
      .eq('user_id', profile.id)
      .order('date', { ascending: true }),
    supabase
      .from('recurring_exceptions')
      .select('event_id, skipped_date, override_date, override_start_time, override_end_time')
      .eq('user_id', profile.id),
  ]);

  if (eventsRes.error || exceptionsRes.error) {
    console.error(
      '[api/calendar-feed] feed query failed:',
      eventsRes.error?.message ?? exceptionsRes.error?.message,
    );
    res.status(500).send('Failed to load feed');
    return;
  }

  const ics = buildIcs(
    (eventsRes.data ?? []) as FeedEventRow[],
    (exceptionsRes.data ?? []) as FeedExceptionRow[],
  );

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="apex-training.ics"');
  res.setHeader('Cache-Control', 'private, max-age=900');
  res.status(200).send(ics);
}
