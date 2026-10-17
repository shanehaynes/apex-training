import { describe, it, expect } from 'vitest';
import { computePhysiology, describePhysiology } from '../index';
import type { DailyMetricInput, PhysiologyInputs } from '../index';

// Apple Health's daily metrics in the physiology panel (W16 M3b): sleep,
// resting HR, steps, body mass, and HRV from the overnight SDNN — each
// computed here, each a line the coach cites, each absent without data.

const TODAY = '2026-09-25';

function day(date: string, over: Partial<DailyMetricInput> = {}): DailyMetricInput {
  return { date, sleepMinutes: null, hrvSdnnMs: null, restingHr: null, steps: null, bodyMassLb: null, ...over };
}

function inputs(over: Partial<PhysiologyInputs> = {}): PhysiologyInputs {
  return { today: TODAY, activities: [], cardioLogs: [], setLogs: [], thresholdHr: null, maxHr: null, ...over };
}

describe('daily metrics in computePhysiology', () => {
  it('adds nothing without daily metrics: the summary is what it always was', () => {
    expect(computePhysiology(inputs())).toEqual(computePhysiology(inputs({ dailyMetrics: [] })));
    expect(computePhysiology(inputs({ dailyMetrics: [] }))).not.toHaveProperty('sleep');
  });

  it('sleep: last night is the one filed under today; 7d and 28d means', () => {
    const summary = computePhysiology(inputs({
      dailyMetrics: [
        day('2026-09-25', { sleepMinutes: 420 }),
        day('2026-09-24', { sleepMinutes: 480 }),
        day('2026-09-05', { sleepMinutes: 360 }), // in 28d, out of 7d
        day('2026-08-20', { sleepMinutes: 100 }), // out of the window
      ],
    }));
    expect(summary.sleep).toEqual({ lastNight: 420, mean7d: 450, mean28d: 420 });
  });

  it('sleep: no reading for last night is said, not invented', () => {
    const summary = computePhysiology(inputs({ dailyMetrics: [day('2026-09-23', { sleepMinutes: 450 })] }));
    expect(summary.sleep).toEqual({ lastNight: null, mean7d: 450, mean28d: 450 });
  });

  it('resting HR: the latest reading and the means', () => {
    const summary = computePhysiology(inputs({
      dailyMetrics: [day('2026-09-20', { restingHr: 54 }), day('2026-09-24', { restingHr: 50 }), day('2026-09-02', { restingHr: 58 })],
    }));
    expect(summary.restingHr).toEqual({ latest: { date: '2026-09-24', bpm: 50 }, mean7d: 52, mean28d: 54 });
  });

  it("steps: completed days only — today's running total never drags the mean", () => {
    const summary = computePhysiology(inputs({
      dailyMetrics: [day('2026-09-25', { steps: 800 }), day('2026-09-24', { steps: 10000 }), day('2026-09-23', { steps: 8000 })],
    }));
    expect(summary.steps).toEqual({ mean7d: 9000, mean28d: 9000 });
  });

  it('body mass: the latest weigh-in and the 28-day change', () => {
    const summary = computePhysiology(inputs({
      dailyMetrics: [day('2026-09-01', { bodyMassLb: 184.04 }), day('2026-09-24', { bodyMassLb: 182.4 })],
    }));
    expect(summary.bodyMass).toEqual({ latest: { date: '2026-09-24', lb: 182.4 }, change28dLb: -1.6 });
    const one = computePhysiology(inputs({ dailyMetrics: [day('2026-09-24', { bodyMassLb: 182.4 })] }));
    expect(one.bodyMass?.change28dLb).toBeNull();
  });

  it('HRV prefers the overnight SDNN and never mixes in activity readings', () => {
    const activity = { eventId: 'a', eventDate: '2026-09-24', durationSec: 3600, avgHr: 140, hrZones: null, trainingLoad: null, hrv: 90 };
    const summary = computePhysiology(inputs({
      activities: [activity],
      dailyMetrics: [day('2026-09-24', { hrvSdnnMs: 40 }), day('2026-09-10', { hrvSdnnMs: 50 })],
    }));
    expect(summary.hrv).toEqual({ mean7d: 40, mean28d: 45, source: 'daily' });
    // Without daily SDNN the activity reading is used, in the shape it always had.
    expect(computePhysiology(inputs({ activities: [activity] })).hrv).toEqual({ mean7d: 90, mean28d: 90 });
  });

  it('ignores zero, negative and future readings', () => {
    const summary = computePhysiology(inputs({
      dailyMetrics: [day('2026-09-24', { sleepMinutes: 0, restingHr: -1 }), day('2026-09-26', { sleepMinutes: 400 })],
    }));
    expect(summary.sleep).toBeUndefined();
    expect(summary.restingHr).toBeUndefined();
  });
});

describe('daily metrics in describePhysiology', () => {
  it('writes one line each, inside the tags, with no angle brackets', () => {
    const text = describePhysiology(computePhysiology(inputs({
      dailyMetrics: [
        day('2026-09-25', { sleepMinutes: 432, restingHr: 52 }),
        day('2026-09-24', { sleepMinutes: 418, hrvSdnnMs: 48, steps: 9120, bodyMassLb: 182.4 }),
        day('2026-09-01', { bodyMassLb: 184 }),
      ],
    })));
    expect(text).toContain('Sleep (Apple Health): last night 7h 12m · 7d mean 7h 05m vs 28d mean 7h 05m');
    expect(text).toContain('Resting HR (Apple Health): 52 bpm on Sep 25 · 7d mean 52 vs 28d mean 52 bpm');
    expect(text).toContain('Steps per completed day (Apple Health): 7d mean 9,120 vs 28d mean 9,120');
    expect(text).toContain('Body mass (Apple Health): 182.4 lb on Sep 24 (-1.6 lb over 28 days)');
    expect(text).toContain('HRV (overnight SDNN, Apple Health): 7d mean 48 ms vs 28d mean 48 ms');
    const body = text.split('\n').filter(l => !l.startsWith('<'));
    expect(body.join('\n')).not.toContain('<');
  });

  it("keeps the activity HRV line exactly as it was", () => {
    const activity = { eventId: 'a', eventDate: '2026-09-24', durationSec: 3600, avgHr: 140, hrZones: null, trainingLoad: null, hrv: 62 };
    expect(describePhysiology(computePhysiology(inputs({ activities: [activity] }))))
      .toContain('HRV: 7d mean 62 ms vs 28d mean 62 ms');
  });
});
