import { describe, it, expect } from 'vitest';
import { convertLength, resolveUnits } from '../units';

describe('convertLength', () => {
  it('converts between the four known length units exactly', () => {
    expect(convertLength(1, 'mi', 'm')).toBeCloseTo(1609.344, 6);
    expect(convertLength(5000, 'm', 'km')).toBe(5);
    expect(convertLength(1, 'ft', 'm')).toBeCloseTo(0.3048, 6);
    expect(convertLength(10, 'km', 'mi')).toBeCloseTo(6.21371, 4);
  });

  it('refuses unknown units', () => {
    expect(convertLength(3, 'laps', 'mi')).toBeNull();
    expect(convertLength(3, '', 'mi')).toBeNull();
  });
});

describe('resolveUnits', () => {
  it('with a display unit: converts known units, excludes the rest, counts unparseable', () => {
    const r = resolveUnits(
      [{ value: 5, unit: 'mi' }, { value: 8, unit: 'km' }, { value: 3, unit: 'laps' }, null],
      'km',
    );
    expect(r.unit).toBe('km');
    expect(r.kept[0]).toBeCloseTo(8.046, 2);
    expect(r.kept[1]).toBe(8);
    expect(r.excludedOtherUnit).toBe(1);
    expect(r.excludedUnparseable).toBe(1);
    expect(r.keptMask).toEqual([true, true, false, false]);
  });

  it('without a display unit: charts the dominant unit and excludes the rest', () => {
    const r = resolveUnits(
      [{ value: 5, unit: 'mi' }, { value: 4, unit: 'mi' }, { value: 8, unit: 'km' }],
      undefined,
    );
    expect(r.unit).toBe('mi');
    expect(r.kept).toEqual([5, 4]);
    expect(r.excludedOtherUnit).toBe(1);
  });

  it('breaks dominance ties alphabetically (the dominantHighlight rule)', () => {
    const r = resolveUnits([{ value: 1, unit: 'mi' }, { value: 2, unit: 'km' }], undefined);
    expect(r.unit).toBe('km');
  });
});
