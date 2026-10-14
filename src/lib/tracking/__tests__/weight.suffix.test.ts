import { describe, it, expect } from 'vitest';
import { knownUnitContext, parseWeight, rowWithExplicitUnit, withExplicitUnit, type WeightContext } from '../weight';

// A committed bare weight carries the unit it was typed in, so a later unit
// switch (which re-declares what bare numbers mean) never reinterprets it.

const LB: WeightContext = { unit: 'lb', bodyWeightLb: 180 };
const KG: WeightContext = { unit: 'kg', bodyWeightLb: 180 };

describe('withExplicitUnit', () => {
  it('suffixes a bare number with the profile unit', () => {
    expect(withExplicitUnit('185', LB)).toBe('185 lb');
    expect(withExplicitUnit('100', KG)).toBe('100 kg');
    expect(withExplicitUnit('62.5', KG)).toBe('62.5 kg');
    expect(withExplicitUnit('  100 ', KG)).toBe('100 kg');
  });

  it('keeps the digits as typed: comma decimals and thousands commas', () => {
    expect(withExplicitUnit('62,5', KG)).toBe('62,5 kg');
    expect(withExplicitUnit('1,200', LB)).toBe('1,200 lb');
  });

  it('means the same weight before and after, under the context it was typed in', () => {
    for (const [text, ctx] of [['185', LB], ['100', KG], ['62,5', KG], ['1,200', LB], ['62.25', KG]] as const) {
      expect(parseWeight(withExplicitUnit(text, ctx), ctx)).toEqual(parseWeight(text, ctx));
    }
  });

  it('survives a later unit switch: the suffixed text reads the same under the other unit', () => {
    expect(parseWeight(withExplicitUnit('100', KG), LB)).toEqual(parseWeight('100', KG));
    expect(parseWeight(withExplicitUnit('185', LB), KG)).toEqual(parseWeight('185', LB));
  });

  it('leaves text that already names a unit untouched', () => {
    for (const text of ['185 lb', '185lbs', '185 lbs.', '100 kg', '100kg', '45#', '20 kilos', '62,5 kilograms']) {
      expect(withExplicitUnit(text, KG)).toBe(text);
      expect(withExplicitUnit(text, LB)).toBe(text);
    }
  });

  it('leaves body-weight forms untouched', () => {
    for (const text of ['BW', 'bw', 'BW+10', 'BW + 25 lbs', 'BW-10kg']) {
      expect(withExplicitUnit(text, KG)).toBe(text);
    }
    // Even with no body weight on the profile (parseWeight reads them as null).
    expect(withExplicitUnit('BW+10', { unit: 'kg', bodyWeightLb: null })).toBe('BW+10');
  });

  it('leaves zero, signed numbers, empty and junk untouched', () => {
    for (const text of ['0', '0.0', '-10', '+10', '', '   ', 'heavy', '100kg x 5', '80%', '5.10a', '185.', '.5', '1e3', 'BW25']) {
      expect(withExplicitUnit(text, KG)).toBe(text);
    }
  });
});

// The save path's rule: every set row sent carries its unit, even one that
// leaves before its field's blur rewrote it.
describe('rowWithExplicitUnit', () => {
  const row = (actual_weight: string | null) => ({ set_number: 1, actual_weight, actual_reps: '5' });

  it('suffixes a bare weight with the known unit, leaving the rest of the row alone', () => {
    expect(rowWithExplicitUnit(row('100'), KG, false)).toEqual({ set_number: 1, actual_weight: '100 kg', actual_reps: '5' });
    expect(rowWithExplicitUnit(row('185'), LB, false)).toEqual({ set_number: 1, actual_weight: '185 lb', actual_reps: '5' });
  });

  it('does not rewrite when the unit is not known', () => {
    const r = row('100');
    expect(rowWithExplicitUnit(r, null, false)).toBe(r);
  });

  it('never rewrites a climbing pitch (its weight column holds the grade)', () => {
    const r = row('12');
    expect(rowWithExplicitUnit(r, KG, true)).toBe(r);
  });

  it('passes suffixed, BW, zero, empty and junk weights through unchanged', () => {
    for (const w of ['185 lb', '100 kg', 'BW+10', '0', null, 'heavy']) {
      const r = row(w);
      expect(rowWithExplicitUnit(r, KG, false)).toBe(r);
    }
  });
});

describe('knownUnitContext', () => {
  it('is the profile context only when weight_unit is lb or kg', () => {
    expect(knownUnitContext({ weight_unit: 'kg', body_weight_lb: 180 })).toEqual({ unit: 'kg', bodyWeightLb: 180 });
    expect(knownUnitContext({ weight_unit: 'lb', body_weight_lb: null })).toEqual({ unit: 'lb', bodyWeightLb: null });
    expect(knownUnitContext(null)).toBeNull();
    expect(knownUnitContext(undefined)).toBeNull();
    expect(knownUnitContext({ body_weight_lb: 180 })).toBeNull();
    expect(knownUnitContext({ weight_unit: 'stone' })).toBeNull();
  });
});
