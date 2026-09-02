import type { CardioLogRow, CompletionRow, MealRow, SetLogRow, WorkoutSessionRow } from '../../db/types';
import type { AnalyticsInputs, ComputeContext, EventLite, ZoneActivity } from '../engine';
import type { ChartSeries, ChartSpec } from '../spec';

// Row factories in the review stats.test.ts style: terse call sites, full
// row shapes, overridable.

let setCounter = 0;

export function makeSet(
  date: string,
  name: string,
  weight: string | null,
  reps: string | null,
  overrides: Partial<SetLogRow> = {},
): SetLogRow {
  setCounter += 1;
  return {
    event_id: `evt-${date}`,
    event_date: date,
    section: 'exercise',
    exercise_id: name.toLowerCase().replaceAll(' ', '-'),
    exercise_name: name,
    set_number: setCounter,
    planned_weight: null,
    planned_reps: null,
    planned_duration: null,
    actual_weight: weight,
    actual_reps: reps,
    actual_duration: null,
    is_autofilled: false,
    ...overrides,
  };
}

export function makeCardio(
  date: string,
  name: string,
  distance: string | null,
  elevation: string | null,
  overrides: Partial<CardioLogRow> = {},
): CardioLogRow {
  return {
    event_id: `evt-${date}`,
    event_date: date,
    section: 'exercise',
    exercise_id: name.toLowerCase().replaceAll(' ', '-'),
    exercise_name: name,
    duration_minutes: 45,
    distance,
    elevation_gain: elevation,
    avg_heart_rate: null,
    is_autofilled: false,
    ...overrides,
  };
}

export function makeCompletion(date: string, type: string, overrides: Partial<CompletionRow> = {}): CompletionRow {
  return {
    event_id: `evt-${date}-${type}`,
    event_date: date,
    event_type: type,
    event_title: `${type} session`,
    duration_minutes: 60,
    is_completed: true,
    completed_at: `${date}T12:00:00Z`,
    updated_at: `${date}T12:00:00Z`,
    ...overrides,
  };
}

export function makeSession(date: string, eventId: string, seconds: number | null): WorkoutSessionRow {
  return {
    id: `session-${date}-${eventId}`,
    event_id: eventId,
    event_date: date,
    started_at: `${date}T10:00:00Z`,
    finished_at: `${date}T11:00:00Z`,
    total_duration_seconds: seconds,
    coach_summary: null,
    updated_at: `${date}T11:00:00Z`,
    template_id: null,
    score_type: null,
    score_time_seconds: null,
    score_rounds: null,
    score_reps: null,
  };
}

let mealCounter = 0;

export function makeMeal(date: string, overrides: Partial<MealRow> = {}): MealRow {
  mealCounter += 1;
  return {
    id: `meal-${mealCounter}`,
    title: 'Meal',
    date,
    time: null,
    meal_type: null,
    calories: null,
    protein_g: null,
    carbs_g: null,
    fiber_g: null,
    sugar_g: null,
    fat_total_g: null,
    fat_saturated_g: null,
    fat_trans_g: null,
    alcohol_g: null,
    notes: '',
    created_at: `${date}T12:00:00Z`,
    updated_at: `${date}T12:00:00Z`,
    ...overrides,
  };
}

export function makeZoneActivity(
  date: string,
  zoneSeconds: [number, number, number, number, number],
  overrides: Partial<ZoneActivity> = {},
): ZoneActivity {
  return { eventId: `evt-${date}`, eventDate: date, zoneSeconds, ...overrides };
}

/** events-map entry keyed the way completions/logs reference it. */
export function makeEvent(id: string, sport: EventLite['sport'], overrides: Partial<EventLite> = {}): [string, EventLite] {
  return [id, { title: `${sport ?? 'plain'} workout`, type: 'cardio', sport, ...overrides }];
}

export function makeInputs(partial: Partial<AnalyticsInputs> = {}): AnalyticsInputs {
  return {
    completions: [],
    sessions: [],
    setLogs: [],
    cardioLogs: [],
    meals: [],
    zoneActivities: [],
    categories: new Map(),
    events: new Map(),
    ...partial,
  };
}

export function makeCtx(partial: Partial<ComputeContext> = {}): ComputeContext {
  return {
    todayIso: '2026-09-07',
    activeBlock: null,
    hr: { maxHr: null, thresholdHr: null },
    ...partial,
  };
}

/** A one-series spec over a fixed September 2026 window, total-bucketed by default. */
export function makeSpec(series: Partial<ChartSeries> & { measure: ChartSeries['measure'] }, spec: Partial<ChartSpec> = {}): ChartSpec {
  return {
    version: 1,
    title: 'Test tile',
    chartType: 'line',
    range: { kind: 'fixed', startDate: '2026-09-01', endDateExclusive: '2026-10-01' },
    bucket: 'total',
    series: [{ id: 's1', ...series }],
    ...spec,
  };
}
