import { describe, it, expect } from 'vitest';
import { zoneBounds, zoneOf, zoneSeconds } from '../hrZones';

describe('zoneBounds', () => {
  it('prefers Friel LTHR bands when a threshold is set', () => {
    expect(zoneBounds({ maxHr: 190, thresholdHr: 160 })).toEqual([136, 144, 152, 160]);
  });

  it('falls back to %-of-max bands', () => {
    expect(zoneBounds({ maxHr: 190, thresholdHr: null })).toEqual([114, 133, 152, 171]);
  });

  it('is null with neither setting', () => {
    expect(zoneBounds({ maxHr: null, thresholdHr: null })).toBeNull();
  });
});

describe('zoneOf', () => {
  it('bounds are inclusive lower edges of Z2-Z5', () => {
    const bounds: [number, number, number, number] = [114, 133, 152, 171];
    expect(zoneOf(113, bounds)).toBe(0);
    expect(zoneOf(114, bounds)).toBe(1);
    expect(zoneOf(152, bounds)).toBe(3);
    expect(zoneOf(171, bounds)).toBe(4);
  });
});

describe('zoneSeconds', () => {
  const bounds: [number, number, number, number] = [100, 120, 140, 160];

  it('integrates each sample over the gap to the next', () => {
    // 0-10s at 90 (Z1), 10-40s at 130 (Z3); the last sample (150, Z4) gets
    // the median gap — gaps [10, 30], median 30.
    const out = zoneSeconds([[0, 90], [10, 130], [40, 150]], bounds);
    expect(out[0]).toBe(10);
    expect(out[2]).toBe(30);
    expect(out[3]).toBe(30);
  });

  it('skips malformed samples and survives an empty stream', () => {
    expect(zoneSeconds([], bounds)).toEqual([0, 0, 0, 0, 0]);
    const out = zoneSeconds([[0, NaN], [5, 130], [10, 0]] as Array<[number, number]>, bounds);
    expect(out[2]).toBeGreaterThan(0);
  });
});
