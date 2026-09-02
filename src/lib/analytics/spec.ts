import type { Sport, WorkoutType } from '../../types/workout';
import type { MealType } from '../../types/nutrition';
import type { GradeScale } from '../climbing';

// ─── ChartSpec: the analytics tile contract ──────────────────────────────────
// The serializable spec a saved tile stores (analytics_tiles.spec JSONB), the
// engine computes from, and the analytics coach edits via its reducer tool.
// Everything downstream — fetch windows, bucketing, rendering — derives from
// this object, so the shape is versioned and validated in one place.
//
// Two shape rules are load-bearing:
//   1. Chart-level fields stay flat scalars (or one-level objects) and series
//      entries keep their filters inlined as near-top-level keys — the eval
//      harness's requireToolCall.inputMatches is a shallow comparison, and
//      the coach tool mirrors this shape.
//   2. Deep validation lives HERE (specProblem), not in the API handler —
//      the handler checks only gross shape (the weekly_targets precedent),
//      and the renderer shows an error tile for anything invalid.

export const CHART_SPEC_VERSION = 1;

export type ChartType = 'line' | 'bar' | 'stacked-bar' | 'area' | 'kpi' | 'table';
export type TimeBucket = 'day' | 'week' | 'iso-month' | 'total';
export type Aggregation = 'sum' | 'avg' | 'count' | 'max';
/** Length units the opt-in display conversion understands. */
export type DisplayUnit = 'mi' | 'km' | 'm' | 'ft';

export type RangePreset =
  | 'this-iso-month'
  | 'last-iso-month'
  | 'this-iso-year'
  | 'last-iso-year'
  | 'current-block';

export type DateRange =
  | { kind: 'rolling'; days: number }
  | { kind: 'fixed'; startDate: string; endDateExclusive: string }
  | { kind: 'preset'; preset: RangePreset };

/**
 * Day-level join between a measure and the training calendar: keep (or drop)
 * measure rows whose date is `offsetDays` after a day with a completed
 * session of one of `eventTypes`. offsetDays 0 = "on strength days",
 * 1 = "the day after", -1 = "the day before".
 */
export interface DayFilter {
  eventTypes: WorkoutType[];
  offsetDays: number;
  mode: 'include' | 'exclude';
}

export interface SeriesFilters {
  /** Completion event_type (set/cardio rows resolve via their completion). */
  eventTypes?: WorkoutType[];
  /**
   * Sport buckets (phase 37): the workout's sport column, with climbing
   * event types implying 'climbing'. Rows without a sport are "unspecified"
   * and never match a sports filter.
   */
  sports?: Sport[];
  /**
   * Case-insensitive event-title matches — how 'other' narrows to the
   * specific workouts the user made (the repeated soccer workout).
   */
  workoutTitles?: string[];
  /** Case-insensitive exact exercise_name matches (set/cardio rows). */
  exerciseNames?: string[];
  /** exercise_definitions.category via definition_id (set/cardio rows). */
  categories?: string[];
  mealTypes?: MealType[];
  /** Grade scale for pitch rows; required by max-grade (scales never cross-compare). */
  gradeScale?: GradeScale;
  dayFilter?: DayFilter;
}

export type GroupBy =
  | 'event-type'
  | 'sport'
  | 'exercise'
  | 'category'
  | 'meal-type'
  | 'hr-zone'
  | 'unit';

export interface ChartSeries {
  /** Stable key ('s1', 's2', …) so partial updates can address a series. */
  id: string;
  /** Legend override; when absent the label derives from measure + filters. */
  label?: string;
  measure: MeasureId;
  /** Defaults to the measure's defaultAgg. */
  agg?: Aggregation;
  filters?: SeriesFilters;
  /** Fans this one definition into a rendered series per group value. */
  groupBy?: GroupBy;
  /** Keep the top N groups by aggregate value (default 6). */
  groupLimit?: number;
  /** Defaults to auto: the tile's second unit kind goes right. */
  axis?: 'left' | 'right';
}

export interface ChartSpec {
  version: typeof CHART_SPEC_VERSION;
  title: string;
  chartType: ChartType;
  range: DateRange;
  bucket: TimeBucket;
  /** Opt-in length conversion for this tile; absent = dominant-unit rule. */
  displayUnit?: DisplayUnit;
  series: ChartSeries[];
}

export const MAX_SERIES = 8;

// ─── Measure catalog ─────────────────────────────────────────────────────────
// One entry per measure the engine can compute. `source` picks the row set,
// `unitKind` drives axis assignment (max two kinds per tile) and whether the
// displayUnit conversion applies ('length' only). `aggLevel: 'day'` measures
// (nutrition) pre-sum to day totals before bucket aggregation, so avg means
// "average per logged day", never "average per meal".

export type MeasureSource =
  | 'completions'
  | 'set-logs'
  | 'pitch-logs'
  | 'cardio-logs'
  | 'hr-zones'
  | 'meals';

export type UnitKind =
  | 'length'    // per-unit quantities; the only convertible kind
  | 'minutes'
  | 'count'
  | 'reps'
  | 'weight'    // bare numbers, pounds by app convention
  | 'bpm'
  | 'kcal'
  | 'grams'
  | 'grade';    // parseGrade rank positions; labels carry the raw text

export interface MeasureDef {
  id: MeasureId;
  label: string;
  source: MeasureSource;
  unitKind: UnitKind;
  defaultAgg: Aggregation;
  allowedAggs: readonly Aggregation[];
  allowedGroupBys: readonly GroupBy[];
  /** 'day': pre-sum to per-day totals before bucketing (nutrition). */
  aggLevel: 'row' | 'day';
}

export type MeasureId =
  | 'session-count' | 'training-time'
  | 'set-count' | 'rep-count' | 'tonnage' | 'est-1rm'
  | 'pitches' | 'max-grade'
  | 'distance' | 'elevation-gain' | 'cardio-time' | 'avg-hr'
  | 'hr-zone-time'
  | 'calories' | 'protein' | 'carbs' | 'fat' | 'fiber' | 'sugar' | 'alcohol' | 'meal-count';

const SUM_ONLY = ['sum'] as const;
const SUM_AVG_MAX = ['sum', 'avg', 'max'] as const;
const COUNT_ONLY = ['count'] as const;
const AVG_MAX = ['avg', 'max'] as const;

const LOG_GROUPS = ['event-type', 'exercise', 'category'] as const;
const NO_GROUPS = [] as const;

function measure(def: MeasureDef): MeasureDef {
  return def;
}

export const MEASURES: Record<MeasureId, MeasureDef> = {
  'session-count':  measure({ id: 'session-count',  label: 'Sessions',            source: 'completions', unitKind: 'count',   defaultAgg: 'count', allowedAggs: COUNT_ONLY,  allowedGroupBys: ['event-type', 'sport'], aggLevel: 'row' }),
  'training-time':  measure({ id: 'training-time',  label: 'Training time',       source: 'completions', unitKind: 'minutes', defaultAgg: 'sum',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['event-type', 'sport'], aggLevel: 'row' }),
  'set-count':      measure({ id: 'set-count',      label: 'Sets',                source: 'set-logs',    unitKind: 'count',   defaultAgg: 'count', allowedAggs: COUNT_ONLY,  allowedGroupBys: LOG_GROUPS, aggLevel: 'row' }),
  'rep-count':      measure({ id: 'rep-count',      label: 'Reps',                source: 'set-logs',    unitKind: 'reps',    defaultAgg: 'sum',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: LOG_GROUPS, aggLevel: 'row' }),
  'tonnage':        measure({ id: 'tonnage',        label: 'Tonnage',             source: 'set-logs',    unitKind: 'weight',  defaultAgg: 'sum',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: LOG_GROUPS, aggLevel: 'row' }),
  'est-1rm':        measure({ id: 'est-1rm',        label: 'Est. 1RM',            source: 'set-logs',    unitKind: 'weight',  defaultAgg: 'max',   allowedAggs: AVG_MAX,     allowedGroupBys: ['exercise'], aggLevel: 'row' }),
  'pitches':        measure({ id: 'pitches',        label: 'Pitches',             source: 'pitch-logs',  unitKind: 'count',   defaultAgg: 'count', allowedAggs: COUNT_ONLY,  allowedGroupBys: ['event-type', 'exercise'], aggLevel: 'row' }),
  'max-grade':      measure({ id: 'max-grade',      label: 'Max grade',           source: 'pitch-logs',  unitKind: 'grade',   defaultAgg: 'max',   allowedAggs: ['max'],     allowedGroupBys: NO_GROUPS, aggLevel: 'row' }),
  'distance':       measure({ id: 'distance',       label: 'Distance',            source: 'cardio-logs', unitKind: 'length',  defaultAgg: 'sum',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['event-type', 'sport', 'exercise', 'category', 'unit'], aggLevel: 'row' }),
  'elevation-gain': measure({ id: 'elevation-gain', label: 'Elevation gain',      source: 'cardio-logs', unitKind: 'length',  defaultAgg: 'sum',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['event-type', 'sport', 'exercise', 'category', 'unit'], aggLevel: 'row' }),
  'cardio-time':    measure({ id: 'cardio-time',    label: 'Cardio time',         source: 'cardio-logs', unitKind: 'minutes', defaultAgg: 'sum',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['event-type', 'sport', 'exercise', 'category'], aggLevel: 'row' }),
  'avg-hr':         measure({ id: 'avg-hr',         label: 'Avg heart rate',      source: 'cardio-logs', unitKind: 'bpm',     defaultAgg: 'avg',   allowedAggs: AVG_MAX,     allowedGroupBys: ['event-type', 'sport', 'exercise'], aggLevel: 'row' }),
  'hr-zone-time':   measure({ id: 'hr-zone-time',   label: 'Time in HR zones',    source: 'hr-zones',    unitKind: 'minutes', defaultAgg: 'sum',   allowedAggs: SUM_ONLY,    allowedGroupBys: ['hr-zone', 'sport'], aggLevel: 'row' }),
  'calories':       measure({ id: 'calories',       label: 'Calories eaten',      source: 'meals',       unitKind: 'kcal',    defaultAgg: 'avg',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['meal-type'], aggLevel: 'day' }),
  'protein':        measure({ id: 'protein',        label: 'Protein',             source: 'meals',       unitKind: 'grams',   defaultAgg: 'avg',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['meal-type'], aggLevel: 'day' }),
  'carbs':          measure({ id: 'carbs',          label: 'Carbs',               source: 'meals',       unitKind: 'grams',   defaultAgg: 'avg',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['meal-type'], aggLevel: 'day' }),
  'fat':            measure({ id: 'fat',            label: 'Fat',                 source: 'meals',       unitKind: 'grams',   defaultAgg: 'avg',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['meal-type'], aggLevel: 'day' }),
  'fiber':          measure({ id: 'fiber',          label: 'Fiber',               source: 'meals',       unitKind: 'grams',   defaultAgg: 'avg',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['meal-type'], aggLevel: 'day' }),
  'sugar':          measure({ id: 'sugar',          label: 'Sugar',               source: 'meals',       unitKind: 'grams',   defaultAgg: 'avg',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['meal-type'], aggLevel: 'day' }),
  'alcohol':        measure({ id: 'alcohol',        label: 'Alcohol',             source: 'meals',       unitKind: 'grams',   defaultAgg: 'sum',   allowedAggs: SUM_AVG_MAX, allowedGroupBys: ['meal-type'], aggLevel: 'day' }),
  'meal-count':     measure({ id: 'meal-count',     label: 'Meals logged',        source: 'meals',       unitKind: 'count',   defaultAgg: 'count', allowedAggs: COUNT_ONLY,  allowedGroupBys: ['meal-type'], aggLevel: 'row' }),
};

export const MEASURE_IDS = Object.keys(MEASURES) as MeasureId[];

export const WORKOUT_TYPES: readonly WorkoutType[] = [
  'stretching', 'morning-routine', 'weights', 'climbing', 'outdoor-climbing', 'cardio', 'yoga',
];

const CHART_TYPES: readonly ChartType[] = ['line', 'bar', 'stacked-bar', 'area', 'kpi', 'table'];
const BUCKETS: readonly TimeBucket[] = ['day', 'week', 'iso-month', 'total'];
const DISPLAY_UNITS: readonly DisplayUnit[] = ['mi', 'km', 'm', 'ft'];
const PRESETS: readonly RangePreset[] = ['this-iso-month', 'last-iso-month', 'this-iso-year', 'last-iso-year', 'current-block'];
const GRADE_SCALES: readonly GradeScale[] = ['yds', 'boulder', 'ice', 'mixed'];
const MEAL_TYPE_VALUES: readonly MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_ROLLING_DAYS = 1830; // ~5 years
export const DEFAULT_GROUP_LIMIT = 6;
export const MAX_GROUP_LIMIT = 12;

const isStringArrayOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T[] =>
  Array.isArray(v) && v.every(x => typeof x === 'string' && (allowed as readonly string[]).includes(x));

/**
 * Every violation in one instructive message, or null for a valid spec.
 * Runs on tile save, on rows read back from the DB, and (via the draft
 * reducer) on coach edits — the single deep validator for the shape.
 */
export function specProblem(spec: ChartSpec): string | null {
  const problems: string[] = [];

  if (spec.version !== CHART_SPEC_VERSION) problems.push(`unsupported spec version ${String(spec.version)}`);
  if (typeof spec.title !== 'string' || !spec.title.trim()) problems.push('title is required');
  if (!CHART_TYPES.includes(spec.chartType)) problems.push(`chartType must be one of ${CHART_TYPES.join(', ')}`);
  if (!BUCKETS.includes(spec.bucket)) problems.push(`bucket must be one of ${BUCKETS.join(', ')}`);
  if (spec.displayUnit !== undefined && !DISPLAY_UNITS.includes(spec.displayUnit)) {
    problems.push(`displayUnit must be one of ${DISPLAY_UNITS.join(', ')}`);
  }
  if (spec.chartType === 'kpi' && spec.bucket !== 'total') problems.push('kpi charts use bucket "total"');

  const r = spec.range as DateRange | undefined;
  if (!r || typeof r !== 'object') {
    problems.push('range is required');
  } else if (r.kind === 'rolling') {
    if (!Number.isInteger(r.days) || r.days < 1 || r.days > MAX_ROLLING_DAYS) {
      problems.push(`rolling range needs days in 1-${MAX_ROLLING_DAYS}`);
    }
  } else if (r.kind === 'fixed') {
    if (!DATE_PATTERN.test(r.startDate ?? '') || !DATE_PATTERN.test(r.endDateExclusive ?? '')) {
      problems.push('fixed range needs YYYY-MM-DD startDate and endDateExclusive');
    } else if (r.startDate >= r.endDateExclusive) {
      problems.push('fixed range must start before it ends');
    }
  } else if (r.kind === 'preset') {
    if (!PRESETS.includes(r.preset)) problems.push(`preset must be one of ${PRESETS.join(', ')}`);
  } else {
    problems.push('range.kind must be rolling, fixed, or preset');
  }

  if (!Array.isArray(spec.series) || spec.series.length < 1) {
    problems.push('at least one series is required');
  } else if (spec.series.length > MAX_SERIES) {
    problems.push(`at most ${MAX_SERIES} series`);
  } else {
    const ids = new Set<string>();
    for (const s of spec.series) {
      const tag = s.id && typeof s.id === 'string' ? s.id : '?';
      if (typeof s.id !== 'string' || !s.id.trim()) problems.push('every series needs an id');
      else if (ids.has(s.id)) problems.push(`duplicate series id "${s.id}"`);
      else ids.add(s.id);

      const def = MEASURES[s.measure];
      if (!def) {
        problems.push(`series ${tag}: unknown measure "${String(s.measure)}"`);
        continue;
      }
      if (s.agg !== undefined && !def.allowedAggs.includes(s.agg)) {
        problems.push(`series ${tag}: ${def.id} supports agg ${def.allowedAggs.join('/')}`);
      }
      if (s.groupBy !== undefined && !def.allowedGroupBys.includes(s.groupBy)) {
        problems.push(
          def.allowedGroupBys.length
            ? `series ${tag}: ${def.id} groups by ${def.allowedGroupBys.join('/')}`
            : `series ${tag}: ${def.id} does not support groupBy`,
        );
      }
      if (s.groupLimit !== undefined && (!Number.isInteger(s.groupLimit) || s.groupLimit < 1 || s.groupLimit > MAX_GROUP_LIMIT)) {
        problems.push(`series ${tag}: groupLimit must be an integer in 1-${MAX_GROUP_LIMIT}`);
      }
      if (s.axis !== undefined && s.axis !== 'left' && s.axis !== 'right') {
        problems.push(`series ${tag}: axis must be left or right`);
      }

      const f = s.filters;
      if (f) {
        if (f.eventTypes !== undefined && !isStringArrayOf(f.eventTypes, WORKOUT_TYPES)) {
          problems.push(`series ${tag}: eventTypes must be workout types`);
        }
        if (f.sports !== undefined && !isStringArrayOf(f.sports, SPORTS)) {
          problems.push(`series ${tag}: sports must be from ${SPORTS.join(', ')}`);
        } else if (f.sports?.length) {
          if (def.source === 'meals') {
            problems.push(`series ${tag}: meals have no sport`);
          }
          const blocked = f.sports.filter(sport => !sportCompatible(def.id, sport));
          if (blocked.length) {
            problems.push(`series ${tag}: ${def.label} is incompatible with ${blocked.join(', ')}`);
          }
        }
        if (f.workoutTitles !== undefined && (!Array.isArray(f.workoutTitles) || !f.workoutTitles.every(x => typeof x === 'string'))) {
          problems.push(`series ${tag}: workoutTitles must be strings`);
        }
        if (f.exerciseNames !== undefined && (!Array.isArray(f.exerciseNames) || !f.exerciseNames.every(x => typeof x === 'string'))) {
          problems.push(`series ${tag}: exerciseNames must be strings`);
        }
        if (f.categories !== undefined && (!Array.isArray(f.categories) || !f.categories.every(x => typeof x === 'string'))) {
          problems.push(`series ${tag}: categories must be strings`);
        }
        if (f.mealTypes !== undefined && !isStringArrayOf(f.mealTypes, MEAL_TYPE_VALUES)) {
          problems.push(`series ${tag}: mealTypes must be meal types`);
        }
        if (f.gradeScale !== undefined && !GRADE_SCALES.includes(f.gradeScale)) {
          problems.push(`series ${tag}: gradeScale must be one of ${GRADE_SCALES.join(', ')}`);
        }
        const d = f.dayFilter;
        if (d !== undefined) {
          if (!isStringArrayOf(d.eventTypes, WORKOUT_TYPES) || d.eventTypes.length === 0) {
            problems.push(`series ${tag}: dayFilter needs at least one workout type`);
          }
          if (!Number.isInteger(d.offsetDays) || d.offsetDays < -7 || d.offsetDays > 7) {
            problems.push(`series ${tag}: dayFilter offsetDays must be an integer in -7..7`);
          }
          if (d.mode !== 'include' && d.mode !== 'exclude') {
            problems.push(`series ${tag}: dayFilter mode must be include or exclude`);
          }
        }
      }
      if (def.id === 'max-grade' && !f?.gradeScale) {
        problems.push(`series ${tag}: max-grade needs a gradeScale filter — grades only order within one scale`);
      }
    }

    // Axis math: at most two unit kinds on one chart.
    const kinds = [...new Set(spec.series.map(s => MEASURES[s.measure]?.unitKind).filter(Boolean))];
    if (kinds.length > 2) problems.push(`series mix ${kinds.length} unit kinds (${kinds.join(', ')}) — a tile fits two axes`);
    if (spec.chartType === 'stacked-bar' && kinds.length > 1) problems.push('stacked bars need one unit kind');
  }

  return problems.length ? problems.join('; ') : null;
}

/**
 * Parse untrusted JSONB (a DB row, an import) into a ChartSpec, or null.
 * Version-gated: a future version-2 spec renders an error tile in a version-1
 * client instead of half-working.
 */
export function upgradeSpec(json: unknown): ChartSpec | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const spec = json as ChartSpec;
  return specProblem(spec) === null ? spec : null;
}

export const SPORTS: readonly Sport[] = ['running', 'biking', 'swimming', 'climbing', 'other'];

// ─── Measure ↔ sport compatibility ───────────────────────────────────────────
// Some pairings are nonsense, and the tile builder DIMS the later choice
// rather than letting the combination error (Shane's rule: a prior selection
// constrains what follows). Encoded as blocklists so the default is
// permissive — only pairs that can never mean anything are closed off.

const SPORT_BLOCKLIST: Partial<Record<MeasureId, readonly Sport[]>> = {
  // Climbing sessions have no distance; swims have no elevation gain.
  distance: ['climbing'],
  'elevation-gain': ['climbing', 'swimming'],
  // Pitches and grades exist only on climbs.
  pitches: ['running', 'biking', 'swimming', 'other'],
  'max-grade': ['running', 'biking', 'swimming', 'other'],
};

/** Whether a sport filter value makes sense for a measure. */
export function sportCompatible(measure: MeasureId, sport: Sport): boolean {
  return !(SPORT_BLOCKLIST[measure] ?? []).includes(sport);
}

/** Max day-offset any series' dayFilter reaches — widens the fetch window. */
export function maxDayOffset(specs: ChartSpec[]): number {
  let max = 0;
  for (const spec of specs) {
    for (const s of spec.series ?? []) {
      const off = Math.abs(s.filters?.dayFilter?.offsetDays ?? 0);
      if (off > max) max = off;
    }
  }
  return max;
}

/** Whether any series needs the HR stream reduction (drives the extra fetch). */
export function needsHrZones(specs: ChartSpec[]): boolean {
  return specs.some(spec => (spec.series ?? []).some(s => MEASURES[s.measure]?.source === 'hr-zones'));
}
