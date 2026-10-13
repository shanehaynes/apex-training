// ─── Weight entry ─────────────────────────────────────────────────────────────
// Contract stub (phase55): the shape the weight-units lane fills in. Nothing
// calls parseWeight yet; the test beside it pins the exports and signature
// so the implementation and its callers can land independently.
//
// Stored weights are always pounds. `unit` is how the athlete types and
// reads them; `bodyWeightLb` makes "BW" / "BW+25" resolvable.

export type WeightUnit = 'lb' | 'kg';

export interface WeightContext {
  unit: WeightUnit;
  bodyWeightLb: number | null;
}

export type ParsedWeight = { lb: number; kind: 'absolute' | 'bodyweight' } | null;

export const DEFAULT_WEIGHT_CONTEXT: WeightContext = { unit: 'lb', bodyWeightLb: null };

export function parseWeight(text: string | null | undefined, ctx: WeightContext): ParsedWeight {
  void text;
  void ctx;
  throw new Error('not implemented: parseWeight');
}
