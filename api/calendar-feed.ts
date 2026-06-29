import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

interface WorkoutEventRow {
  id: string;
  type: string;
  title: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  estimated_duration: number;
  location: string | null;
  is_recurring: boolean;
  recurring_frequency: string | null;
  recurring_days: number[] | null;
  recurring_end_date: string | null;
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// Parses "5:30 PM", "17:30", "5:30 pm", etc. → { h: 17, m: 30 }
function parseTime(timeStr: string): { h: number; m: number } | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && h !== 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return { h, m };
}

function toIcsDate(dateStr: string, timeStr: string | null): string {
  const d = dateStr.replace(/-/g, '');
  if (!timeStr) return d;
  const parsed = parseTime(timeStr);
  if (!parsed) return d;
  const t = String(parsed.h).padStart(2, '0') + String(parsed.m).padStart(2, '0') + '00';
  return `${d}T${t}`;
}

function dtstamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

// Map JS day-of-week (0=Sun) to iCal BYDAY abbreviation
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    res.status(500).send('Supabase env vars not configured');
    return;
  }

  const supabase = createClient(url, key);

  const { data, error } = await supabase
    .from('workout_events')
    .select('id, type, title, date, start_time, end_time, estimated_duration, location, is_recurring, recurring_frequency, recurring_days, recurring_end_date')
    .order('date', { ascending: true });

  if (error) {
    res.status(500).send(`Supabase error: ${error.message}`);
    return;
  }

  const events = (data ?? []) as WorkoutEventRow[];

  // Build a set of (type, date) pairs covered by recurring events so we can
  // skip individual rows that would duplicate them — mirrors the app's expandRecurringEvents logic.
  const recurringCoverage = new Set<string>();
  for (const ev of events) {
    if (!ev.is_recurring || !ev.recurring_end_date || ev.recurring_frequency !== 'daily') continue;
    const start = new Date(ev.date + 'T00:00:00');
    const end = new Date(ev.recurring_end_date + 'T00:00:00');
    const cursor = new Date(start);
    cursor.setDate(cursor.getDate() + 1);
    while (cursor <= end) {
      recurringCoverage.add(`${ev.type}__${cursor.toISOString().slice(0, 10)}`);
      cursor.setDate(cursor.getDate() + 1);
    }
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

  for (const ev of events) {
    if (!ev.is_recurring && recurringCoverage.has(`${ev.type}__${ev.date}`)) continue;
    const hasTime = !!ev.start_time;
    const dtstart = toIcsDate(ev.date, ev.start_time);
    const uid = `${ev.id}@apex-training`;

    let dtend: string;
    if (ev.end_time) {
      dtend = toIcsDate(ev.date, ev.end_time);
    } else if (hasTime) {
      const parsed = parseTime(ev.start_time!);
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
      const d = new Date(ev.date + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      dtend = d.toISOString().slice(0, 10).replace(/-/g, '');
    }

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${stamp}Z`);

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

    if (ev.is_recurring && ev.recurring_frequency) {
      let rrule = `FREQ=${ev.recurring_frequency.toUpperCase()}`;
      if (ev.recurring_days && ev.recurring_days.length > 0) {
        rrule += `;BYDAY=${ev.recurring_days.map(d => BYDAY[d]).join(',')}`;
      }
      if (ev.recurring_end_date) {
        rrule += `;UNTIL=${ev.recurring_end_date.replace(/-/g, '')}`;
      }
      lines.push(`RRULE:${rrule}`);
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

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="apex-training.ics"');
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.status(200).send(folded.join('\r\n'));
}
