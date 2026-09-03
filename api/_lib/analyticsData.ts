import type { getSupabaseAdmin } from './supabaseAdmin.js';
import { fetchAllPages } from './pagination.js';
import type { CardioLogRow, CompletionRow, MealRow, SetLogRow, WorkoutSessionRow } from '../../src/lib/db/types.js';
import type { Sport } from '../../src/types/workout.js';
import type { Period } from '../../src/lib/review/isoMonth.js';
import type { AnalyticsInputs, EventLite, ZoneActivity } from '../../src/lib/analytics/engine.js';
import { zoneBounds, zoneSeconds, type HrSettings } from '../../src/lib/analytics/hrZones.js';

// Service-role port of src/lib/analytics/fetch.ts (W8): everything the
// analytics engine needs for one window, scoped by the verified user id.
// Two deliberate differences from the browser loader: every table pages
// through fetchAllPages (PostgREST's 1000-row default silently truncated a
// heavy user's set logs in the browser), and nothing is read into React
// state — the handler computes and returns TileData, so raw rows never
// leave the function.
//
// The HR stream fetch is conditional: streams.hr is the heavy column
// (≤2000 points per activity), pulled only when some tile computes
// hr-zone-time, and immediately reduced to per-activity zone seconds.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export async function loadAnalyticsInputs(
  supabase: Admin,
  userId: string,
  window: Period,
  opts: { withHrZones: boolean; hr: HrSettings },
): Promise<AnalyticsInputs> {
  const { startDate, endDateExclusive } = window;
  const bounds = opts.withHrZones ? zoneBounds(opts.hr) : null;

  const [completions, sessions, setLogs, cardioLogs, meals, events, definitions, hrStreams] = await Promise.all([
    fetchAllPages<CompletionRow>('workout_completions', (from, to) =>
      supabase.from('workout_completions').select('*').eq('user_id', userId).eq('is_completed', true)
        .gte('event_date', startDate).lt('event_date', endDateExclusive)
        .order('event_date').order('event_id').range(from, to),
    ),
    fetchAllPages<WorkoutSessionRow>('workout_sessions', (from, to) =>
      supabase.from('workout_sessions').select('*').eq('user_id', userId)
        .gte('event_date', startDate).lt('event_date', endDateExclusive)
        .order('event_date').order('event_id').range(from, to),
    ),
    fetchAllPages<SetLogRow>('workout_set_logs', (from, to) =>
      supabase.from('workout_set_logs').select('*').eq('user_id', userId).eq('is_autofilled', false)
        .gte('event_date', startDate).lt('event_date', endDateExclusive)
        .order('event_date', { ascending: true }).order('event_id').order('exercise_id').order('set_number').range(from, to),
    ),
    fetchAllPages<CardioLogRow>('workout_cardio_logs', (from, to) =>
      supabase.from('workout_cardio_logs').select('*').eq('user_id', userId).eq('is_autofilled', false)
        .gte('event_date', startDate).lt('event_date', endDateExclusive)
        .order('event_date', { ascending: true }).order('event_id').order('exercise_id').range(from, to),
    ),
    fetchAllPages<MealRow>('meals', (from, to) =>
      supabase.from('meals').select('*').eq('user_id', userId)
        .gte('date', startDate).lt('date', endDateExclusive)
        .order('date').order('id').range(from, to),
    ),
    // Unwindowed on purpose: recurring occurrences resolve through their
    // BASE event, whose row date has nothing to do with the occurrence date.
    fetchAllPages<{ id: string; title: string; type: string; sport: string | null }>('workout_events', (from, to) =>
      supabase.from('workout_events').select('id,title,type,sport').eq('user_id', userId).order('id').range(from, to),
    ),
    // Small table, unwindowed: categories identify pitch rows.
    fetchAllPages<{ id: string; category: string }>('exercise_definitions', (from, to) =>
      supabase.from('exercise_definitions').select('id,category').eq('user_id', userId).order('id').range(from, to),
    ),
    bounds
      ? fetchAllPages<{ event_id: string; event_date: string; hr: unknown }>('activity_streams', (from, to) =>
          supabase.from('activity_streams').select('event_id,event_date,hr:streams->hr').eq('user_id', userId)
            .gte('event_date', startDate).lt('event_date', endDateExclusive)
            .order('event_date').order('event_id').range(from, to) as never,
        )
      : Promise.resolve([] as Array<{ event_id: string; event_date: string; hr: unknown }>),
  ]);

  const categories = new Map<string, string>();
  for (const d of definitions) categories.set(d.id, d.category);

  const eventMap = new Map<string, EventLite>();
  for (const e of events) eventMap.set(e.id, { title: e.title, type: e.type, sport: (e.sport ?? null) as Sport | null });

  const zoneActivities: ZoneActivity[] = [];
  if (bounds) {
    for (const row of hrStreams) {
      if (!Array.isArray(row.hr)) continue;
      zoneActivities.push({
        eventId: row.event_id,
        eventDate: row.event_date,
        zoneSeconds: zoneSeconds(row.hr as Array<[number, number]>, bounds),
      });
    }
  }

  return { completions, sessions, setLogs, cardioLogs, meals, zoneActivities, categories, events: eventMap };
}
