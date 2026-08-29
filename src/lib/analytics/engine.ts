import type { CardioLogRow, CompletionRow, MealRow, SetLogRow, WorkoutSessionRow } from '../db/types';
import { classifySet, parseQuantity } from '../tracking/records';
import { durationMinutesFor, minutesForBareDuration, sessionSecondsMap } from '../review/stats';
import { parseGrade } from '../climbing';
import { mealCalories, rowToMeal } from '../nutrition/mapping';
import type { Meal } from '../../types/nutrition';
import {
  MEASURES,
  DEFAULT_GROUP_LIMIT,
  specProblem,
  type Aggregation,
  type ChartSeries,
  type ChartSpec,
  type UnitKind,
} from './spec';
import { resolveRange, inRange, type ResolvedRange } from './window';
import { bucketsFor, bucketOf, type Bucket } from './buckets';
import { resolveUnits, type QuantityEntry } from './units';
import { shiftedDaySet, passesDayFilter } from './dayFilter';
import { ZONE_LABELS, zoneBounds, type HrSettings } from './hrZones';
import type { Period } from '../review/isoMonth';

// ─── The aggregation engine ──────────────────────────────────────────────────
// computeTile: (spec, fetched rows, settings) → chart-ready series. Pure and
// deterministic — every number a tile shows is computed here, the renderer
// only draws and the coach only edits the spec (the review-stats doctrine).
//
// The engine re-filters is_autofilled / is_completed defensively even though
// fetch.ts already excludes them at the query: correctness must not depend
// on who fetched the inputs (tests and the builder preview construct them
// directly).

/** One synced activity, normalized from activity_streams by fetch.ts. */
export interface StreamActivity {
  eventId: string;
  eventDate: string;
  /** summary.sportLabel; '' when the provider gave none. */
  sportLabel: string;
  distanceMeters: number | null;
  elevationGainMeters: number | null;
  durationSec: number | null;
  calories: number | null;
  avgHr: number | null;
  /** Reduced from streams.hr at fetch; null = no stream or zones unset. */
  zoneSeconds: [number, number, number, number, number] | null;
}

export interface AnalyticsInputs {
  completions: CompletionRow[];
  sessions: WorkoutSessionRow[];
  setLogs: SetLogRow[];
  cardioLogs: CardioLogRow[];
  meals: MealRow[];
  streams: StreamActivity[];
  /** exercise_definitions id → category (identifies pitch rows). */
  categories: Map<string, string>;
}

export interface ComputeContext {
  /** 'YYYY-MM-DD' — the engine never reads the clock. */
  todayIso: string;
  /** The active training block's window, for the current-block preset. */
  activeBlock: Period | null;
  hr: HrSettings;
}

export interface RenderedSeries {
  key: string;
  label: string;
  unitKind: UnitKind;
  /** Display unit: 'mi'/'km'/'m'/'ft' for length, 'min', 'lb', 'bpm', 'kcal', 'g', 'reps', or ''. */
  unit: string;
  axis: 'left' | 'right';
  /** Aligned to buckets; null = no data in a bucket (avg/max/grade only — sums zero-fill). */
  points: (number | null)[];
  /** max-grade only: the grade text behind each bucket's rank. */
  gradeLabels?: (string | null)[];
}

export interface TileData {
  buckets: Bucket[];
  series: RenderedSeries[];
  excluded: { otherUnit: number; unparseable: number };
  rangeLabel: string;
}

export type TileResult = { ok: true; data: TileData } | { ok: false; problem: string };

const FIXED_UNIT: Partial<Record<UnitKind, string>> = {
  minutes: 'min',
  weight: 'lb',
  bpm: 'bpm',
  kcal: 'kcal',
  grams: 'g',
  reps: 'reps',
  count: '',
  grade: '',
};

/** One extracted data point, pre-bucketing. */
interface Point {
  date: string;
  /** Numeric value for non-length measures; null only via quantity resolution. */
  value: number;
  /** Length measures carry the parsed quantity instead (unit-resolved per rendered series). */
  quantity?: QuantityEntry | null;
  /** avg weighting (synced-avg-hr weights by activity duration). */
  weight?: number;
  group: string;
  gradeLabel?: string;
}

const completionKey = (eventId: string, eventDate: string) => `${eventId}|${eventDate}`;

export function computeTile(spec: ChartSpec, inputs: AnalyticsInputs, ctx: ComputeContext): TileResult {
  const invalid = specProblem(spec);
  if (invalid) return { ok: false, problem: invalid };

  const range = resolveRange(spec.range, ctx.todayIso, ctx.activeBlock);
  if (!range) return { ok: false, problem: 'No active training block for the current-block range — pick another range or start a block.' };

  const buckets = bucketsFor(range, spec.bucket);
  if (!buckets) return { ok: false, problem: 'Too many buckets for this range — use week or training-month bucketing.' };

  const usesZones = spec.series.some(s => MEASURES[s.measure].source === 'hr-zones');
  if (usesZones && zoneBounds(ctx.hr) === null) {
    return { ok: false, problem: 'HR zones need a threshold or max heart rate — set one in your profile.' };
  }

  const shared = buildShared(inputs);
  const excluded = { otherUnit: 0, unparseable: 0 };
  const series: RenderedSeries[] = [];

  // Axis by unit kind: first kind left, second right; explicit axis wins.
  const kindOrder: UnitKind[] = [];
  for (const s of spec.series) {
    const kind = MEASURES[s.measure].unitKind;
    if (!kindOrder.includes(kind)) kindOrder.push(kind);
  }
  const axisFor = (s: ChartSeries): 'left' | 'right' =>
    s.axis ?? (kindOrder.indexOf(MEASURES[s.measure].unitKind) === 1 ? 'right' : 'left');

  for (const s of spec.series) {
    const points = extractPoints(s, inputs, shared, range, excluded);
    const groups = fanOut(s, points);

    for (const [group, groupPoints] of groups) {
      const rendered = renderSeries(spec, s, group, groupPoints, buckets, groups.size, excluded);
      rendered.axis = axisFor(s);
      series.push(rendered);
    }
  }

  return { ok: true, data: { buckets, series, excluded, rangeLabel: range.label } };
}

// ─── Shared lookups ──────────────────────────────────────────────────────────

interface SharedLookups {
  /** event_id|event_date → completion event_type (set/cardio/stream rows resolve through this). */
  eventTypeOf: Map<string, string>;
  sessionSeconds: Map<string, number>;
}

function buildShared(inputs: AnalyticsInputs): SharedLookups {
  const eventTypeOf = new Map<string, string>();
  for (const c of inputs.completions) {
    if (c.is_completed) eventTypeOf.set(completionKey(c.event_id, c.event_date), c.event_type);
  }
  return { eventTypeOf, sessionSeconds: sessionSecondsMap(inputs.sessions) };
}

// ─── Point extraction ────────────────────────────────────────────────────────

function extractPoints(
  s: ChartSeries,
  inputs: AnalyticsInputs,
  shared: SharedLookups,
  range: ResolvedRange,
  excluded: { otherUnit: number; unparseable: number },
): Point[] {
  const def = MEASURES[s.measure];
  const f = s.filters ?? {};
  const dayFilterDays = f.dayFilter ? shiftedDaySet(inputs.completions, f.dayFilter) : null;

  const keepDate = (date: string): boolean =>
    inRange(date, range) &&
    (!dayFilterDays || passesDayFilter(date, dayFilterDays, f.dayFilter!.mode));

  const typeSet = f.eventTypes?.length ? new Set<string>(f.eventTypes) : null;
  const nameSet = f.exerciseNames?.length ? new Set(f.exerciseNames.map(n => n.trim().toLowerCase())) : null;
  const categorySet = f.categories?.length ? new Set(f.categories) : null;
  const sportSet = f.sports?.length ? new Set(f.sports.map(x => x.toLowerCase())) : null;
  const mealTypeSet = f.mealTypes?.length ? new Set<string>(f.mealTypes) : null;

  const logRowPasses = (row: { event_id: string; event_date: string; exercise_name: string; definition_id?: string | null }): boolean => {
    if (typeSet) {
      const type = shared.eventTypeOf.get(completionKey(row.event_id, row.event_date));
      // No completion → the event type is unknowable; a type filter drops it.
      if (!type || !typeSet.has(type)) return false;
    }
    if (nameSet && !nameSet.has(row.exercise_name.trim().toLowerCase())) return false;
    if (categorySet) {
      const category = row.definition_id ? inputs.categories.get(row.definition_id) : undefined;
      if (!category || !categorySet.has(category)) return false;
    }
    return true;
  };

  const categoryOf = (row: { definition_id?: string | null }): string =>
    (row.definition_id && inputs.categories.get(row.definition_id)) || 'uncategorized';

  const groupFor = {
    logRow: (row: SetLogRow | CardioLogRow): string => {
      switch (s.groupBy) {
        case 'event-type': return shared.eventTypeOf.get(completionKey(row.event_id, row.event_date)) ?? 'unknown';
        case 'exercise': return row.exercise_name;
        case 'category': return categoryOf(row);
        default: return '';
      }
    },
  };

  const points: Point[] = [];

  switch (def.source) {
    case 'completions': {
      for (const c of inputs.completions) {
        if (!c.is_completed || !keepDate(c.event_date)) continue;
        if (typeSet && !typeSet.has(c.event_type)) continue;
        const group = s.groupBy === 'event-type' ? c.event_type : '';
        if (s.measure === 'session-count') {
          points.push({ date: c.event_date, value: 1, group });
        } else {
          points.push({ date: c.event_date, value: durationMinutesFor(c, shared.sessionSeconds), group });
        }
      }
      break;
    }

    case 'set-logs': {
      for (const row of inputs.setLogs) {
        if (row.is_autofilled || !keepDate(row.event_date) || !logRowPasses(row)) continue;
        const group = groupFor.logRow(row);
        if (s.measure === 'set-count') {
          points.push({ date: row.event_date, value: 1, group });
          continue;
        }
        const set = classifySet(row.actual_weight, row.actual_reps, minutesForBareDuration(row.actual_duration));
        if (!set) continue;
        if (s.measure === 'rep-count') {
          if (set.kind === 'oneRM' || set.kind === 'reps') points.push({ date: row.event_date, value: set.reps, group });
        } else if (s.measure === 'tonnage') {
          if (set.kind === 'oneRM') points.push({ date: row.event_date, value: set.weight * set.reps, group });
        } else if (s.measure === 'est-1rm') {
          if (set.kind === 'oneRM') points.push({ date: row.event_date, value: set.oneRM, group });
        }
      }
      break;
    }

    case 'pitch-logs': {
      // A pitch is a set-log row whose definition is category 'climbing'
      // (grade text rides in actual_weight); rows without a definition fall
      // back to the completion's climbing event types.
      for (const row of inputs.setLogs) {
        if (row.is_autofilled || !keepDate(row.event_date) || !logRowPasses(row)) continue;
        const category = row.definition_id ? inputs.categories.get(row.definition_id) : undefined;
        const isPitch = category === 'climbing' ||
          (category === undefined && isClimbingEvent(shared.eventTypeOf.get(completionKey(row.event_id, row.event_date))));
        if (!isPitch) continue;

        const grade = parseGrade(row.actual_weight ?? undefined);
        if (f.gradeScale && grade?.scale !== f.gradeScale) continue;

        const group = groupFor.logRow(row);
        if (s.measure === 'pitches') {
          points.push({ date: row.event_date, value: 1, group });
        } else {
          // max-grade
          if (!grade) {
            if (row.actual_weight?.trim()) excluded.unparseable += 1;
            continue;
          }
          points.push({ date: row.event_date, value: grade.rank, group, gradeLabel: row.actual_weight!.trim() });
        }
      }
      break;
    }

    case 'cardio-logs': {
      for (const row of inputs.cardioLogs) {
        if (row.is_autofilled || !keepDate(row.event_date) || !logRowPasses(row)) continue;
        const group = groupFor.logRow(row);
        if (s.measure === 'cardio-time') {
          if (row.duration_minutes != null) points.push({ date: row.event_date, value: row.duration_minutes, group });
        } else if (s.measure === 'avg-hr') {
          if (row.avg_heart_rate != null) points.push({ date: row.event_date, value: row.avg_heart_rate, group });
        } else {
          const raw = s.measure === 'distance' ? row.distance : row.elevation_gain;
          if (!raw?.trim()) continue; // no entry ≠ unparseable entry
          const quantity = parseQuantity(raw);
          const unitGroup = s.groupBy === 'unit' ? (quantity ? quantity.unit || 'unitless' : 'unparseable') : group;
          points.push({ date: row.event_date, value: quantity?.value ?? 0, quantity, group: unitGroup });
        }
      }
      break;
    }

    case 'streams': {
      for (const a of inputs.streams) {
        if (!keepDate(a.eventDate)) continue;
        if (sportSet && !sportSet.has(a.sportLabel.toLowerCase())) continue;
        if (typeSet) {
          const type = shared.eventTypeOf.get(completionKey(a.eventId, a.eventDate));
          if (!type || !typeSet.has(type)) continue;
        }
        const group = s.groupBy === 'sport' ? (a.sportLabel || 'Unknown') : '';
        if (s.measure === 'synced-distance' && a.distanceMeters != null) {
          points.push({ date: a.eventDate, value: a.distanceMeters, quantity: { value: a.distanceMeters, unit: 'm' }, group });
        } else if (s.measure === 'synced-elevation' && a.elevationGainMeters != null) {
          points.push({ date: a.eventDate, value: a.elevationGainMeters, quantity: { value: a.elevationGainMeters, unit: 'm' }, group });
        } else if (s.measure === 'synced-time' && a.durationSec != null) {
          points.push({ date: a.eventDate, value: a.durationSec / 60, group });
        } else if (s.measure === 'synced-calories' && a.calories != null) {
          points.push({ date: a.eventDate, value: a.calories, group });
        } else if (s.measure === 'synced-avg-hr' && a.avgHr != null) {
          points.push({ date: a.eventDate, value: a.avgHr, weight: a.durationSec ?? 1, group });
        }
      }
      break;
    }

    case 'hr-zones': {
      // Defaults to fanning by zone — "time in HR zones" with no groupBy
      // would otherwise collapse to plain active time.
      const byZone = s.groupBy !== 'sport';
      for (const a of inputs.streams) {
        if (!a.zoneSeconds || !keepDate(a.eventDate)) continue;
        if (sportSet && !sportSet.has(a.sportLabel.toLowerCase())) continue;
        a.zoneSeconds.forEach((seconds, zone) => {
          if (seconds <= 0) return;
          points.push({
            date: a.eventDate,
            value: seconds / 60,
            group: byZone ? ZONE_LABELS[zone] : (a.sportLabel || 'Unknown'),
          });
        });
      }
      break;
    }

    case 'meals': {
      for (const row of inputs.meals) {
        if (!keepDate(row.date)) continue;
        if (mealTypeSet && (!row.meal_type || !mealTypeSet.has(row.meal_type))) continue;
        const group = s.groupBy === 'meal-type' ? (row.meal_type ?? 'unspecified') : '';
        if (s.measure === 'meal-count') {
          points.push({ date: row.date, value: 1, group });
          continue;
        }
        const value = mealValue(rowToMeal(row), s.measure);
        if (value != null) points.push({ date: row.date, value, group });
      }
      break;
    }
  }

  return points;
}

function isClimbingEvent(type: string | undefined): boolean {
  return type === 'climbing' || type === 'outdoor-climbing';
}

function mealValue(meal: Meal, measure: string): number | null {
  switch (measure) {
    case 'calories': return mealCalories(meal);
    case 'protein': return meal.proteinG ?? null;
    case 'carbs': return meal.carbsG ?? null;
    case 'fat': return meal.fatTotalG ?? null;
    case 'fiber': return meal.fiberG ?? null;
    case 'sugar': return meal.sugarG ?? null;
    case 'alcohol': return meal.alcoholG ?? null;
    default: return null;
  }
}

// ─── Grouping ────────────────────────────────────────────────────────────────

/** Fan points into rendered groups, keeping the top groupLimit by total. */
function fanOut(s: ChartSeries, points: Point[]): Map<string, Point[]> {
  const groups = new Map<string, Point[]>();
  for (const p of points) {
    const list = groups.get(p.group);
    if (list) list.push(p);
    else groups.set(p.group, [p]);
  }
  if (!s.groupBy) return groups.size ? groups : new Map([['', []]]);

  const limit = s.groupLimit ?? DEFAULT_GROUP_LIMIT;
  if (groups.size <= limit) return sortGroups(groups);

  const ranked = [...groups.entries()]
    .map(([key, pts]) => ({ key, pts, total: pts.reduce((sum, p) => sum + (p.quantity?.value ?? p.value), 0) }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
    .slice(0, limit);
  return sortGroups(new Map(ranked.map(r => [r.key, r.pts])));
}

function sortGroups(groups: Map<string, Point[]>): Map<string, Point[]> {
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

// ─── Bucketing + aggregation ─────────────────────────────────────────────────

function renderSeries(
  spec: ChartSpec,
  s: ChartSeries,
  group: string,
  points: Point[],
  buckets: Bucket[],
  groupCount: number,
  excluded: { otherUnit: number; unparseable: number },
): RenderedSeries {
  const def = MEASURES[s.measure];
  const agg = s.agg ?? def.defaultAgg;

  let unit = FIXED_UNIT[def.unitKind] ?? '';
  let usable = points;

  if (def.unitKind === 'length' && s.groupBy !== 'unit') {
    const resolution = resolveUnits(points.map(p => p.quantity ?? null), spec.displayUnit);
    excluded.otherUnit += resolution.excludedOtherUnit;
    excluded.unparseable += resolution.excludedUnparseable;
    unit = resolution.unit;
    let k = 0;
    usable = points
      .filter((_, i) => resolution.keptMask[i])
      .map(p => ({ ...p, value: resolution.kept[k++] }));
  } else if (def.unitKind === 'length') {
    // groupBy 'unit': each group IS one unit, so values pass through raw.
    unit = group === 'unitless' || group === 'unparseable' ? '' : group;
    usable = points.filter(p => group === 'unparseable' ? p.quantity === null : p.quantity !== null);
  }

  // Nutrition measures pre-sum to day totals so avg reads "per logged day".
  if (def.aggLevel === 'day' && s.measure !== 'meal-count') {
    const byDay = new Map<string, number>();
    for (const p of usable) byDay.set(p.date, (byDay.get(p.date) ?? 0) + p.value);
    usable = [...byDay.entries()].map(([date, value]) => ({ date, value, group }));
  }

  const perBucket = new Map<string, Point[]>();
  for (const p of usable) {
    const key = bucketOf(p.date, spec.bucket);
    const list = perBucket.get(key);
    if (list) list.push(p);
    else perBucket.set(key, [p]);
  }

  const zeroFills = agg === 'sum' || agg === 'count';
  const pointsOut: (number | null)[] = [];
  const gradeLabels: (string | null)[] = [];

  for (const b of buckets) {
    const inBucket = perBucket.get(b.key) ?? [];
    if (inBucket.length === 0) {
      pointsOut.push(zeroFills ? 0 : null);
      gradeLabels.push(null);
      continue;
    }
    pointsOut.push(aggregate(inBucket, agg));
    if (def.unitKind === 'grade') {
      const best = inBucket.reduce((a, p) => (p.value > a.value ? p : a));
      gradeLabels.push(best.gradeLabel ?? null);
    } else {
      gradeLabels.push(null);
    }
  }

  const base = s.label?.trim() || def.label;
  const label = group === '' ? base : groupCount > 1 && !s.label ? group : `${base} · ${group}`;

  return {
    key: group === '' ? s.id : `${s.id}:${group}`,
    label,
    unitKind: def.unitKind,
    unit,
    axis: 'left',
    points: pointsOut,
    ...(def.unitKind === 'grade' ? { gradeLabels } : {}),
  };
}

function aggregate(points: Point[], agg: Aggregation): number {
  switch (agg) {
    case 'count':
      return points.length;
    case 'sum':
      return points.reduce((sum, p) => sum + p.value, 0);
    case 'max':
      return points.reduce((max, p) => Math.max(max, p.value), -Infinity);
    case 'avg': {
      let weighted = 0;
      let weights = 0;
      for (const p of points) {
        const w = p.weight ?? 1;
        weighted += p.value * w;
        weights += w;
      }
      return weights > 0 ? weighted / weights : 0;
    }
  }
}
