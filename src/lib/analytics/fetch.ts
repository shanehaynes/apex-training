import { supabase } from '../supabaseClient';
import type { CardioLogRow, CompletionRow, MealRow, SetLogRow, WorkoutSessionRow } from '../db/types';
import type { Period } from '../review/isoMonth';
import type { AnalyticsInputs, StreamActivity } from './engine';
import { zoneSeconds, type HrSettings, zoneBounds } from './hrZones';

// ─── Window-bounded data access ──────────────────────────────────────────────
// The blocks/repo.ts posture: reads through the ANON client under RLS — no
// service role, no new endpoint — bounded to the dashboard's union window.
// Deliberately NOT api/_lib/reviewData.ts fetchPeriodInputs: that pages full
// history for PR detection, far too heavy for a view render (and analytics
// tiles are windowed by definition — PR-style measures stay in the library).
//
// The HR stream fetch is separate and conditional: streams.hr is the heavy
// column (≤2000 points per activity), pulled only when some tile computes
// hr-zone-time, and immediately reduced to per-activity zone seconds so the
// raw arrays never sit in memory or state.

export const EMPTY_INPUTS: AnalyticsInputs = {
  completions: [],
  sessions: [],
  setLogs: [],
  cardioLogs: [],
  meals: [],
  streams: [],
  categories: new Map(),
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface StreamRow {
  event_id: string;
  event_date: string;
  summary: Record<string, unknown> | null;
  hr?: unknown;
}

function toActivity(row: StreamRow, hr: HrSettings, withZones: boolean): StreamActivity {
  const s = row.summary ?? {};
  const bounds = withZones ? zoneBounds(hr) : null;
  const samples = bounds && Array.isArray(row.hr) ? (row.hr as Array<[number, number]>) : null;
  return {
    eventId: row.event_id,
    eventDate: row.event_date,
    sportLabel: str(s.sportLabel),
    distanceMeters: num(s.distanceMeters),
    elevationGainMeters: num(s.elevationGainMeters),
    durationSec: num(s.durationSec),
    calories: num(s.calories),
    avgHr: num(s.avgHr),
    zoneSeconds: samples && bounds ? zoneSeconds(samples, bounds) : null,
  };
}

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

  // streams.hr rides the same query only when zone tiles exist — the summary
  // is a small scalar bag, the stream is not.
  const streamSelect = opts.withHrZones && zoneBounds(opts.hr) !== null
    ? 'event_id,event_date,summary,hr:streams->hr'
    : 'event_id,event_date,summary';

  const [completions, sessions, setLogs, cardioLogs, meals, streams, definitions] = await Promise.all([
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
    supabase
      .from('activity_streams')
      .select(streamSelect)
      .gte('event_date', startDate)
      .lt('event_date', endDateExclusive),
    // Small table, unwindowed: categories identify pitch rows.
    supabase
      .from('exercise_definitions')
      .select('id,category'),
  ]);

  for (const [label, res] of Object.entries({ completions, sessions, setLogs, cardioLogs, meals, streams, definitions })) {
    if (res.error) console.warn(`[apex] analytics ${label} load failed:`, res.error.message);
  }

  const categories = new Map<string, string>();
  for (const d of (definitions.data ?? []) as Array<{ id: string; category: string }>) {
    categories.set(d.id, d.category);
  }

  return {
    completions: (completions.data ?? []) as CompletionRow[],
    sessions: (sessions.data ?? []) as WorkoutSessionRow[],
    setLogs: (setLogs.data ?? []) as SetLogRow[],
    cardioLogs: (cardioLogs.data ?? []) as CardioLogRow[],
    meals: (meals.data ?? []) as MealRow[],
    streams: ((streams.data ?? []) as unknown as StreamRow[]).map(r => toActivity(r, opts.hr, opts.withHrZones)),
    categories,
  };
}
