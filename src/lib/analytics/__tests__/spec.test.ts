import { describe, it, expect } from 'vitest';
import { MAX_ROLLING_DAYS, maxDayOffset, needsHrZones, specProblem, upgradeSpec, type ChartSpec } from '../spec';
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

  it('validates sport filters: enum values, no sport on meals, compatibility blocklist', () => {
    expect(specProblem(makeSpec({ measure: 'distance', filters: { sports: ['running'] } }))).toBeNull();
    expect(specProblem(makeSpec({ measure: 'distance', filters: { sports: ['Trail Run' as never] } }))).toContain('sports must be from');
    expect(specProblem(makeSpec({ measure: 'protein', filters: { sports: ['running'] } }))).toContain('no sport');
    expect(specProblem(makeSpec({ measure: 'distance', filters: { sports: ['climbing'] } }))).toContain('incompatible');
    expect(specProblem(makeSpec({ measure: 'elevation-gain', filters: { sports: ['swimming'] } }))).toContain('incompatible');
    expect(specProblem(makeSpec({ measure: 'pitches', filters: { sports: ['running'] } }))).toContain('incompatible');
    expect(specProblem(makeSpec({ measure: 'pitches', filters: { sports: ['climbing'] } }))).toBeNull();
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

  // A fixed range used to be checked for format and ordering only, so a
  // thousand-year window sailed through and widened unionWindow's single
  // fetch to match. It now answers to the same ceiling as a rolling range.
  it('caps a fixed range at MAX_ROLLING_DAYS', () => {
    const fixed = (startDate: string, endDateExclusive: string) =>
      specProblem(makeSpec({ measure: 'distance' }, { range: { kind: 'fixed', startDate, endDateExclusive } }));

    // Exactly the cap is fine; one day more is not.
    expect(fixed('2021-01-01', '2026-01-05')).toBeNull();        // 1830 days
    expect(fixed('2021-01-01', '2026-01-06')).toContain('at most 1830 days'); // 1831
    expect(fixed('1900-01-01', '2900-01-01')).toContain(`at most ${MAX_ROLLING_DAYS} days`);
    expect(upgradeSpec(makeSpec({ measure: 'distance' }, {
      range: { kind: 'fixed', startDate: '1900-01-01', endDateExclusive: '2900-01-01' },
    }))).toBeNull();

    // DATE_PATTERN admits '9999-99-99', whose span is NaN — and a NaN
    // comparison must not read as "under the cap".
    expect(fixed('2026-01-01', '9999-99-99')).toContain('real calendar dates');
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
