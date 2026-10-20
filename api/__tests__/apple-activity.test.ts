import { describe, it, expect } from 'vitest';
import {
  APEX_BUNDLE_ID, APPLE_ACTIVITY_TYPES, isOwnAppActivity, mapAppleActivityType, MAX_APPLE_ACTIVITIES,
  parseAppleActivities, parseAppleActivity,
} from '../_lib/providers/apple/activity';
import { mapSport } from '../_lib/providers/coros/mapSport';

// Apple Health workouts as the phone posts them (W16 M2b): the body is the
// provider, so the parser is the trust boundary, and the type is mapped on
// HealthKit's integer — never through the COROS label rules.

const START = '2026-10-15T13:00:00.000Z';
const END = '2026-10-15T13:45:00.000Z';

function workout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activityId: '6F1E2D3C-0000-4000-8000-000000000001',
    activityType: 37,
    activityName: 'Outdoor Run',
    sourceBundleId: 'com.apple.health.watch',
    sourceName: 'Apple Watch',
    startUtc: START,
    endUtc: END,
    durationSec: 2700,
    distanceMeters: 8000,
    elevationGainMeters: 60,
    avgHr: 150,
    maxHr: 172,
    calories: 480,
    streams: { hr: [[0, 110], [60, 140], [120, 152]] },
    ...overrides,
  };
}

describe('mapAppleActivityType', () => {
  it('maps on the integer, not the name: Traditional Strength Training is weights', () => {
    // The trap: the COROS label rules read "trad" as outdoor climbing.
    expect(mapSport('Traditional Strength Training').type).toBe('outdoor-climbing');
    expect(mapAppleActivityType(50)).toEqual({ type: 'weights', label: 'Strength', sport: null });
  });

  it('pins the table against the SDK values', () => {
    expect(mapAppleActivityType(37)).toEqual({ type: 'cardio', label: 'Run', sport: 'running' });
    expect(mapAppleActivityType(13)).toEqual({ type: 'cardio', label: 'Ride', sport: 'biking' });
    expect(mapAppleActivityType(46)).toEqual({ type: 'cardio', label: 'Swim', sport: 'swimming' });
    expect(mapAppleActivityType(9)).toEqual({ type: 'climbing', label: 'Climb', sport: 'climbing' });
    expect(mapAppleActivityType(20).type).toBe('weights');
    expect(mapAppleActivityType(59).type).toBe('weights');
    expect(mapAppleActivityType(57).type).toBe('yoga');
    expect(mapAppleActivityType(66).type).toBe('stretching');
    expect(mapAppleActivityType(44)).toMatchObject({ type: 'cardio', label: 'Stair Climbing' });
    expect(mapAppleActivityType(3000)).toMatchObject({ type: 'cardio', label: 'Workout' });
  });

  it('imports an unknown (newer) type as cardio rather than refusing it', () => {
    expect(mapAppleActivityType(9999)).toEqual({ type: 'cardio', label: 'Workout', sport: null });
    expect(mapAppleActivityType('37')).toEqual({ type: 'cardio', label: 'Workout', sport: null });
  });

  it('never gives a climbing bucket to anything but climbing', () => {
    for (const [code, entry] of Object.entries(APPLE_ACTIVITY_TYPES)) {
      const climbing = entry.type === 'climbing' || entry.type === 'outdoor-climbing';
      expect(entry.sport === 'climbing', `type ${code}`).toBe(climbing);
    }
  });
});

describe('parseAppleActivity', () => {
  it('normalizes a well-formed workout', () => {
    const parsed = parseAppleActivity(workout());
    expect(parsed).toMatchObject({
      provider: 'apple', activityId: '6F1E2D3C-0000-4000-8000-000000000001', sport: 37,
      startUtc: START, durationSec: 2700, distanceMeters: 8000, avgHr: 150,
      summaryExtras: { endUtc: END, activityName: 'Outdoor Run', sourceName: 'Apple Watch', sourceBundleId: 'com.apple.health.watch' },
      streams: { hr: [[0, 110], [60, 140], [120, 152]] },
    });
  });

  it('accepts a minimal workout', () => {
    const minimal = { activityId: 'a', activityType: 37, startUtc: START, endUtc: END, durationSec: 60 };
    expect(parseAppleActivity(minimal)).toMatchObject({ provider: 'apple', activityId: 'a', durationSec: 60 });
  });

  it('refuses anything malformed or out of bounds', () => {
    const bad: Array<Record<string, unknown>> = [
      { activityId: '' },
      { activityId: 'x'.repeat(101) },
      { activityType: -1 },
      { activityType: 37.5 },
      { activityType: '37' },
      { startUtc: 'yesterday' },
      { endUtc: '2026-10-15T12:00:00.000Z' }, // before the start
      { durationSec: 0 },
      { durationSec: 24 * 3600 + 1 },
      { avgHr: 300 },
      { maxHr: 5 },
      { distanceMeters: -1 },
      { calories: Number.NaN },
      { sourceName: '' },
      { summaryExtras: [] },
      { summaryExtras: { blob: 'x'.repeat(9000) } },
      { streams: { hr: [[0, 400]] } },
      { streams: { hr: [[0]] } },
      { streams: { hr: 'lots' } },
    ];
    for (const override of bad) {
      expect(parseAppleActivity(workout(override)), JSON.stringify(override).slice(0, 60)).toBeNull();
    }
    expect(parseAppleActivity(null)).toBeNull();
    expect(parseAppleActivity([workout()])).toBeNull();
  });

  it('thins a long HR series to the stream cap instead of refusing it', () => {
    const hr = Array.from({ length: 5000 }, (_, i) => [i, 120]);
    const parsed = parseAppleActivity(workout({ streams: { hr } }));
    expect(parsed?.streams?.hr).toHaveLength(2000);
    expect(parsed?.streams?.hr?.[0]).toEqual([0, 120]);
    expect(parsed?.streams?.hr?.at(-1)).toEqual([4999, 120]);
  });

  it('knows a workout Apex wrote itself', () => {
    expect(isOwnAppActivity(parseAppleActivity(workout({ sourceBundleId: APEX_BUNDLE_ID }))!)).toBe(true);
    expect(isOwnAppActivity(parseAppleActivity(workout())!)).toBe(false);
  });
});

describe('parseAppleActivities', () => {
  it('takes 1..100 unique workouts', () => {
    expect(parseAppleActivities([workout()])).toHaveLength(1);
    const many = Array.from({ length: MAX_APPLE_ACTIVITIES }, (_, i) => workout({ activityId: `w-${i}` }));
    expect(parseAppleActivities(many)).toHaveLength(MAX_APPLE_ACTIVITIES);
  });

  it('refuses an empty, oversized, duplicated or partly malformed batch', () => {
    expect(parseAppleActivities([])).toBeNull();
    expect(parseAppleActivities('activities')).toBeNull();
    expect(parseAppleActivities(Array.from({ length: MAX_APPLE_ACTIVITIES + 1 }, (_, i) => workout({ activityId: `w-${i}` })))).toBeNull();
    expect(parseAppleActivities([workout(), workout()])).toBeNull();
    expect(parseAppleActivities([workout(), workout({ activityId: 'b', durationSec: -5 })])).toBeNull();
  });
});
