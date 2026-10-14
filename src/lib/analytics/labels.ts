import type { ChartType, DisplayUnit, GroupBy, MeasureId, RangePreset, TimeBucket } from './spec';
import type { Sport } from '../../types/workout';
import type { MealType } from '../../types/nutrition';
import type { GradeScale } from '../climbing';

// The tile builder's option labels, out of the component so they have one
// definition the iOS catalog generator can load (ios/scripts/gen-analytics-
// catalog.mjs imports this module under Node's native type stripping — keep
// every import here `import type`, and keep the values plain literals).
// TileBuilder.tsx renders these; the Swift builder renders the generated copy.

export const CHART_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: 'line', label: 'Line' },
  { value: 'bar', label: 'Bar' },
  { value: 'stacked-bar', label: 'Stacked' },
  { value: 'area', label: 'Area' },
  { value: 'kpi', label: 'Stat' },
  { value: 'table', label: 'Table' },
];

export const BUCKETS: Array<{ value: TimeBucket; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'iso-month', label: 'Training month' },
  { value: 'total', label: 'Total' },
];

export const RANGE_KINDS: Array<{ value: 'rolling' | 'preset' | 'fixed'; label: string }> = [
  { value: 'rolling', label: 'Rolling' },
  { value: 'preset', label: 'Preset' },
  { value: 'fixed', label: 'Fixed dates' },
];

export const PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: 'this-iso-month', label: 'This month' },
  { value: 'last-iso-month', label: 'Last month' },
  { value: 'this-iso-year', label: 'This year' },
  { value: 'last-iso-year', label: 'Last year' },
  { value: 'current-block', label: 'Current block' },
];

export const DISPLAY_UNITS: readonly DisplayUnit[] = ['mi', 'km', 'm', 'ft'];

export const GRADE_SCALES: Array<{ value: GradeScale; label: string }> = [
  { value: 'yds', label: 'YDS' },
  { value: 'boulder', label: 'V-grade' },
  { value: 'ice', label: 'WI/AI' },
  { value: 'mixed', label: 'M' },
];

export const MEAL_TYPES: readonly MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export const MEASURE_GROUPS: ReadonlyArray<{ label: string; ids: readonly MeasureId[] }> = [
  { label: 'Training', ids: ['session-count', 'training-time'] },
  { label: 'Strength', ids: ['set-count', 'rep-count', 'tonnage', 'est-1rm'] },
  { label: 'Climbing', ids: ['pitches', 'max-grade'] },
  { label: 'Cardio', ids: ['distance', 'elevation-gain', 'cardio-time', 'avg-hr', 'hr-zone-time'] },
  { label: 'Nutrition', ids: ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'alcohol', 'meal-count'] },
];

export const SPORT_OPTIONS: Array<{ value: Sport; label: string }> = [
  { value: 'running', label: 'Running' },
  { value: 'biking', label: 'Biking' },
  { value: 'swimming', label: 'Swimming' },
  { value: 'climbing', label: 'Climbing' },
  { value: 'other', label: 'Other' },
];

export const GROUP_BY_LABELS: Readonly<Record<GroupBy, string>> = {
  'event-type': 'Workout type',
  sport: 'Sport',
  exercise: 'Exercise',
  category: 'Category',
  'meal-type': 'Meal type',
  'hr-zone': 'HR zone',
  unit: 'Unit',
};

export const DAY_FILTER_MODES: Array<{ value: 'include' | 'exclude'; label: string }> = [
  { value: 'include', label: 'Only those days' },
  { value: 'exclude', label: 'Everything else' },
];

/** Shown under "Which workouts" when no workout carries the sport "other". */
export const OTHER_SPORT_HINT = 'No workouts marked “Other sport” yet — set a sport on a workout in the builder.';
