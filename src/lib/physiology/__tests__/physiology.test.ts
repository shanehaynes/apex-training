import { describe, expect, it } from 'vitest';
import {
  computePhysiology,
  describePhysiology,
  parseHrZones,
  physiologyWindowStart,
  type ActivityInput,
  type CardioLogInput,
  type PhysiologyInputs,
  type SetLogInput,
} from '../index';

// Friday 2026-09-25. Monday-start weeks: W-4 Aug 24, W-3 Aug 31, W-2 Sep 7,
// W-1 Sep 14, this week Sep 21.
const TODAY = '2026-09-25';
const WEEKS = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];

function activity(over: Partial<ActivityInput> & { eventDate: string }): ActivityInput {
  return { eventId: `act-${over.eventDate}`, durationSec: null, avgHr: null, hrZones: null, trainingLoad: null, hrv: null, ...over };
}
function cardio(over: Partial<CardioLogInput> & { eventDate: string }): CardioLogInput {
  return { eventId: `card-${over.eventDate}`, avgHeartRate: null, durationMinutes: null, ...over };
}
function set(over: Partial<SetLogInput> & { eventDate: string }): SetLogInput {
  return { actualWeight: null, actualReps: null, actualDuration: null, isAutofilled: false, ...over };
}
function inputs(over: Partial<PhysiologyInputs> = {}): PhysiologyInputs {
  return { today: TODAY, activities: [], cardioLogs: [], setLogs: [], thresholdHr: null, maxHr: null, ...over };
}

describe('window', () => {
  it('covers the four completed Monday-start weeks before this one, plus this one', () => {
    expect(computePhysiology(inputs()).weekStarts).toEqual(WEEKS);
    expect(physiologyWindowStart(TODAY)).toBe('2026-08-24');
    // A Monday is its own week start; a Sunday belongs to the week before.
    expect(computePhysiology(inputs({ today: '2026-09-21' })).weekStarts.at(-1)).toBe('2026-09-21');
    expect(computePhysiology(inputs({ today: '2026-09-20' })).weekStarts.at(-1)).toBe('2026-09-14');
  });

  it('yields no sections at all for empty inputs', () => {
    const summary = computePhysiology(inputs());
    expect(summary).toEqual({ weekStarts: WEEKS, today: TODAY });
    expect(describePhysiology(summary)).toBe('');
  });
});

describe('parseHrZones', () => {
  it('reads seconds, minutes, percent and keyed shapes when the total matches the duration', () => {
    expect(parseHrZones([600, 1800, 300, 0, 0], 2700)).toEqual([10, 30, 5, 0, 0]);
    expect(parseHrZones([10, 30, 5, 0, 0], 2700)).toEqual([10, 30, 5, 0, 0]);
    expect(parseHrZones([20, 60, 20, 0, 0], 3000)).toEqual([10, 30, 10, 0, 0]);
    expect(parseHrZones({ z1: 600, z2: 1800, z3: 300, z4: 0, z5: 0 }, 2700)).toEqual([10, 30, 5, 0, 0]);
    expect(parseHrZones({ zone1: 600, zone2: 1800, zone3: 300, zone4: 0, zone5: 0 }, 2700)).toEqual([10, 30, 5, 0, 0]);
    expect(parseHrZones([
      { zone: 1, seconds: 600 }, { zone: 2, seconds: 1800 }, { zone: 3, seconds: 300 }, { zone: 4, seconds: 0 }, { zone: 5, seconds: 0 },
    ], 2700)).toEqual([10, 30, 5, 0, 0]);
  });

  it('refuses a reading it cannot reconcile with the duration rather than guess a unit', () => {
    expect(parseHrZones([1, 2, 3, 4, 5], 3600)).toBeNull();      // neither seconds nor minutes nor percent
    expect(parseHrZones([600, 1800, 300, 0, 0], null)).toBeNull(); // nothing to check against
    expect(parseHrZones([600, 1800, 300, 0], 2700)).toBeNull();    // four zones is not our model
    expect(parseHrZones([0, 0, 0, 0, 0], 2700)).toBeNull();
    expect(parseHrZones('600,1800,300,0,0', 2700)).toBeNull();
    expect(parseHrZones([600, -1, 300, 0, 0], 900)).toBeNull();
  });
});

describe('zone minutes', () => {
  it('sums device zone data per week and labels the method', () => {
    const summary = computePhysiology(inputs({
      activities: [
        activity({ eventDate: '2026-09-22', durationSec: 2700, hrZones: [600, 1800, 300, 0, 0] }),
        activity({ eventDate: '2026-09-24', durationSec: 3600, hrZones: [0, 3000, 600, 0, 0] }),
        activity({ eventDate: '2026-09-10', durationSec: 1800, hrZones: [0, 0, 0, 900, 900] }),
      ],
    }));
    expect(summary.zoneMethod).toBe('device');
    expect(summary.zoneMinutesByWeek).toEqual([
      { weekStart: '2026-08-24', minutes: null },
      { weekStart: '2026-08-31', minutes: null },
      { weekStart: '2026-09-07', minutes: [0, 0, 0, 15, 15] },
      { weekStart: '2026-09-14', minutes: null },
      { weekStart: '2026-09-21', minutes: [10, 80, 15, 0, 0] },
    ]);
  });

  it('falls back to cardio logs classed by average HR against the analytics zone model', () => {
    // Friel bands at LTHR 160: Z2 lower bound 136, Z3 144, Z4 152, Z5 160.
    const summary = computePhysiology(inputs({
      thresholdHr: 160,
      cardioLogs: [
        cardio({ eventDate: '2026-09-15', avgHeartRate: 140, durationMinutes: 45 }), // Z2
        cardio({ eventDate: '2026-09-16', avgHeartRate: 130, durationMinutes: 60 }), // Z1
        cardio({ eventDate: '2026-09-17', avgHeartRate: 165, durationMinutes: 20 }), // Z5
        cardio({ eventDate: '2026-09-18', avgHeartRate: null, durationMinutes: 30 }), // no HR → nothing
      ],
    }));
    expect(summary.zoneMethod).toBe('avgHr');
    expect(summary.zoneMinutesByWeek?.[3]).toEqual({ weekStart: '2026-09-14', minutes: [60, 45, 0, 0, 20] });
  });

  it('uses max HR when no threshold is set, and no zones at all when neither exists', () => {
    // %-of-max at 190: Z2 from 114, Z3 133, Z4 152, Z5 171 → 140 bpm is Z3.
    const withMax = computePhysiology(inputs({
      maxHr: 190,
      cardioLogs: [cardio({ eventDate: '2026-09-22', avgHeartRate: 140, durationMinutes: 30 })],
    }));
    expect(withMax.zoneMinutesByWeek?.[4].minutes).toEqual([0, 0, 30, 0, 0]);

    const neither = computePhysiology(inputs({
      cardioLogs: [cardio({ eventDate: '2026-09-22', avgHeartRate: 140, durationMinutes: 30 })],
      activities: [activity({ eventDate: '2026-09-22', durationSec: 1800, avgHr: 140 })],
    }));
    expect(neither.zoneMinutesByWeek).toBeUndefined();
    expect(neither.zoneMethod).toBeUndefined();
  });

  it('counts a synced session once even though it wrote both a stream row and a cardio log', () => {
    const summary = computePhysiology(inputs({
      thresholdHr: 160,
      activities: [activity({ eventId: 'evt-1', eventDate: '2026-09-22', durationSec: 2700, avgHr: 140 })],
      cardioLogs: [
        cardio({ eventId: 'evt-1', eventDate: '2026-09-22', avgHeartRate: 140, durationMinutes: 45 }),
        cardio({ eventId: 'evt-2', eventDate: '2026-09-22', avgHeartRate: 140, durationMinutes: 10 }),
      ],
    }));
    expect(summary.zoneMinutesByWeek?.[4].minutes).toEqual([0, 55, 0, 0, 0]);
  });

  it('prefers device data per session and reports a mixed method when both paths contribute', () => {
    const summary = computePhysiology(inputs({
      thresholdHr: 160,
      activities: [
        activity({ eventDate: '2026-09-22', durationSec: 2700, avgHr: 170, hrZones: [600, 1800, 300, 0, 0] }),
        activity({ eventDate: '2026-09-23', durationSec: 3600, avgHr: 130, hrZones: [1, 2, 3, 4, 5] }), // unusable → avg HR, Z1
      ],
    }));
    expect(summary.zoneMethod).toBe('mixed');
    expect(summary.zoneMinutesByWeek?.[4].minutes).toEqual([70, 30, 5, 0, 0]);
  });

  it('ignores anything before the window or after today', () => {
    const summary = computePhysiology(inputs({
      activities: [
        activity({ eventDate: '2026-08-23', durationSec: 600, hrZones: [600, 0, 0, 0, 0] }),
        activity({ eventDate: '2026-09-26', durationSec: 600, hrZones: [600, 0, 0, 0, 0] }),
      ],
    }));
    expect(summary.zoneMinutesByWeek).toBeUndefined();
  });
});

describe('load', () => {
  it('flags a spike: acute 7d against the 28d weekly average from device training load', () => {
    const summary = computePhysiology(inputs({
      activities: [
        // 28d window is Aug 29 – Sep 25; four steady sessions before the last week…
        activity({ eventDate: '2026-08-30', trainingLoad: 100 }),
        activity({ eventDate: '2026-09-05', trainingLoad: 100 }),
        activity({ eventDate: '2026-09-12', trainingLoad: 100 }),
        activity({ eventDate: '2026-09-17', trainingLoad: 100 }),
        // …then a big week (Sep 19 – 25).
        activity({ eventDate: '2026-09-19', trainingLoad: 150 }),
        activity({ eventDate: '2026-09-22', trainingLoad: 150 }),
        activity({ eventDate: '2026-09-25', trainingLoad: 150 }),
        // Inside the five-week window but outside the 28 days: not in chronic.
        activity({ eventDate: '2026-08-25', trainingLoad: 500 }),
      ],
    }));
    // acute 450; chronic (400 + 450) / 4 = 212.5 → shown as 213, ratio from the unrounded value.
    expect(summary.load).toEqual({ source: 'trainingLoad', acute7d: 450, chronicWeeklyAvg28d: 213, ratio: 2.12 });
    expect(summary.load!.ratio!).toBeGreaterThan(1.3);
  });

  it('falls back to cardio minutes only when no activity carries a training load', () => {
    const summary = computePhysiology(inputs({
      activities: [activity({ eventDate: '2026-09-22', durationSec: 3600, avgHr: 140 })],
      cardioLogs: [
        cardio({ eventDate: '2026-09-22', durationMinutes: 60 }),
        cardio({ eventDate: '2026-09-10', durationMinutes: 40 }),
        cardio({ eventDate: '2026-09-03', durationMinutes: 40 }),
      ],
    }));
    expect(summary.load).toEqual({ source: 'cardioMinutes', acute7d: 60, chronicWeeklyAvg28d: 35, ratio: 1.71 });

    const mixed = computePhysiology(inputs({
      activities: [activity({ eventDate: '2026-09-22', trainingLoad: 80 })],
      cardioLogs: [cardio({ eventDate: '2026-09-10', durationMinutes: 400 })],
    }));
    expect(mixed.load?.source).toBe('trainingLoad');
    expect(mixed.load?.acute7d).toBe(80);
  });

  it('has no ratio without a chronic baseline, and no section without any sample', () => {
    const stale = computePhysiology(inputs({ activities: [activity({ eventDate: '2026-08-25', trainingLoad: 90 })] }));
    expect(stale.load).toEqual({ source: 'trainingLoad', acute7d: 0, chronicWeeklyAvg28d: 0, ratio: null });
    expect(computePhysiology(inputs({ cardioLogs: [cardio({ eventDate: '2026-09-22' })] })).load).toBeUndefined();
  });
});

describe('tonnage', () => {
  it('sums weight × reps of logged weighted sets per week, skipping autofills and unweighted sets', () => {
    const summary = computePhysiology(inputs({
      setLogs: [
        set({ eventDate: '2026-09-22', actualWeight: '185 lb', actualReps: '5' }),
        set({ eventDate: '2026-09-22', actualWeight: '185', actualReps: '5', isAutofilled: true }), // zero-fill, skipped
        set({ eventDate: '2026-09-22', actualWeight: null, actualReps: '10' }),                    // bodyweight: no tonnage
        set({ eventDate: '2026-09-22', actualDuration: '60s' }),                                     // hold: no tonnage
        set({ eventDate: '2026-09-22', actualWeight: 'BW', actualReps: '8' }),                       // unparseable weight
        set({ eventDate: '2026-09-09', actualWeight: '100', actualReps: '10' }),
        set({ eventDate: '2026-09-09', actualWeight: '62.5', actualReps: '8' }),
      ],
    }));
    expect(summary.tonnageByWeek).toEqual([
      { weekStart: '2026-08-24', tonnageLb: null },
      { weekStart: '2026-08-31', tonnageLb: null },
      { weekStart: '2026-09-07', tonnageLb: 1500 },
      { weekStart: '2026-09-14', tonnageLb: null },
      { weekStart: '2026-09-21', tonnageLb: 925 },
    ]);
  });

  it('is absent when only unweighted sets were logged', () => {
    const summary = computePhysiology(inputs({ setLogs: [set({ eventDate: '2026-09-22', actualReps: '12' })] }));
    expect(summary.tonnageByWeek).toBeUndefined();
  });
});

describe('hrv', () => {
  it('averages the last 7 and 28 days of activity readings', () => {
    const summary = computePhysiology(inputs({
      activities: [
        activity({ eventDate: '2026-09-25', hrv: 60 }),
        activity({ eventDate: '2026-09-19', hrv: 64 }), // day 7 of 7, inclusive
        activity({ eventDate: '2026-09-18', hrv: 50 }),
        activity({ eventDate: '2026-08-29', hrv: 50 }), // day 28 of 28
        activity({ eventDate: '2026-08-28', hrv: 10 }), // in the window, outside 28d
        activity({ eventDate: '2026-09-20', hrv: 0 }),  // not a reading
      ],
    }));
    expect(summary.hrv).toEqual({ mean7d: 62, mean28d: 56 });
  });

  it('keeps the 28d mean when the last week has no reading', () => {
    const summary = computePhysiology(inputs({ activities: [activity({ eventDate: '2026-09-10', hrv: 58 })] }));
    expect(summary.hrv).toEqual({ mean7d: null, mean28d: 58 });
    expect(describePhysiology(summary)).toContain('HRV: 28d mean 58 ms (no reading in the last 7 days)');
  });
});

describe('describePhysiology', () => {
  const full = computePhysiology(inputs({
    thresholdHr: 160,
    activities: [
      activity({ eventDate: '2026-09-22', durationSec: 2700, hrZones: [600, 1800, 300, 0, 0], trainingLoad: 120, hrv: 62 }),
      activity({ eventDate: '2026-09-08', durationSec: 3600, avgHr: 140, trainingLoad: 90, hrv: 55 }),
    ],
    cardioLogs: [cardio({ eventDate: '2026-08-26', avgHeartRate: 130, durationMinutes: 90 })],
    setLogs: [set({ eventDate: '2026-09-15', actualWeight: '225', actualReps: '5' })],
  }));

  it('wraps every present section in the tags and closes with the rule line', () => {
    const text = describePhysiology(full);
    const lines = text.split('\n');
    expect(lines[0]).toBe('<physiology>');
    expect(lines[1]).toBe('PHYSIOLOGY (last 4 completed weeks + this week; every number is pre-computed):');
    expect(lines[2]).toBe('Weeks (Monday start): W-4 = week of Aug 24, W-3 = week of Aug 31, W-2 = week of Sep 7, W-1 = week of Sep 14, this week = Sep 21 through Sep 25');
    expect(lines.at(-2)).toBe('</physiology>');
    expect(lines.at(-1)).toBe('Cite these numbers; use the read tools for anything older or finer-grained. Never recompute or invent others.');
    expect(text).toContain('Zone minutes Z1/Z2/Z3/Z4/Z5 (device zone data where synced, otherwise whole sessions in the zone of their average HR) — W-4: 90/0/0/0/0 · W-3: — · W-2: 0/60/0/0/0 · W-1: — · this week: 10/30/5/0/0');
    expect(text).toContain('Load (device training load): acute 7d 120 vs chronic weekly avg 53 (ratio 2.29)');
    expect(text).toContain('Strength tonnage by week (logged sets, weight × reps): W-4: — · W-3: — · W-2: — · W-1: 1,125 lb · this week: —');
    expect(text).toContain('HRV: 7d mean 62 ms vs 28d mean 59 ms');
  });

  it('never emits a stray angle bracket inside the body', () => {
    const body = describePhysiology(full).split('\n').slice(1, -2);
    expect(body.some(line => line.includes('<'))).toBe(false);
    const stale = describePhysiology(computePhysiology(inputs({ activities: [activity({ eventDate: '2026-08-25', trainingLoad: 90 })] })));
    expect(stale).toContain('(ratio n/a, no chronic baseline)');
    expect(stale.split('\n').slice(1, -2).some(line => line.includes('<'))).toBe(false);
  });

  it('omits the lines whose sections are absent', () => {
    const text = describePhysiology(computePhysiology(inputs({
      setLogs: [set({ eventDate: '2026-09-22', actualWeight: '135', actualReps: '10' })],
    })));
    expect(text).toContain('Strength tonnage by week');
    expect(text).not.toContain('Zone minutes');
    expect(text).not.toContain('Load');
    expect(text).not.toContain('HRV');
  });
});
