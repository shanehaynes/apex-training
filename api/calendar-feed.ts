import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
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

function escapeIcs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
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
      end_time:   ex.override_end_time ?? base.end_time,
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
    lines.push(`UID:${uid}`);
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

  // iCalendar spec: lines must be folded at 75 octets
  const folded = lines.map(line => {
    if (line.length <= 75) return line;
    const chunks: string[] = [];
    let remaining = line;
    chunks.push(remaining.slice(0, 75));
    remaining = remaining.slice(75);
    while (remaining.length > 0) {
      chunks.push(' ' + remaining.slice(0, 74));
      remaining = remaining.slice(74);
    }
    return chunks.join('\r\n');
  });

  return folded.join('\r\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    res.status(500).send('Supabase env vars not configured');
    return;
  }

  const supabase = createClient(url, key);

  const [eventsRes, exceptionsRes] = await Promise.all([
    supabase
      .from('workout_events')
      .select('id, type, title, date, start_time, end_time, estimated_duration, location, is_recurring, recurrence_rule, recurring_frequency, recurring_days, recurring_end_date')
      .order('date', { ascending: true }),
    supabase.from('recurring_exceptions').select('event_id, skipped_date, override_date, override_start_time, override_end_time'),
  ]);

  if (eventsRes.error) {
    res.status(500).send(`Supabase error: ${eventsRes.error.message}`);
    return;
  }
  if (exceptionsRes.error) {
    res.status(500).send(`Supabase error: ${exceptionsRes.error.message}`);
    return;
  }

  const ics = buildIcs(
    (eventsRes.data ?? []) as FeedEventRow[],
    (exceptionsRes.data ?? []) as FeedExceptionRow[],
  );

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="apex-training.ics"');
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.status(200).send(ics);
}
