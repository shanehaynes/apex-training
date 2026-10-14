import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEIGHT_CONTEXT,
  parseWeight,
  type ParsedWeight,
  type WeightContext,
  type WeightUnit,
} from '../weight';

// Pins the parseWeight contract (phase55) so the implementation lane and
// its callers can land in either order: the exports exist, the default
// context has the agreed shape, and the signature is what callers compile
// against. The third case is the first real assertion: a bare number under
// the default context is that many pounds (the acceptance suite beside this
// file covers the grammar).

describe('parseWeight contract', () => {
  it('exports the default context in the agreed shape', () => {
    expect(DEFAULT_WEIGHT_CONTEXT).toEqual({ unit: 'lb', bodyWeightLb: null });
    const unit: WeightUnit = DEFAULT_WEIGHT_CONTEXT.unit;
    expect(['lb', 'kg']).toContain(unit);
  });

  it('has the agreed signature', () => {
    const fn = parseWeight satisfies (text: string | null | undefined, ctx: WeightContext) => ParsedWeight;
    expect(typeof fn).toBe('function');
    expect(fn.length).toBe(2);
    // Both result shapes are assignable, and so is null.
    const absolute: ParsedWeight = { lb: 185, kind: 'absolute' };
    const bodyweight: ParsedWeight = { lb: 170, kind: 'bodyweight' };
    const none: ParsedWeight = null;
    expect([absolute, bodyweight, none]).toHaveLength(3);
  });

  it('reads a bare number as pounds under the default context', () => {
    expect(parseWeight('185', DEFAULT_WEIGHT_CONTEXT)).toEqual({ lb: 185, kind: 'absolute' });
  });
});
