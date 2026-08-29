import { describe, it, expect } from 'vitest';
import { maxDayOffset, needsHrZones, specProblem, upgradeSpec, type ChartSpec } from '../spec';
import { makeSpec } from './helpers';

describe('specProblem', () => {
  it('accepts a well-formed spec', () => {
    expect(specProblem(makeSpec({ measure: 'distance' }))).toBeNull();
  });

  it('rejects the wrong version, a blank title, and empty series', () => {
    expect(specProblem({ ...makeSpec({ measure: 'distance' }), version: 2 as never })).toContain('version');
    expect(specProblem(makeSpec({ measure: 'distance' }, { title: '  ' }))).toContain('title');
    expect(specProblem(makeSpec({ measure: 'distance' }, { series: [] }))).toContain('at least one series');
  });

  it('rejects out-of-catalog aggregation and grouping per measure', () => {
    expect(specProblem(makeSpec({ measure: 'session-count', agg: 'sum' }))).toContain('supports agg');
    expect(specProblem(makeSpec({ measure: 'protein', groupBy: 'sport' }))).toContain('groups by');
  });

  it('requires a grade scale on max-grade', () => {
    expect(specProblem(makeSpec({ measure: 'max-grade' }))).toContain('gradeScale');
    expect(specProblem(makeSpec({ measure: 'max-grade', filters: { gradeScale: 'yds' } }))).toBeNull();
  });

  it('rejects the sports filter on measures without a sport dimension', () => {
    expect(specProblem(makeSpec({ measure: 'distance', filters: { sports: ['Trail Run'] } }))).toContain('synced');
    expect(specProblem(makeSpec({ measure: 'synced-distance', filters: { sports: ['Trail Run'] } }))).toBeNull();
  });

  it('rejects malformed ranges and day filters', () => {
    expect(specProblem(makeSpec({ measure: 'distance' }, { range: { kind: 'rolling', days: 0 } }))).toContain('rolling');
    expect(specProblem(makeSpec({ measure: 'distance' }, {
      range: { kind: 'fixed', startDate: '2026-10-01', endDateExclusive: '2026-09-01' },
    }))).toContain('start before');
    expect(specProblem(makeSpec({
      measure: 'protein',
      filters: { dayFilter: { eventTypes: ['weights'], offsetDays: 9, mode: 'include' } },
    }))).toContain('offsetDays');
  });

  it('caps a tile at two unit kinds, and stacked bars at one', () => {
    const three = makeSpec({ measure: 'distance' }, {
      series: [
        { id: 's1', measure: 'distance' },
        { id: 's2', measure: 'tonnage' },
        { id: 's3', measure: 'protein' },
      ],
    });
    expect(specProblem(three)).toContain('unit kinds');

    const stacked = makeSpec({ measure: 'distance' }, {
      chartType: 'stacked-bar',
      series: [
        { id: 's1', measure: 'distance' },
        { id: 's2', measure: 'tonnage' },
      ],
    });
    expect(specProblem(stacked)).toContain('stacked');
  });

  it('rejects duplicate series ids', () => {
    const spec = makeSpec({ measure: 'distance' }, {
      series: [
        { id: 's1', measure: 'distance' },
        { id: 's1', measure: 'tonnage' },
      ],
    });
    expect(specProblem(spec)).toContain('duplicate');
  });
});

describe('upgradeSpec', () => {
  it('round-trips a valid spec and rejects garbage', () => {
    const spec = makeSpec({ measure: 'protein' });
    expect(upgradeSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
    expect(upgradeSpec(null)).toBeNull();
    expect(upgradeSpec('spec')).toBeNull();
    expect(upgradeSpec({ version: 99 })).toBeNull();
    expect(upgradeSpec({ ...spec, series: [{ id: 's1', measure: 'nope' }] })).toBeNull();
  });
});

describe('fetch hints', () => {
  it('reports the widest day offset and zone usage across specs', () => {
    const a = makeSpec({ measure: 'protein', filters: { dayFilter: { eventTypes: ['weights'], offsetDays: -3, mode: 'include' } } });
    const b: ChartSpec = makeSpec({ measure: 'hr-zone-time' });
    expect(maxDayOffset([a, b])).toBe(3);
    expect(needsHrZones([a])).toBe(false);
    expect(needsHrZones([a, b])).toBe(true);
  });
});
