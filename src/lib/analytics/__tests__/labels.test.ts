import { describe, it, expect } from 'vitest';
import { MEASURE_IDS, MEASURES } from '../spec';
import {
  BUCKETS, CHART_TYPES, DAY_FILTER_MODES, GRADE_SCALES, GROUP_BY_LABELS, MEAL_TYPES,
  MEASURE_GROUPS, PRESETS, RANGE_KINDS, SPORT_OPTIONS,
} from '../labels';

// The builder's option labels are also the iOS catalog's (ios/scripts/
// gen-analytics-catalog.mjs), so a measure or enum value without a label is
// a chip the phone cannot draw.

describe('analytics labels', () => {
  it('places every measure in exactly one group, and names no measure twice', () => {
    const grouped = MEASURE_GROUPS.flatMap(g => g.ids);
    expect([...grouped].sort()).toEqual([...MEASURE_IDS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const id of grouped) expect(MEASURES[id], id).toBeDefined();
  });

  it('labels every chart type, bucket, range kind, preset, grade scale and group-by', () => {
    expect(CHART_TYPES.map(c => c.value)).toEqual(['line', 'bar', 'stacked-bar', 'area', 'kpi', 'table']);
    expect(BUCKETS.map(b => b.value)).toEqual(['day', 'week', 'iso-month', 'total']);
    expect(RANGE_KINDS.map(r => r.value)).toEqual(['rolling', 'preset', 'fixed']);
    expect(PRESETS.map(p => p.value)).toEqual(['this-iso-month', 'last-iso-month', 'this-iso-year', 'last-iso-year', 'current-block']);
    expect(GRADE_SCALES.map(g => g.value)).toEqual(['yds', 'boulder', 'ice', 'mixed']);
    expect(MEAL_TYPES).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
    expect(DAY_FILTER_MODES.map(m => m.value)).toEqual(['include', 'exclude']);
    const groupBys = new Set(MEASURE_IDS.flatMap(id => MEASURES[id].allowedGroupBys));
    for (const g of groupBys) expect(GROUP_BY_LABELS[g], g).toBeTruthy();
    for (const list of [CHART_TYPES, BUCKETS, RANGE_KINDS, PRESETS, GRADE_SCALES, SPORT_OPTIONS, DAY_FILTER_MODES]) {
      for (const o of list) expect(o.label.trim()).toBeTruthy();
    }
  });
});
