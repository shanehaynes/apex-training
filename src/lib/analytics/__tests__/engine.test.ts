import { describe, it, expect } from 'vitest';
import { computeTile, type TileResult } from '../engine';
import { computeStrengthStats } from '../../review/stats';
import type { StatsPeriod } from '../../review/types';
import {
  makeCardio,
  makeCompletion,
  makeCtx,
  makeInputs,
  makeMeal,
  makeSession,
  makeSet,
  makeSpec,
  makeStream,
} from './helpers';

function dataOf(result: TileResult) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.problem}`);
  return result.data;
}

describe('computeTile — problems', () => {
  it('surfaces spec violations as a problem, not a throw', () => {
    const result = computeTile(makeSpec({ measure: 'max-grade' }), makeInputs(), makeCtx());
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.problem).toContain('gradeScale');
  });

  it('explains a blockless current-block range and an over-resolved chart', () => {
    const blockless = computeTile(
      makeSpec({ measure: 'distance' }, { range: { kind: 'preset', preset: 'current-block' } }),
      makeInputs(),
      makeCtx(),
    );
    if (!blockless.ok) expect(blockless.problem).toContain('block');

    const tooMany = computeTile(
      makeSpec({ measure: 'distance' }, {
        range: { kind: 'fixed', startDate: '2020-01-01', endDateExclusive: '2026-01-01' },
        bucket: 'day',
      }),
      makeInputs(),
      makeCtx(),
    );
    if (!tooMany.ok) expect(tooMany.problem).toContain('bucket');
    expect(blockless.ok).toBe(false);
    expect(tooMany.ok).toBe(false);
  });

  it('asks for HR settings before computing zone tiles', () => {
    const result = computeTile(makeSpec({ measure: 'hr-zone-time' }), makeInputs(), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('profile');
  });
});

describe('computeTile — cardio distance', () => {
  it('sums the dominant unit per week, zero-fills empty buckets, and counts exclusions', () => {
    const inputs = makeInputs({
      cardioLogs: [
        makeCardio('2026-09-07', 'Run', '5 mi', null),
        makeCardio('2026-09-08', 'Run', '3 mi', null),
        makeCardio('2026-09-09', 'Row', '8 km', null),       // other unit → excluded
        makeCardio('2026-09-21', 'Run', 'around the lake', null), // unparseable → excluded
        makeCardio('2026-09-22', 'Run', '4 mi', null),
        makeCardio('2026-09-23', 'Run', '2 mi', null, { is_autofilled: true }), // never counts
      ],
    });
    const spec = makeSpec({ measure: 'distance' }, {
      range: { kind: 'fixed', startDate: '2026-09-07', endDateExclusive: '2026-10-05' },
      bucket: 'week',
    });
    const data = dataOf(computeTile(spec, inputs, makeCtx()));
    expect(data.buckets.map(b => b.key)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    expect(data.series).toHaveLength(1);
    expect(data.series[0].unit).toBe('mi');
    expect(data.series[0].points).toEqual([8, 0, 4, 0]);
    expect(data.excluded).toEqual({ otherUnit: 1, unparseable: 1 });
  });

  it('converts everything with an opt-in display unit', () => {
    const inputs = makeInputs({
      cardioLogs: [
        makeCardio('2026-09-07', 'Run', '5 mi', null),
        makeCardio('2026-09-08', 'Row', '8 km', null),
      ],
    });
    const spec = makeSpec({ measure: 'distance' }, { displayUnit: 'km' });
    const data = dataOf(computeTile(spec, inputs, makeCtx()));
    expect(data.series[0].unit).toBe('km');
    expect(data.series[0].points[0]).toBeCloseTo(5 * 1.609344 + 8, 5);
    expect(data.excluded).toEqual({ otherUnit: 0, unparseable: 0 });
  });
});

describe('computeTile — completions', () => {
  it('training time prefers tracked session seconds (durationMinutesFor)', () => {
    const completion = makeCompletion('2026-09-10', 'weights', { duration_minutes: 60 });
    const inputs = makeInputs({
      completions: [completion],
      sessions: [makeSession('2026-09-10', completion.event_id, 45 * 60)],
    });
    const data = dataOf(computeTile(makeSpec({ measure: 'training-time' }), inputs, makeCtx()));
    expect(data.series[0].points).toEqual([45]);
  });

  it('fans session counts by event type into labeled series', () => {
    const inputs = makeInputs({
      completions: [
        makeCompletion('2026-09-10', 'weights'),
        makeCompletion('2026-09-11', 'weights'),
        makeCompletion('2026-09-12', 'cardio'),
        makeCompletion('2026-09-13', 'yoga', { is_completed: false }), // never counts
      ],
    });
    const data = dataOf(computeTile(makeSpec({ measure: 'session-count', groupBy: 'event-type' }), inputs, makeCtx()));
    expect(data.series.map(s => [s.label, s.points[0]])).toEqual([
      ['cardio', 1],
      ['weights', 2],
    ]);
  });
});

describe('computeTile — strength', () => {
  const setLogs = [
    makeSet('2026-09-08', 'Bench Press', '185', '5'),
    makeSet('2026-09-08', 'Bench Press', '185', '5'),
    makeSet('2026-09-10', 'Squat', '225', '3'),
    makeSet('2026-09-12', 'Plank', null, null, { actual_duration: '90s' }),
    makeSet('2026-09-14', 'Bench Press', '0', '5'),
  ];

  it('tonnage matches computeStrengthStats over a shared fixture', () => {
    const period: StatsPeriod = {
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      periodType: 'block',
      label: 'test',
      weeksInPeriod: 4,
    };
    const expected = computeStrengthStats(setLogs, period).tonnage;
    const data = dataOf(computeTile(makeSpec({ measure: 'tonnage' }), makeInputs({ setLogs }), makeCtx()));
    expect(data.series[0].points[0]).toBe(expected);
    expect(expected).toBe(185 * 5 * 2 + 225 * 3);
  });

  it('est-1rm takes the bucket max for a filtered exercise; empty buckets are null', () => {
    const spec = makeSpec(
      { measure: 'est-1rm', filters: { exerciseNames: ['bench press'] } },
      { range: { kind: 'fixed', startDate: '2026-09-07', endDateExclusive: '2026-09-21' }, bucket: 'week' },
    );
    const data = dataOf(computeTile(spec, makeInputs({ setLogs }), makeCtx()));
    expect(data.series[0].points[0]).toBeCloseTo(185 * (1 + 5 / 30), 5);
    expect(data.series[0].points[1]).toBeNull();
  });
});

describe('computeTile — climbing', () => {
  const categories = new Map([['def-route', 'climbing'], ['def-bench', 'strength']]);
  const setLogs = [
    makeSet('2026-09-08', 'Sport route', '5.11a', null, { definition_id: 'def-route' }),
    makeSet('2026-09-08', 'Sport route', '5.9', null, { definition_id: 'def-route' }),
    makeSet('2026-09-08', 'Boulder', 'V5', null, { definition_id: 'def-route' }),
    makeSet('2026-09-08', 'Bench Press', '185', '5', { definition_id: 'def-bench' }),
    // No definition: falls back to the completion's event type.
    makeSet('2026-09-15', 'Mystery route', '5.10c', null, { event_id: 'evt-2026-09-15-outdoor-climbing' }),
  ];
  const completions = [makeCompletion('2026-09-15', 'outdoor-climbing')];

  it('counts pitches via the definition category, with the event-type fallback', () => {
    const data = dataOf(computeTile(makeSpec({ measure: 'pitches' }), makeInputs({ setLogs, completions, categories }), makeCtx()));
    expect(data.series[0].points[0]).toBe(4); // 3 by category + 1 by fallback, never the bench row
  });

  it('scopes pitches to one grade scale when asked', () => {
    const data = dataOf(computeTile(
      makeSpec({ measure: 'pitches', filters: { gradeScale: 'boulder' } }),
      makeInputs({ setLogs, completions, categories }),
      makeCtx(),
    ));
    expect(data.series[0].points[0]).toBe(1);
  });

  it('max-grade ranks within a scale and labels the bucket with the grade text', () => {
    const spec = makeSpec(
      { measure: 'max-grade', filters: { gradeScale: 'yds' } },
      { range: { kind: 'fixed', startDate: '2026-09-07', endDateExclusive: '2026-09-21' }, bucket: 'week' },
    );
    const data = dataOf(computeTile(spec, makeInputs({ setLogs, completions, categories }), makeCtx()));
    expect(data.series[0].gradeLabels).toEqual(['5.11a', '5.10c']);
    expect(data.series[0].points[0]!).toBeGreaterThan(data.series[0].points[1]!);
  });
});

describe('computeTile — day filters', () => {
  const completions = [
    makeCompletion('2026-09-08', 'weights'),
    // Outside the tile range: the fetch window is wider, and the shifted
    // join must still see it (its day-after lands inside the range).
    makeCompletion('2026-08-31', 'weights'),
  ];
  const meals = [
    makeMeal('2026-09-01', { protein_g: 40 }), // day after the 08-31 session
    makeMeal('2026-09-09', { protein_g: 50 }), // day after the 09-08 session
    makeMeal('2026-09-09', { protein_g: 10 }), // same day — sums into the day total
    makeMeal('2026-09-12', { protein_g: 30 }), // an ordinary day
  ];

  it('avg protein on the day AFTER strength days, averaged per logged day', () => {
    const spec = makeSpec({
      measure: 'protein',
      agg: 'avg',
      filters: { dayFilter: { eventTypes: ['weights'], offsetDays: 1, mode: 'include' } },
    });
    const data = dataOf(computeTile(spec, makeInputs({ completions, meals }), makeCtx()));
    // Day totals on matched days: Sep 1 → 40, Sep 9 → 60; avg 50.
    expect(data.series[0].points[0]).toBe(50);
  });

  it('exclude mode charts the contrast', () => {
    const spec = makeSpec({
      measure: 'protein',
      agg: 'avg',
      filters: { dayFilter: { eventTypes: ['weights'], offsetDays: 1, mode: 'exclude' } },
    });
    const data = dataOf(computeTile(spec, makeInputs({ completions, meals }), makeCtx()));
    expect(data.series[0].points[0]).toBe(30);
  });
});

describe('computeTile — synced activities', () => {
  const streams = [
    makeStream('2026-09-08', { sportLabel: 'Pool Swim', distanceMeters: 1500, durationSec: 1800, avgHr: 120 }),
    makeStream('2026-09-10', { sportLabel: 'Trail Run', distanceMeters: 10000, durationSec: 3600, avgHr: 150 }),
  ];

  it('swim meters survive: synced distance is canonical meters, convertible on demand', () => {
    const swimOnly = makeSpec({ measure: 'synced-distance', filters: { sports: ['Pool Swim'] } });
    const data = dataOf(computeTile(swimOnly, makeInputs({ streams }), makeCtx()));
    expect(data.series[0].unit).toBe('m');
    expect(data.series[0].points[0]).toBe(1500);

    const inMiles = dataOf(computeTile({ ...swimOnly, displayUnit: 'mi' }, makeInputs({ streams }), makeCtx()));
    expect(inMiles.series[0].points[0]).toBeCloseTo(1500 / 1609.344, 5);
  });

  it('groups by sport and weights synced avg HR by duration', () => {
    const bySport = dataOf(computeTile(makeSpec({ measure: 'synced-distance', groupBy: 'sport' }), makeInputs({ streams }), makeCtx()));
    expect(bySport.series.map(s => s.label)).toEqual(['Pool Swim', 'Trail Run']);

    const avgHr = dataOf(computeTile(makeSpec({ measure: 'synced-avg-hr' }), makeInputs({ streams }), makeCtx()));
    expect(avgHr.series[0].points[0]).toBeCloseTo((120 * 1800 + 150 * 3600) / 5400, 5);
  });

  it('hr-zone time fans by zone from the reduced per-activity seconds', () => {
    const zoned = [
      makeStream('2026-09-08', { zoneSeconds: [600, 1200, 0, 0, 0] }),
      makeStream('2026-09-10', { zoneSeconds: [0, 600, 600, 0, 0] }),
    ];
    const data = dataOf(computeTile(
      makeSpec({ measure: 'hr-zone-time' }),
      makeInputs({ streams: zoned }),
      makeCtx({ hr: { maxHr: 190, thresholdHr: null } }),
    ));
    expect(data.series.map(s => [s.label, s.points[0]])).toEqual([
      ['Z1', 10],
      ['Z2', 30],
      ['Z3', 10],
    ]);
  });
});

describe('computeTile — nutrition', () => {
  it('derives calories per meal (4/4/9/7) and averages per logged day', () => {
    const meals = [
      makeMeal('2026-09-08', { protein_g: 40, carbs_g: 50, fat_total_g: 25, alcohol_g: 14 }),
      makeMeal('2026-09-09', { calories: 500 }),
    ];
    const data = dataOf(computeTile(makeSpec({ measure: 'calories', agg: 'avg' }), makeInputs({ meals }), makeCtx()));
    expect(data.series[0].points[0]).toBe((683 + 500) / 2);
  });

  it('filters by meal type and counts meals', () => {
    const meals = [
      makeMeal('2026-09-08', { meal_type: 'dinner', alcohol_g: 28 }),
      makeMeal('2026-09-09', { meal_type: 'snack', alcohol_g: 14 }),
    ];
    const dinners = dataOf(computeTile(
      makeSpec({ measure: 'alcohol', agg: 'sum', filters: { mealTypes: ['dinner'] } }),
      makeInputs({ meals }),
      makeCtx(),
    ));
    expect(dinners.series[0].points[0]).toBe(28);

    const count = dataOf(computeTile(makeSpec({ measure: 'meal-count' }), makeInputs({ meals }), makeCtx()));
    expect(count.series[0].points[0]).toBe(2);
  });
});

describe('computeTile — axes', () => {
  it('sends the second unit kind to the right axis', () => {
    const spec = makeSpec({ measure: 'distance' }, {
      series: [
        { id: 's1', measure: 'distance' },
        { id: 's2', measure: 'tonnage' },
      ],
    });
    const data = dataOf(computeTile(spec, makeInputs(), makeCtx()));
    expect(data.series.map(s => s.axis)).toEqual(['left', 'right']);
  });
});
