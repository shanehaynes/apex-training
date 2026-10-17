import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { getConnection, type AppleCategory } from '../providers/connection.js';
import { isValidTimezone, localDate } from '../userTimezone.js';
import { fail, succeed, type ServiceResult } from './result.js';

// Apple Health's daily metrics (W16 M3b, phase59's daily_metrics): what the
// phone read about each day — sleep, overnight HRV, resting HR, steps, body
// mass — upserted one row per (user, date, provider). The coach's physiology
// block reads them (api/_lib/coach/physiology.ts).
//
// HealthKit delivers piecemeal (steps all day, sleep next morning), so a day
// arrives in pieces: an absent field leaves what is stored, an explicit null
// clears it. Consent is the connection's categories, enforced here.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export const MAX_DAYS_PER_POST = 62;
export const MAX_READ_DAYS = 400;
const PAST_DAYS = 90;
const MAX_SOURCES_BYTES = 2_000;

/** Which category each field needs (D-056). */
const FIELD_CATEGORY: Record<string, AppleCategory> = {
  sleepMinutes: 'dailyMetrics',
  sleepStages: 'dailyMetrics',
  sleepStart: 'dailyMetrics',
  sleepEnd: 'dailyMetrics',
  hrvSdnnMs: 'dailyMetrics',
  restingHr: 'dailyMetrics',
  steps: 'dailyMetrics',
  bodyMassLb: 'bodyMass',
  bodyMassAt: 'bodyMass',
  sources: 'dailyMetrics',
};

const COLUMN: Record<string, string> = {
  sleepMinutes: 'sleep_minutes',
  sleepStages: 'sleep_stages',
  sleepStart: 'sleep_start',
  sleepEnd: 'sleep_end',
  hrvSdnnMs: 'hrv_sdnn_ms',
  restingHr: 'resting_hr',
  steps: 'steps',
  bodyMassLb: 'body_mass_lb',
  bodyMassAt: 'body_mass_at',
  sources: 'sources',
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type FieldCheck = (v: unknown) => boolean;

const number = (min: number, max: number, opts: { integer?: boolean; exclusiveMin?: boolean; exclusiveMax?: boolean } = {}): FieldCheck =>
  v => typeof v === 'number' && Number.isFinite(v)
    && (opts.exclusiveMin ? v > min : v >= min)
    && (opts.exclusiveMax ? v < max : v <= max)
    && (!opts.integer || Number.isInteger(v));

const instant: FieldCheck = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

const STAGES = ['core', 'deep', 'rem', 'awake'] as const;
const stages: FieldCheck = v => isRecord(v)
  && Object.keys(v).every(k => (STAGES as readonly string[]).includes(k))
  && Object.values(v).every(m => typeof m === 'number' && Number.isFinite(m) && m >= 0 && m <= 1440);

const sources: FieldCheck = v => isRecord(v) && JSON.stringify(v).length <= MAX_SOURCES_BYTES;

// The handler bounds the brief names; the column CHECKs (phase59) are looser
// on purpose, so a value refused here is a 400 naming the field, not a 500.
const FIELD_CHECK: Record<string, FieldCheck> = {
  sleepMinutes: number(0, 1440, { integer: true }),
  sleepStages: stages,
  sleepStart: instant,
  sleepEnd: instant,
  hrvSdnnMs: number(0, 1000, { exclusiveMin: true, exclusiveMax: true }),
  restingHr: number(20, 250, { integer: true }),
  steps: number(0, 200_000, { integer: true }),
  bodyMassLb: number(0, 1500, { exclusiveMin: true, exclusiveMax: true }),
  bodyMassAt: instant,
  sources,
};

export interface DayPatch {
  date: string;
  /** Column → value; only the fields the day carried. null clears. */
  columns: Record<string, unknown>;
  /** The categories the day's fields need. */
  categories: Set<AppleCategory>;
  /** A weigh-in that may move the profile's body weight. */
  bodyMass: { lb: number; at: string } | null;
}

/** Parse the body's days, naming the first bad field. */
export function parseDays(raw: unknown, todayLocal: string): ServiceResult<DayPatch[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DAYS_PER_POST) {
    return fail(400, `days must be 1–${MAX_DAYS_PER_POST} entries`);
  }
  const earliest = shiftDay(todayLocal, -PAST_DAYS);
  const latest = shiftDay(todayLocal, 1);
  const seen = new Set<string>();
  const out: DayPatch[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return fail(400, 'each day must be an object');
    const date = item.date;
    if (!isDay(date)) return fail(400, 'date must be YYYY-MM-DD');
    if (date < earliest || date > latest) return fail(400, `date ${date} is outside the last ${PAST_DAYS} days`);
    if (seen.has(date)) return fail(400, `date ${date} appears twice`);
    seen.add(date);

    const columns: Record<string, unknown> = {};
    const categories = new Set<AppleCategory>();
    for (const [field, value] of Object.entries(item)) {
      if (field === 'date') continue;
      const check = FIELD_CHECK[field];
      if (!check) return fail(400, `unknown field ${field}`);
      if (value !== null && !check(value)) return fail(400, `${field} on ${date} is out of bounds`);
      columns[COLUMN[field]] = value;
      categories.add(FIELD_CATEGORY[field]);
    }
    if (Object.keys(columns).length === 0) return fail(400, `day ${date} carries no fields`);
    // A weigh-in is a value and the instant it was taken; one without the
    // other cannot be ordered against a manual entry.
    const lb = item.bodyMassLb;
    const at = item.bodyMassAt;
    if ((typeof lb === 'number') !== (typeof at === 'string')) {
      return fail(400, `bodyMassLb and bodyMassAt on ${date} come together`);
    }
    out.push({
      date,
      columns,
      categories,
      bodyMass: typeof lb === 'number' && typeof at === 'string' ? { lb, at: new Date(Date.parse(at)).toISOString() } : null,
    });
  }
  return succeed(out);
}

export interface PostBody {
  provider?: unknown;
  timezone?: unknown;
  days?: unknown;
}

export interface PostOutcome {
  upserted: number;
  /** The profile's new body weight, when a newer Health weigh-in moved it. */
  profileBodyWeightLb?: number;
}

/** A 409 the phone acts on, as JSON. */
export class ConsentError extends Error {
  constructor(readonly body: { error: 'not-connected' } | { error: 'category-off'; category: AppleCategory }) {
    super(body.error);
  }
}

export async function postDailyMetrics(supabase: Admin, userId: string, body: PostBody): Promise<ServiceResult<PostOutcome>> {
  if (body.provider !== 'apple') return fail(400, "provider must be 'apple'");
  if (!isValidTimezone(body.timezone)) return fail(400, 'A valid IANA timezone is required');
  const parsed = parseDays(body.days, localDate(body.timezone));
  if (!parsed.ok) return parsed;

  const connection = await getConnection(supabase, userId, 'apple');
  if (!connection || connection.status !== 'connected') throw new ConsentError({ error: 'not-connected' });
  // Consent per category, checked before anything is written.
  for (const day of parsed.value) {
    for (const category of day.categories) {
      if (connection.categories[category] !== true) throw new ConsentError({ error: 'category-off', category });
    }
  }

  const now = new Date().toISOString();
  // One upsert per day: a batch would give every row the union of the
  // batch's columns and write nulls into the fields a day did not carry.
  for (const day of parsed.value) {
    const { error } = await supabase.from('daily_metrics').upsert({
      user_id: userId,
      date: day.date,
      provider: 'apple',
      ...day.columns,
      updated_at: now,
    }, { onConflict: 'user_id,date,provider' });
    if (error) throw new Error(`daily_metrics upsert failed: ${error.message}`);
  }

  const outcome: PostOutcome = { upserted: parsed.value.length };
  const weighIns = parsed.value.flatMap(d => (d.bodyMass ? [d.bodyMass] : []));
  if (weighIns.length > 0) {
    const newest = weighIns.reduce((a, b) => (b.at > a.at ? b : a));
    const moved = await applyHealthWeight(supabase, userId, newest);
    if (moved !== null) outcome.profileBodyWeightLb = moved;
  }
  return succeed(outcome);
}

/**
 * Body weight never moves backwards: a Health weigh-in writes the profile
 * only when it is newer than the weight already there, whoever set it. One
 * conditional UPDATE, so two writes racing cannot reorder. phase59 stamped
 * every earlier weight 'user' at its row's updated_at, so a NULL stamp means
 * no body weight at all — and a sample then writes. Returns the pounds
 * written, or null when the stored weight was newer.
 */
export async function applyHealthWeight(
  supabase: Admin, userId: string, weighIn: { lb: number; at: string },
): Promise<number | null> {
  const lb = Math.round(weighIn.lb * 100) / 100;
  const { data, error } = await supabase
    .from('profiles')
    .update({ body_weight_lb: lb, body_weight_updated_at: weighIn.at, body_weight_source: 'apple', updated_at: new Date().toISOString() })
    .eq('id', userId)
    .or(`body_weight_updated_at.is.null,body_weight_updated_at.lt.${weighIn.at}`)
    .select('id');
  if (error) throw new Error(`profile body weight update failed: ${error.message}`);
  return (data ?? []).length > 0 ? lb : null;
}

export interface DayOut {
  date: string;
  provider: string;
  sleepMinutes: number | null;
  sleepStages: unknown;
  sleepStart: string | null;
  sleepEnd: string | null;
  hrvSdnnMs: number | null;
  restingHr: number | null;
  steps: number | null;
  bodyMassLb: number | null;
  bodyMassAt: string | null;
  sources: unknown;
  updatedAt: string;
}

/** `GET ?start&end`: the athlete's days, oldest first, ≤ 400 of them. */
export async function readDailyMetrics(
  supabase: Admin, userId: string, query: { start?: unknown; end?: unknown },
): Promise<ServiceResult<{ days: DayOut[] }>> {
  const { start, end } = query;
  if (!isDay(start) || !isDay(end)) return fail(400, 'start and end must be YYYY-MM-DD');
  if (end < start) return fail(400, 'end must be on or after start');
  if ((Date.parse(end) - Date.parse(start)) / 86_400_000 + 1 > MAX_READ_DAYS) {
    return fail(400, `at most ${MAX_READ_DAYS} days per read`);
  }
  const { data, error } = await supabase
    .from('daily_metrics')
    .select('date, provider, sleep_minutes, sleep_stages, sleep_start, sleep_end, hrv_sdnn_ms, resting_hr, steps, body_mass_lb, body_mass_at, sources, updated_at')
    .eq('user_id', userId)
    .gte('date', start)
    .lte('date', end)
    .order('date')
    .order('provider');
  if (error) throw new Error(`daily_metrics read failed: ${error.message}`);
  return succeed({
    days: (data ?? []).map(r => ({
      date: r.date as string,
      provider: r.provider as string,
      sleepMinutes: r.sleep_minutes as number | null,
      sleepStages: r.sleep_stages ?? null,
      sleepStart: r.sleep_start as string | null,
      sleepEnd: r.sleep_end as string | null,
      hrvSdnnMs: r.hrv_sdnn_ms === null ? null : Number(r.hrv_sdnn_ms),
      restingHr: r.resting_hr as number | null,
      steps: r.steps as number | null,
      bodyMassLb: r.body_mass_lb === null ? null : Number(r.body_mass_lb),
      bodyMassAt: r.body_mass_at as string | null,
      sources: r.sources ?? null,
      updatedAt: r.updated_at as string,
    })),
  });
}
