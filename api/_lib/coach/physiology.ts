import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchAllPages } from '../pagination.js';
import { physiologyWindowStart } from '../../../src/lib/physiology/index.js';
import type {
  ActivityInput,
  CardioLogInput,
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
interface SetRow {
  event_date: string;
  actual_weight: string | null;
  actual_reps: string | null;
  actual_duration: string | null;
  is_autofilled: boolean;
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
    const [streams, cardio, sets, profileRes] = await Promise.all([
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
        supabase.from('workout_set_logs').select('event_date,actual_weight,actual_reps,actual_duration,is_autofilled')
          .eq('user_id', userId).eq('is_autofilled', false)
          .gte('event_date', startDate).lte('event_date', todayIso)
          .order('event_date').order('event_id').order('exercise_id').order('set_number').range(from, to),
      ),
      supabase.from('profiles').select('threshold_hr, max_hr').eq('id', userId).maybeSingle(),
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
    }));
    return {
      today: todayIso,
      activities: streams.map(activityFromRow),
      cardioLogs,
      setLogs,
      thresholdHr: profileRes.data?.threshold_hr ?? null,
      maxHr: profileRes.data?.max_hr ?? null,
    };
  } catch (err) {
    console.warn('[api/chat] physiology unavailable for the prompt:', err instanceof Error ? err.message : err);
    return emptyInputs(todayIso);
  }
}
