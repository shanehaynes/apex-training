import type { WorkoutType } from '../../types/workout';
import type { MealType } from '../../types/nutrition';
import type { GradeScale } from '../climbing';
import {
  CHART_SPEC_VERSION,
  MAX_GROUP_LIMIT,
  MAX_ROLLING_DAYS,
  MAX_SERIES,
  MEASURES,
  MEASURE_IDS,
  WORKOUT_TYPES,
  specProblem,
  type Aggregation,
  type ChartSeries,
  type ChartSpec,
  type ChartType,
  type DisplayUnit,
  type GroupBy,
  type MeasureId,
  type RangePreset,
  type SeriesFilters,
  type TimeBucket,
} from './spec';

// ─── The chart draft ─────────────────────────────────────────────────────────
// One plain object holding everything the tile builder edits, with pure
// converters to and from ChartSpec — the src/lib/builder/draft.ts pattern.
// The builder view owns a useState<ChartDraft>; every input writes here, the
// live preview reads specFromDraft, and Save persists — which is also what
// lets the analytics coach fill the form by reducing tool calls onto the
// same object (applyChartDraftUpdate), with the user's Save as the only
// gate. Numeric fields are STRINGS: parseInt-on-change cannot represent an
// empty input, which makes a field impossible to clear. Parsed at use.

export interface SeriesDraft {
  id: string;
  /** '' = derive from measure + group. */
  label: string;
  measure: MeasureId | '';
  /** '' = the measure's default. */
  agg: Aggregation | '';
  eventTypes: WorkoutType[];
  sports: string[];
  exerciseNames: string[];
  categories: string[];
  mealTypes: MealType[];
  gradeScale: GradeScale | '';
  /** Empty = no day filter. */
  dayFilterTypes: WorkoutType[];
  dayFilterOffset: string;
  dayFilterMode: 'include' | 'exclude';
  groupBy: GroupBy | '';
  groupLimit: string;
  axis: 'left' | 'right' | '';
}

export interface ChartDraft {
  title: string;
  chartType: ChartType;
  rangeKind: 'rolling' | 'fixed' | 'preset';
  rollingDays: string;
  startDate: string;
  /** INCLUSIVE in the form (what a person means by "to"); the spec stores exclusive. */
  endDate: string;
  preset: RangePreset;
  bucket: TimeBucket;
  displayUnit: DisplayUnit | '';
  series: SeriesDraft[];
}

export function emptySeriesDraft(id: string): SeriesDraft {
  return {
    id,
    label: '',
    measure: '',
    agg: '',
    eventTypes: [],
    sports: [],
    exerciseNames: [],
    categories: [],
    mealTypes: [],
    gradeScale: '',
    dayFilterTypes: [],
    dayFilterOffset: '0',
    dayFilterMode: 'include',
    groupBy: '',
    groupLimit: '',
    axis: '',
  };
}

export function emptyChartDraft(): ChartDraft {
  return {
    title: '',
    chartType: 'line',
    rangeKind: 'rolling',
    rollingDays: '90',
    startDate: '',
    endDate: '',
    preset: 'this-iso-month',
    bucket: 'week',
    displayUnit: '',
    series: [emptySeriesDraft('s1')],
  };
}

export function nextSeriesId(draft: ChartDraft): string {
  const used = new Set(draft.series.map(s => s.id));
  for (let n = 1; ; n++) {
    const id = `s${n}`;
    if (!used.has(id)) return id;
  }
}

// ─── Draft → spec ────────────────────────────────────────────────────────────

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function addDay(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** First blocking problem in the draft, phrased for a person (and the coach). */
export function chartDraftProblem(draft: ChartDraft): string | null {
  if (draft.rangeKind === 'rolling') {
    const days = Number(draft.rollingDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_ROLLING_DAYS) {
      return `Rolling range needs a day count between 1 and ${MAX_ROLLING_DAYS}.`;
    }
  }
  if (draft.rangeKind === 'fixed') {
    if (!DATE_PATTERN.test(draft.startDate) || !DATE_PATTERN.test(draft.endDate)) {
      return 'Fixed range needs both dates (YYYY-MM-DD).';
    }
    if (draft.startDate > draft.endDate) return 'The range must start before it ends.';
  }
  if (draft.series.length === 0) return 'Add at least one series.';
  if (draft.series.length > MAX_SERIES) return `At most ${MAX_SERIES} series.`;

  for (const s of draft.series) {
    if (!s.measure) return 'Every series needs a measure.';
    const def = MEASURES[s.measure];
    if (s.agg && !def.allowedAggs.includes(s.agg)) {
      return `${def.label} supports ${def.allowedAggs.join('/')} aggregation.`;
    }
    if (s.groupBy && !def.allowedGroupBys.includes(s.groupBy)) {
      return def.allowedGroupBys.length
        ? `${def.label} groups by ${def.allowedGroupBys.join('/')}.`
        : `${def.label} does not support grouping.`;
    }
    if (s.groupLimit.trim()) {
      const limit = Number(s.groupLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_GROUP_LIMIT) {
        return `Group limit must be between 1 and ${MAX_GROUP_LIMIT}.`;
      }
    }
    if (s.dayFilterTypes.length > 0) {
      const off = Number(s.dayFilterOffset || '0');
      if (!Number.isInteger(off) || off < -7 || off > 7) return 'Day-filter offset must be between -7 and 7.';
    }
    if (s.measure === 'max-grade' && !s.gradeScale) {
      return 'Max grade needs a grade scale — grades only order within one scale.';
    }
    if (s.sports.length > 0 && def.source !== 'streams' && def.source !== 'hr-zones') {
      return `${def.label} has no sport dimension — sports live on synced activities.`;
    }
  }

  const kinds = [...new Set(draft.series.filter(s => s.measure).map(s => MEASURES[s.measure as MeasureId].unitKind))];
  if (kinds.length > 2) return `These series mix ${kinds.length} unit kinds — a tile fits two axes.`;
  if (draft.chartType === 'stacked-bar' && kinds.length > 1) return 'Stacked bars need series of one unit kind.';

  return null;
}

/** The spec a valid draft describes; error mirrors chartDraftProblem. */
export function specFromDraft(draft: ChartDraft): { spec: ChartSpec } | { error: string } {
  const problem = chartDraftProblem(draft);
  if (problem) return { error: problem };

  const series: ChartSeries[] = draft.series.map(s => {
    const filters: SeriesFilters = {};
    if (s.eventTypes.length) filters.eventTypes = [...s.eventTypes];
    if (s.sports.length) filters.sports = [...s.sports];
    if (s.exerciseNames.length) filters.exerciseNames = [...s.exerciseNames];
    if (s.categories.length) filters.categories = [...s.categories];
    if (s.mealTypes.length) filters.mealTypes = [...s.mealTypes];
    if (s.gradeScale) filters.gradeScale = s.gradeScale;
    if (s.dayFilterTypes.length) {
      filters.dayFilter = {
        eventTypes: [...s.dayFilterTypes],
        offsetDays: Number(s.dayFilterOffset || '0'),
        mode: s.dayFilterMode,
      };
    }
    return {
      id: s.id,
      ...(s.label.trim() ? { label: s.label.trim() } : {}),
      measure: s.measure as MeasureId,
      ...(s.agg ? { agg: s.agg } : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
      ...(s.groupBy ? { groupBy: s.groupBy } : {}),
      ...(s.groupLimit.trim() ? { groupLimit: Number(s.groupLimit) } : {}),
      ...(s.axis ? { axis: s.axis } : {}),
    };
  });

  const spec: ChartSpec = {
    version: CHART_SPEC_VERSION,
    title: draft.title.trim() || 'Untitled tile',
    chartType: draft.chartType,
    range:
      draft.rangeKind === 'rolling' ? { kind: 'rolling', days: Number(draft.rollingDays) }
      : draft.rangeKind === 'fixed' ? { kind: 'fixed', startDate: draft.startDate, endDateExclusive: addDay(draft.endDate) }
      : { kind: 'preset', preset: draft.preset },
    // A KPI is a single number; the bucket chips disable rather than error.
    bucket: draft.chartType === 'kpi' ? 'total' : draft.bucket,
    ...(draft.displayUnit ? { displayUnit: draft.displayUnit } : {}),
    series,
  };

  const invalid = specProblem(spec);
  return invalid ? { error: invalid } : { spec };
}

export function draftFromSpec(spec: ChartSpec): ChartDraft {
  return {
    title: spec.title,
    chartType: spec.chartType,
    rangeKind: spec.range.kind,
    rollingDays: spec.range.kind === 'rolling' ? String(spec.range.days) : '90',
    startDate: spec.range.kind === 'fixed' ? spec.range.startDate : '',
    endDate: spec.range.kind === 'fixed' ? addDayInverse(spec.range.endDateExclusive) : '',
    preset: spec.range.kind === 'preset' ? spec.range.preset : 'this-iso-month',
    bucket: spec.bucket,
    displayUnit: spec.displayUnit ?? '',
    series: spec.series.map(s => ({
      id: s.id,
      label: s.label ?? '',
      measure: s.measure,
      agg: s.agg ?? '',
      eventTypes: [...(s.filters?.eventTypes ?? [])],
      sports: [...(s.filters?.sports ?? [])],
      exerciseNames: [...(s.filters?.exerciseNames ?? [])],
      categories: [...(s.filters?.categories ?? [])],
      mealTypes: [...(s.filters?.mealTypes ?? [])],
      gradeScale: s.filters?.gradeScale ?? '',
      dayFilterTypes: [...(s.filters?.dayFilter?.eventTypes ?? [])],
      dayFilterOffset: String(s.filters?.dayFilter?.offsetDays ?? 0),
      dayFilterMode: s.filters?.dayFilter?.mode ?? 'include',
      groupBy: s.groupBy ?? '',
      groupLimit: s.groupLimit != null ? String(s.groupLimit) : '',
      axis: s.axis ?? '',
    })),
  };
}

function addDayInverse(endDateExclusive: string): string {
  const d = new Date(`${endDateExclusive}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─── Coach reducer ───────────────────────────────────────────────────────────
// applyChartDraftUpdate is the whole tool surface of the analytics coach
// (the update_workout_draft contract): partial input, per-field guards
// (never a blind spread), all violations collected into ONE instructive
// error that becomes the tool_result verbatim, and a summary of what landed
// so the model knows. Nothing here persists — the user's Save is the gate.

export interface SeriesUpdateInput {
  id?: unknown;
  label?: unknown;
  measure?: unknown;
  agg?: unknown;
  event_types?: unknown;
  sports?: unknown;
  exercise_names?: unknown;
  categories?: unknown;
  meal_types?: unknown;
  grade_scale?: unknown;
  day_filter?: unknown;
  group_by?: unknown;
  group_limit?: unknown;
  axis?: unknown;
}

export interface DraftUpdateInput {
  title?: unknown;
  chart_type?: unknown;
  bucket?: unknown;
  display_unit?: unknown;
  date_range?: unknown;
  series?: unknown;
  remove_series?: unknown;
}

const CHART_TYPE_VALUES: readonly ChartType[] = ['line', 'bar', 'stacked-bar', 'area', 'kpi', 'table'];
const BUCKET_VALUES: readonly TimeBucket[] = ['day', 'week', 'iso-month', 'total'];
const DISPLAY_UNIT_VALUES: readonly DisplayUnit[] = ['mi', 'km', 'm', 'ft'];
const PRESET_VALUES: readonly RangePreset[] = ['this-iso-month', 'last-iso-month', 'this-iso-year', 'last-iso-year', 'current-block'];
const AGG_VALUES: readonly Aggregation[] = ['sum', 'avg', 'count', 'max'];
const GROUP_BY_VALUES: readonly GroupBy[] = ['event-type', 'sport', 'exercise', 'category', 'meal-type', 'hr-zone', 'unit'];
const GRADE_SCALE_VALUES: readonly GradeScale[] = ['yds', 'boulder', 'ice', 'mixed'];
const MEAL_TYPE_VALUES: readonly MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v);

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : null;

const listOf = <T extends string>(v: unknown, allowed: readonly T[]): T[] | null => {
  const list = stringList(v);
  if (!list || !list.every(x => (allowed as readonly string[]).includes(x))) return null;
  return list as T[];
};

export function applyChartDraftUpdate(
  draft: ChartDraft,
  input: DraftUpdateInput,
): { draft: ChartDraft; summary: string } | { error: string } {
  const errors: string[] = [];
  const changed: string[] = [];
  const next: ChartDraft = { ...draft, series: draft.series.map(s => ({ ...s })) };

  if (input.title !== undefined) {
    if (typeof input.title === 'string' && input.title.trim()) {
      next.title = input.title.trim();
      changed.push('title');
    } else errors.push('title must be a non-empty string');
  }

  if (input.chart_type !== undefined) {
    if (oneOf(input.chart_type, CHART_TYPE_VALUES)) {
      next.chartType = input.chart_type;
      changed.push('chart type');
    } else errors.push(`chart_type must be one of ${CHART_TYPE_VALUES.join(', ')}`);
  }

  if (input.bucket !== undefined) {
    if (oneOf(input.bucket, BUCKET_VALUES)) {
      next.bucket = input.bucket;
      changed.push('bucket');
    } else errors.push(`bucket must be one of ${BUCKET_VALUES.join(', ')}`);
  }

  if (input.display_unit !== undefined) {
    if (input.display_unit === null || input.display_unit === '') {
      next.displayUnit = '';
      changed.push('display unit cleared');
    } else if (oneOf(input.display_unit, DISPLAY_UNIT_VALUES)) {
      next.displayUnit = input.display_unit;
      changed.push('display unit');
    } else errors.push(`display_unit must be one of ${DISPLAY_UNIT_VALUES.join(', ')} (or null to clear)`);
  }

  if (input.date_range !== undefined) {
    const r = input.date_range as { kind?: unknown; days?: unknown; start_date?: unknown; end_date?: unknown; preset?: unknown } | null;
    if (r && r.kind === 'rolling' && typeof r.days === 'number' && Number.isInteger(r.days) && r.days >= 1 && r.days <= MAX_ROLLING_DAYS) {
      next.rangeKind = 'rolling';
      next.rollingDays = String(r.days);
      changed.push(`range: last ${r.days} days`);
    } else if (
      r && r.kind === 'fixed' &&
      typeof r.start_date === 'string' && DATE_PATTERN.test(r.start_date) &&
      typeof r.end_date === 'string' && DATE_PATTERN.test(r.end_date) &&
      r.start_date <= r.end_date
    ) {
      next.rangeKind = 'fixed';
      next.startDate = r.start_date;
      next.endDate = r.end_date;
      changed.push(`range: ${r.start_date} to ${r.end_date}`);
    } else if (r && r.kind === 'preset' && oneOf(r.preset, PRESET_VALUES)) {
      next.rangeKind = 'preset';
      next.preset = r.preset;
      changed.push(`range: ${r.preset}`);
    } else {
      errors.push(
        'date_range must be {kind:"rolling", days} (1-' + MAX_ROLLING_DAYS + '), ' +
        '{kind:"fixed", start_date, end_date} (YYYY-MM-DD, start <= end, end inclusive), or ' +
        `{kind:"preset", preset: ${PRESET_VALUES.join('|')}}`,
      );
    }
  }

  if (input.remove_series !== undefined) {
    const ids = stringList(input.remove_series);
    if (!ids) {
      errors.push('remove_series must be an array of series ids');
    } else {
      const missing = ids.filter(id => !next.series.some(s => s.id === id));
      if (missing.length) errors.push(`remove_series: no series ${missing.join(', ')}`);
      else {
        next.series = next.series.filter(s => !ids.includes(s.id));
        changed.push(`removed ${ids.join(', ')}`);
      }
    }
  }

  if (input.series !== undefined) {
    if (!Array.isArray(input.series)) {
      errors.push('series must be an array');
    } else {
      for (const raw of input.series as SeriesUpdateInput[]) {
        const result = applySeriesUpdate(next, raw);
        if ('error' in result) errors.push(result.error);
        else changed.push(result.summary);
      }
    }
  }

  if (errors.length) return { error: `Nothing applied. Fix and retry: ${errors.join('; ')}.` };
  if (!changed.length) return { error: 'Nothing recognized in the update — pass at least one field.' };

  // Structural sanity on the result so the model hears about a broken
  // combination immediately (mixed unit kinds, missing grade scale, …).
  const problem = chartDraftProblem(next);
  const note = problem ? ` Draft still needs attention: ${problem}` : '';
  return { draft: next, summary: `Chart draft updated: ${changed.join(', ')}. The user reviews and presses Save.${note}` };
}

function applySeriesUpdate(
  next: ChartDraft,
  raw: SeriesUpdateInput,
): { summary: string } | { error: string } {
  if (raw === null || typeof raw !== 'object') return { error: 'each series entry must be an object' };

  let target: SeriesDraft;
  let created = false;
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !raw.id.trim()) return { error: 'series id must be a string' };
    const found = next.series.find(s => s.id === raw.id);
    if (found) {
      target = found;
    } else {
      if (next.series.length >= MAX_SERIES) return { error: `at most ${MAX_SERIES} series` };
      target = emptySeriesDraft(raw.id);
      next.series.push(target);
      created = true;
    }
  } else {
    if (next.series.length >= MAX_SERIES) return { error: `at most ${MAX_SERIES} series` };
    target = emptySeriesDraft(nextSeriesId(next));
    next.series.push(target);
    created = true;
  }

  const errors: string[] = [];

  if (raw.measure !== undefined) {
    if (oneOf(raw.measure, MEASURE_IDS)) target.measure = raw.measure;
    else errors.push(`measure must be one of ${MEASURE_IDS.join(', ')}`);
  }
  if (created && !target.measure) errors.push('a new series needs a measure');

  if (raw.label !== undefined) {
    if (typeof raw.label === 'string') target.label = raw.label.trim();
    else errors.push('label must be a string');
  }
  if (raw.agg !== undefined) {
    if (raw.agg === null || raw.agg === '') target.agg = '';
    else if (oneOf(raw.agg, AGG_VALUES)) target.agg = raw.agg;
    else errors.push(`agg must be one of ${AGG_VALUES.join(', ')}`);
  }
  if (raw.group_by !== undefined) {
    if (raw.group_by === null || raw.group_by === '') target.groupBy = '';
    else if (oneOf(raw.group_by, GROUP_BY_VALUES)) target.groupBy = raw.group_by;
    else errors.push(`group_by must be one of ${GROUP_BY_VALUES.join(', ')}`);
  }
  if (raw.group_limit !== undefined) {
    if (raw.group_limit === null) target.groupLimit = '';
    else if (typeof raw.group_limit === 'number' && Number.isInteger(raw.group_limit) && raw.group_limit >= 1 && raw.group_limit <= MAX_GROUP_LIMIT) {
      target.groupLimit = String(raw.group_limit);
    } else errors.push(`group_limit must be an integer in 1-${MAX_GROUP_LIMIT} (or null to clear)`);
  }
  if (raw.axis !== undefined) {
    if (raw.axis === null || raw.axis === '') target.axis = '';
    else if (raw.axis === 'left' || raw.axis === 'right') target.axis = raw.axis;
    else errors.push('axis must be left or right (or null for auto)');
  }
  if (raw.event_types !== undefined) {
    const list = listOf(raw.event_types, WORKOUT_TYPES);
    if (list) target.eventTypes = list;
    else errors.push(`event_types must be workout types (${WORKOUT_TYPES.join(', ')})`);
  }
  if (raw.sports !== undefined) {
    const list = stringList(raw.sports);
    if (list) target.sports = list;
    else errors.push('sports must be an array of strings');
  }
  if (raw.exercise_names !== undefined) {
    const list = stringList(raw.exercise_names);
    if (list) target.exerciseNames = list;
    else errors.push('exercise_names must be an array of strings');
  }
  if (raw.categories !== undefined) {
    const list = stringList(raw.categories);
    if (list) target.categories = list;
    else errors.push('categories must be an array of strings');
  }
  if (raw.meal_types !== undefined) {
    const list = listOf(raw.meal_types, MEAL_TYPE_VALUES);
    if (list) target.mealTypes = list;
    else errors.push(`meal_types must be meal types (${MEAL_TYPE_VALUES.join(', ')})`);
  }
  if (raw.grade_scale !== undefined) {
    if (raw.grade_scale === null || raw.grade_scale === '') target.gradeScale = '';
    else if (oneOf(raw.grade_scale, GRADE_SCALE_VALUES)) target.gradeScale = raw.grade_scale;
    else errors.push(`grade_scale must be one of ${GRADE_SCALE_VALUES.join(', ')}`);
  }
  if (raw.day_filter !== undefined) {
    const d = raw.day_filter as { event_types?: unknown; offset_days?: unknown; mode?: unknown; off?: unknown } | null;
    if (d === null || d?.off === true) {
      target.dayFilterTypes = [];
      target.dayFilterOffset = '0';
      target.dayFilterMode = 'include';
    } else if (d && typeof d === 'object') {
      const types = listOf(d.event_types, WORKOUT_TYPES);
      const offset = d.offset_days === undefined ? 0 : d.offset_days;
      const mode = d.mode === undefined ? 'include' : d.mode;
      if (
        types && types.length > 0 &&
        typeof offset === 'number' && Number.isInteger(offset) && offset >= -7 && offset <= 7 &&
        (mode === 'include' || mode === 'exclude')
      ) {
        target.dayFilterTypes = types;
        target.dayFilterOffset = String(offset);
        target.dayFilterMode = mode;
      } else {
        errors.push('day_filter needs event_types (workout types), optional offset_days (-7..7), optional mode include|exclude — or {off: true} to clear');
      }
    } else {
      errors.push('day_filter must be an object or null');
    }
  }

  if (errors.length) {
    // A half-configured appended series must not survive a failed update.
    if (created) next.series = next.series.filter(s => s !== target);
    return { error: `series ${target.id}: ${errors.join('; ')}` };
  }
  return { summary: created ? `added series ${target.id}` : `updated series ${target.id}` };
}

// ─── Draft → prompt text ─────────────────────────────────────────────────────
// Compact serialization for the analytics coach prompt (the describeDraft
// pattern): the prompt builder wraps and sanitizes it — this module stays
// out of the prompt's import graph.

export function describeChartDraft(draft: ChartDraft): string {
  const lines: string[] = [];
  lines.push(`Title: ${draft.title || '(untitled)'}`);
  lines.push(`Chart: ${draft.chartType} · bucket ${draft.chartType === 'kpi' ? 'total' : draft.bucket}`);
  const range =
    draft.rangeKind === 'rolling' ? `last ${draft.rollingDays} days`
    : draft.rangeKind === 'fixed' ? `${draft.startDate || '?'} to ${draft.endDate || '?'} (inclusive)`
    : draft.preset;
  lines.push(`Range: ${range}`);
  if (draft.displayUnit) lines.push(`Display unit: ${draft.displayUnit}`);
  if (draft.series.length === 0) {
    lines.push('Series: none yet');
  }
  for (const s of draft.series) {
    const parts: string[] = [];
    parts.push(s.measure || '(no measure)');
    if (s.agg) parts.push(`agg ${s.agg}`);
    if (s.label) parts.push(`label "${s.label}"`);
    if (s.eventTypes.length) parts.push(`types ${s.eventTypes.join('/')}`);
    if (s.sports.length) parts.push(`sports ${s.sports.join('/')}`);
    if (s.exerciseNames.length) parts.push(`exercises ${s.exerciseNames.join('/')}`);
    if (s.categories.length) parts.push(`categories ${s.categories.join('/')}`);
    if (s.mealTypes.length) parts.push(`meals ${s.mealTypes.join('/')}`);
    if (s.gradeScale) parts.push(`scale ${s.gradeScale}`);
    if (s.dayFilterTypes.length) {
      parts.push(`${s.dayFilterMode} days: ${s.dayFilterTypes.join('/')} offset ${s.dayFilterOffset}`);
    }
    if (s.groupBy) parts.push(`by ${s.groupBy}${s.groupLimit ? ` (top ${s.groupLimit})` : ''}`);
    if (s.axis) parts.push(`${s.axis} axis`);
    lines.push(`Series ${s.id}: ${parts.join(' · ')}`);
  }
  const problem = chartDraftProblem(draft);
  if (problem) lines.push(`Blocking problem: ${problem}`);
  return lines.join('\n');
}
