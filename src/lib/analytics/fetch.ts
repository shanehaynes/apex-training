import { supabase } from '../supabaseClient';
import type { CardioLogRow, CompletionRow, MealRow, SetLogRow, WorkoutSessionRow } from '../db/types';
import type { Sport } from '../../types/workout';
import type { Period } from '../review/isoMonth';
import type { AnalyticsInputs, EventLite, ZoneActivity } from './engine';
import { zoneSeconds, type HrSettings, zoneBounds } from './hrZones';

// ─── Window-bounded data access ──────────────────────────────────────────────
// The blocks/repo.ts posture: reads through the ANON client under RLS — no
// service role, no new endpoint — bounded to the dashboard's union window.
// Deliberately NOT api/_lib/reviewData.ts fetchPeriodInputs: that pages full
// history for PR detection, far too heavy for a view render (and analytics
// tiles are windowed by definition — PR-style measures stay in the library).
//
// The HR stream fetch is conditional: streams.hr is the heavy column
// (≤2000 points per activity), pulled only when some tile computes
// hr-zone-time, and immediately reduced to per-activity zone seconds so the
// raw arrays never sit in memory or state. Nothing else is read from
// activity_streams any more — the sport dimension is the phase37 column on
// workout_events, not parsed provider summaries.

export const EMPTY_INPUTS: AnalyticsInputs = {
  completions: [],
  sessions: [],
  setLogs: [],
  cardioLogs: [],
  meals: [],
  zoneActivities: [],
  categories: new Map(),
  events: new Map(),
};

/**
 * Everything the engine needs for one window. Offline (supabase === null)
 * yields empty inputs — tiles render their empty states, nothing throws.
 */
export async function loadAnalyticsInputs(
  window: Period,
  opts: { withHrZones: boolean; hr: HrSettings },
): Promise<AnalyticsInputs> {
  if (!supabase) return EMPTY_INPUTS;
  const { startDate, endDateExclusive } = window;

  const bounds = opts.withHrZones ? zoneBounds(opts.hr) : null;

  const [completions, sessions, setLogs, cardioLogs, meals, events, definitions, hrStreams] = await Promise.all([
    supabase
      .from('workout_completions')
      .select('*')
      .eq('is_completed', true)
      .gte('event_date', startDate)
      .lt('event_date', endDateExclusive),
    supabase
      .from('workout_sessions')
      .select('*')
      .gte('event_date', startDate)
      .lt('event_date', endDateExclusive),
    supabase
      .from('workout_set_logs')
      .select('*')
      .eq('is_autofilled', false)
      .gte('event_date', startDate)
      .lt('event_date', endDateExclusive)
      .order('event_date', { ascending: true }),
    supabase
      .from('workout_cardio_logs')
      .select('*')
      .eq('is_autofilled', false)
      .gte('event_date', startDate)
      .lt('event_date', endDateExclusive)
      .order('event_date', { ascending: true }),
    supabase
      .from('meals')
      .select('*')
      .gte('date', startDate)
      .lt('date', endDateExclusive),
    // Unwindowed on purpose: recurring occurrences resolve through their
    // BASE event, whose row date has nothing to do with the occurrence date.
    // Four small columns per event keep this cheap.
    supabase
      .from('workout_events')
      .select('id,title,type,sport'),
    // Small table, unwindowed: categories identify pitch rows.
    supabase
      .from('exercise_definitions')
      .select('id,category'),
    bounds
      ? supabase
          .from('activity_streams')
          .select('event_id,event_date,hr:streams->hr')
          .gte('event_date', startDate)
          .lt('event_date', endDateExclusive)
      : Promise.resolve({ data: [], error: null }),
  ]);

  for (const [label, res] of Object.entries({ completions, sessions, setLogs, cardioLogs, meals, events, definitions, hrStreams })) {
    if (res.error) console.warn(`[apex] analytics ${label} load failed:`, res.error.message);
  }

  const categories = new Map<string, string>();
  for (const d of (definitions.data ?? []) as Array<{ id: string; category: string }>) {
    categories.set(d.id, d.category);
  }

  const eventMap = new Map<string, EventLite>();
  for (const e of (events.data ?? []) as Array<{ id: string; title: string; type: string; sport: string | null }>) {
    eventMap.set(e.id, { title: e.title, type: e.type, sport: (e.sport ?? null) as Sport | null });
  }

  const zoneActivities: ZoneActivity[] = [];
  if (bounds) {
    for (const row of (hrStreams.data ?? []) as Array<{ event_id: string; event_date: string; hr?: unknown }>) {
      if (!Array.isArray(row.hr)) continue;
      zoneActivities.push({
        eventId: row.event_id,
        eventDate: row.event_date,
        zoneSeconds: zoneSeconds(row.hr as Array<[number, number]>, bounds),
      });
    }
  }

  return {
    completions: (completions.data ?? []) as CompletionRow[],
    sessions: (sessions.data ?? []) as WorkoutSessionRow[],
    setLogs: (setLogs.data ?? []) as SetLogRow[],
    cardioLogs: (cardioLogs.data ?? []) as CardioLogRow[],
    meals: (meals.data ?? []) as MealRow[],
    zoneActivities,
    categories,
    events: eventMap,
  };
}
