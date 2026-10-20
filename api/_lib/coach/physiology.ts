import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchAllPages } from '../pagination.js';
import { readWeightContext } from '../weightContext.js';
import { getConnection } from '../providers/connection.js';
import { physiologyWindowStart } from '../../../src/lib/physiology/index.js';
import type {
  ActivityInput,
  CardioLogInput,
  DailyMetricInput,
  PhysiologyInputs,
  SetLogInput,
} from '../../../src/lib/physiology/index.js';

// Server-side inputs for the physiology panel (src/lib/physiology): the four
// sources for the five-week window, mapped onto the pure module's shapes.
// Like blockSummary in context.ts this is an enhancement to the prompt, never
// a precondition — any failure degrades to empty inputs (the panel is then
// simply absent) with one warning, so a table hiccup cannot fail a turn.
//
// activity_streams is read for its summary scalars only: streams.hr is the
// heavy column and the panel does not need it (device zone totals ride in
// summary.hrZones; the average-HR fallback needs nothing more).

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

interface StreamSummaryRow { event_id: string; event_date: string; summary: unknown }
interface CardioRow { event_id: string; event_date: string; avg_heart_rate: number | null; duration_minutes: number | null }
interface DailyRow {
  date: string;
  sleep_minutes: number | null;
  hrv_sdnn_ms: number | null;
  resting_hr: number | null;
  steps: number | null;
  body_mass_lb: number | null;
}
interface SetRow {
  event_date: string;
  actual_weight: string | null;
  actual_reps: string | null;
  actual_duration: string | null;
  is_autofilled: boolean;
  is_warmup: boolean;
}

/** A number the provider may have sent as a number or a numeric string. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function activityFromRow(row: StreamSummaryRow): ActivityInput {
  const s = (typeof row.summary === 'object' && row.summary !== null ? row.summary : {}) as Record<string, unknown>;
  return {
    eventId: row.event_id,
    eventDate: row.event_date,
    durationSec: num(s.durationSec),
    avgHr: num(s.avgHr),
    hrZones: s.hrZones ?? null,
    trainingLoad: num(s.trainingLoad),
    hrv: num(s.hrv),
  };
}

export function dailyFromRow(row: DailyRow): DailyMetricInput {
  return {
    date: row.date,
    sleepMinutes: num(row.sleep_minutes),
    hrvSdnnMs: num(row.hrv_sdnn_ms),
    restingHr: num(row.resting_hr),
    steps: num(row.steps),
    bodyMassLb: num(row.body_mass_lb),
  };
}

/** Apple Health's days (W16 M3b), quiet and optional like the weight
 *  context: a missing table or a failed read costs these lines, not the
 *  panel. Consent governs the read as well as the write (D-056): what
 *  reaches the prompt — and so Anthropic — is only what the athlete has
 *  switched on now. A disconnected provider, or a category turned off,
 *  stops its stored values at once, without waiting for them to age out. */
async function readDailyMetrics(supabase: Admin, userId: string, startDate: string, todayIso: string): Promise<DailyMetricInput[]> {
  const connection = await getConnection(supabase, userId, 'apple').catch(() => null);
  if (!connection || connection.status !== 'connected') return [];
  const daily = connection.categories.dailyMetrics === true;
  const bodyMass = connection.categories.bodyMass === true;
  if (!daily && !bodyMass) return [];
  const { data, error } = await supabase
    .from('daily_metrics')
    .select('date, sleep_minutes, hrv_sdnn_ms, resting_hr, steps, body_mass_lb')
    .eq('user_id', userId)
    .gte('date', startDate)
    .lte('date', todayIso)
    .order('date');
  if (error) {
    console.warn('[api/chat] daily metrics unavailable for the prompt:', error.message);
    return [];
  }
  return ((data ?? []) as DailyRow[]).map(dailyFromRow).map(d => ({
    ...d,
    ...(daily ? {} : { sleepMinutes: null, hrvSdnnMs: null, restingHr: null, steps: null }),
    ...(bodyMass ? {} : { bodyMassLb: null }),
  }));
}

function emptyInputs(todayIso: string): PhysiologyInputs {
  return { today: todayIso, activities: [], cardioLogs: [], setLogs: [], thresholdHr: null, maxHr: null };
}

export async function fetchPhysiologyInputs(
  supabase: Admin,
  userId: string,
  todayIso: string,
): Promise<PhysiologyInputs> {
  try {
    const startDate = physiologyWindowStart(todayIso);
    const [streams, cardio, sets, profileRes, weight, dailyMetrics] = await Promise.all([
      fetchAllPages<StreamSummaryRow>('activity_streams', (from, to) =>
        supabase.from('activity_streams').select('event_id,event_date,summary').eq('user_id', userId)
          .gte('event_date', startDate).lte('event_date', todayIso)
          .order('event_date').order('event_id').range(from, to),
      ),
      fetchAllPages<CardioRow>('workout_cardio_logs', (from, to) =>
        supabase.from('workout_cardio_logs').select('event_id,event_date,avg_heart_rate,duration_minutes')
          .eq('user_id', userId).eq('is_autofilled', false)
          .gte('event_date', startDate).lte('event_date', todayIso)
          .order('event_date').order('event_id').order('exercise_id').range(from, to),
      ),
      fetchAllPages<SetRow>('workout_set_logs', (from, to) =>
        supabase.from('workout_set_logs').select('event_date,actual_weight,actual_reps,actual_duration,is_autofilled,is_warmup')
          .eq('user_id', userId).eq('is_autofilled', false).eq('is_warmup', false)
          .gte('event_date', startDate).lte('event_date', todayIso)
          .order('event_date').order('event_id').order('exercise_id').order('set_number').range(from, to),
      ),
      supabase.from('profiles').select('threshold_hr, max_hr').eq('id', userId).maybeSingle(),
      // Its own read, quiet and optional: a trailing weight column must
      // not cost the whole panel, and an unknown context is simply absent
      // (pounds, the pure module's default).
      readWeightContext(supabase, userId),
      readDailyMetrics(supabase, userId, startDate, todayIso),
    ]);
    if (profileRes.error) throw new Error(`profiles fetch failed: ${profileRes.error.message}`);

    const cardioLogs: CardioLogInput[] = cardio.map(c => ({
      eventId: c.event_id,
      eventDate: c.event_date,
      avgHeartRate: c.avg_heart_rate,
      durationMinutes: c.duration_minutes,
    }));
    const setLogs: SetLogInput[] = sets.map(s => ({
      eventDate: s.event_date,
      actualWeight: s.actual_weight,
      actualReps: s.actual_reps,
      actualDuration: s.actual_duration,
      isAutofilled: s.is_autofilled,
      isWarmup: s.is_warmup,
    }));
    return {
      today: todayIso,
      activities: streams.map(activityFromRow),
      cardioLogs,
      setLogs,
      thresholdHr: profileRes.data?.threshold_hr ?? null,
      maxHr: profileRes.data?.max_hr ?? null,
      ...(weight ? { weight } : {}),
      ...(dailyMetrics.length ? { dailyMetrics } : {}),
    };
  } catch (err) {
    console.warn('[api/chat] physiology unavailable for the prompt:', err instanceof Error ? err.message : err);
    return emptyInputs(todayIso);
  }
}
