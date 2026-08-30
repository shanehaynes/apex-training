import { describe, it, expect } from 'vitest';
import {
  applyChartDraftUpdate,
  chartDraftProblem,
  describeChartDraft,
  draftFromSpec,
  emptyChartDraft,
  specFromDraft,
  type ChartDraft,
} from '../draft';
import { makeSpec } from './helpers';

function validDraft(): ChartDraft {
  const draft = emptyChartDraft();
  draft.title = 'Weekly mileage';
  draft.series[0].measure = 'distance';
  return draft;
}

describe('chartDraftProblem / specFromDraft', () => {
  it('a fresh draft needs a measure; a filled one builds a valid spec', () => {
    expect(chartDraftProblem(emptyChartDraft())).toContain('measure');
    const result = specFromDraft(validDraft());
    expect(result).toHaveProperty('spec');
    if ('spec' in result) {
      expect(result.spec).toMatchObject({
        version: 1,
        title: 'Weekly mileage',
        range: { kind: 'rolling', days: 90 },
        bucket: 'week',
        series: [{ id: 's1', measure: 'distance' }],
      });
    }
  });

  it('the form end date is inclusive; the spec end is exclusive', () => {
    const draft = validDraft();
    draft.rangeKind = 'fixed';
    draft.startDate = '2026-09-01';
    draft.endDate = '2026-09-30';
    const result = specFromDraft(draft);
    if ('spec' in result) {
      expect(result.spec.range).toEqual({ kind: 'fixed', startDate: '2026-09-01', endDateExclusive: '2026-10-01' });
    } else {
      throw new Error(result.error);
    }
  });

  it('kpi charts silently take the total bucket', () => {
    const draft = validDraft();
    draft.chartType = 'kpi';
    draft.bucket = 'week';
    const result = specFromDraft(draft);
    if ('spec' in result) expect(result.spec.bucket).toBe('total');
    else throw new Error(result.error);
  });

  it('round-trips draft → spec → draft', () => {
    const draft = validDraft();
    draft.rangeKind = 'fixed';
    draft.startDate = '2026-09-01';
    draft.endDate = '2026-09-30';
    draft.series[0].eventTypes = ['cardio'];
    draft.series[0].dayFilterTypes = ['weights'];
    draft.series[0].dayFilterOffset = '1';
    const built = specFromDraft(draft);
    if (!('spec' in built)) throw new Error(built.error);
    expect(draftFromSpec(built.spec)).toEqual(draft);
  });
});

describe('applyChartDraftUpdate', () => {
  it('applies partial chart-level fields and reports what changed', () => {
    const result = applyChartDraftUpdate(validDraft(), {
      title: 'Mileage by sport',
      chart_type: 'bar',
      date_range: { kind: 'preset', preset: 'this-iso-year' },
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.draft.title).toBe('Mileage by sport');
    expect(result.draft.chartType).toBe('bar');
    expect(result.draft.preset).toBe('this-iso-year');
    expect(result.summary).toContain('title');
    expect(result.summary).toContain('Save');
  });

  it('merges series by id and appends without one', () => {
    const result = applyChartDraftUpdate(validDraft(), {
      series: [
        { id: 's1', agg: 'avg' },
        { measure: 'tonnage', label: 'Lifting' },
      ],
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.draft.series).toHaveLength(2);
    expect(result.draft.series[0].agg).toBe('avg');
    expect(result.draft.series[1]).toMatchObject({ id: 's2', measure: 'tonnage', label: 'Lifting' });
  });

  it('removes series by id', () => {
    const draft = validDraft();
    draft.series.push({ ...draft.series[0], id: 's2', measure: 'tonnage' });
    const result = applyChartDraftUpdate(draft, { remove_series: ['s1'] });
    if ('error' in result) throw new Error(result.error);
    expect(result.draft.series.map(s => s.id)).toEqual(['s2']);
  });

  it('collects every violation into one error and applies NOTHING', () => {
    const draft = validDraft();
    const result = applyChartDraftUpdate(draft, {
      title: '',
      chart_type: 'pie',
      series: [{ id: 's1', agg: 'median' }],
    });
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toContain('title');
      expect(result.error).toContain('chart_type');
      expect(result.error).toContain('agg');
    }
    expect(draft.title).toBe('Weekly mileage'); // untouched
  });

  it('rolls back an appended series when its own fields fail', () => {
    const result = applyChartDraftUpdate(validDraft(), {
      series: [{ measure: 'tonnage', agg: 'median' }],
    });
    expect(result).toHaveProperty('error');
  });

  it('a new series must name a measure', () => {
    const result = applyChartDraftUpdate(validDraft(), { series: [{ label: 'Mystery' }] });
    expect(result).toHaveProperty('error');
    if ('error' in result) expect(result.error).toContain('measure');
  });

  it('day_filter sets and clears', () => {
    const on = applyChartDraftUpdate(validDraft(), {
      series: [{ id: 's1', day_filter: { event_types: ['weights'], offset_days: 1 } }],
    });
    if ('error' in on) throw new Error(on.error);
    expect(on.draft.series[0].dayFilterTypes).toEqual(['weights']);
    expect(on.draft.series[0].dayFilterOffset).toBe('1');

    const off = applyChartDraftUpdate(on.draft, { series: [{ id: 's1', day_filter: { off: true } }] });
    if ('error' in off) throw new Error(off.error);
    expect(off.draft.series[0].dayFilterTypes).toEqual([]);
  });

  it('refuses an empty update', () => {
    const result = applyChartDraftUpdate(validDraft(), {});
    expect(result).toHaveProperty('error');
  });

  it('flags a structurally broken result in the summary instead of blocking', () => {
    const result = applyChartDraftUpdate(validDraft(), {
      series: [{ measure: 'max-grade' }], // valid append, but max-grade needs a scale
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.summary).toContain('grade scale');
  });
});

describe('describeChartDraft', () => {
  it('serializes the draft compactly, including the blocking problem', () => {
    const text = describeChartDraft(draftFromSpec(makeSpec({ measure: 'protein', agg: 'avg' })));
    expect(text).toContain('protein');
    expect(text).toContain('agg avg');

    const broken = describeChartDraft(emptyChartDraft());
    expect(broken).toContain('Blocking problem');
  });
});
