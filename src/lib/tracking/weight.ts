// ─── Weight entry ─────────────────────────────────────────────────────────────
// One parser for every weight the tracker stores as free text. Stored weights
// are text as typed; every number computed from them (tonnage, PRs, charts)
// goes through parseWeight, so "62.5 kg", "137 lb", "BW+25" and a bare "80"
// under a kg profile all mean what the lifter meant.
//
// Numbers out of here are always POUNDS, kept as a float (never rounded at
// parse — display rounds). `unit` is how the athlete types and reads them;
// `bodyWeightLb` makes "BW" / "BW+25" resolvable and is pounds under every
// unit setting.

export type WeightUnit = 'lb' | 'kg';

export interface WeightContext {
  unit: WeightUnit;
  bodyWeightLb: number | null;
}

export type ParsedWeight = { lb: number; kind: 'absolute' | 'bodyweight' } | null;

export const DEFAULT_WEIGHT_CONTEXT: WeightContext = { unit: 'lb', bodyWeightLb: null };

export const LB_PER_KG = 2.20462;

// Whole-string grammar, case-insensitive: an optional BW, an optional sign, an
// optional number (comma or dot decimal), an optional unit — which may carry a
// trailing period ("185 lbs.", a sloppy stored entry that should keep its PR).
// A bare trailing dot ("185."), an exponent ("1e3") and a leading dot (".5")
// are not numbers; "100kg x 5", "80%", "5.10a" and "heavy" match nothing.
const GRAMMAR = /^\s*(bw)?\s*([+-])?\s*(\d+(?:[.,]\d+)?)?\s*(?:(lb|lbs|kg|kgs)\.?)?\s*$/i;

/** "1,200" is a thousands separator (a comma, exactly three digits, nothing after); any other comma is a decimal. */
function numberOf(text: string): number {
  const normalized = /^\d+,\d{3}$/.test(text) ? text.replace(',', '') : text.replace(',', '.');
  return Number(normalized);
}

function toLb(value: number, unit: WeightUnit): number {
  return unit === 'kg' ? value * LB_PER_KG : value;
}

/**
 * The weight a tracker value means, in pounds:
 *   "185", "185 lb", "185lbs"   → that many pounds
 *   "62.5 kg", "62,5kg"        → 62.5 kg, as a float of pounds
 *   "80" under a kg profile    → 80 kg (a bare number reads in ctx.unit)
 *   "BW", "BW+25", "BW-10kg"   → body weight ± that load, only when the
 *                                 profile holds a positive body weight
 *   "0"                        → { lb: 0 } (classifySet's > 0 gate skips it)
 * Anything else — a sign without BW, "100kg x 5", "80%", "heavy", empty —
 * is null, and the caller treats the row as it always has (reps or duration).
 */
export function parseWeight(text: string | null | undefined, ctx: WeightContext): ParsedWeight {
  if (text == null) return null;
  const match = GRAMMAR.exec(text);
  if (!match) return null;
  const [, bw, sign, digits, rawUnit] = match;
  const unit: WeightUnit = rawUnit ? (rawUnit.toLowerCase().startsWith('kg') ? 'kg' : 'lb') : ctx.unit;

  if (!bw) {
    // A sign, or a unit, without a number is not a weight; neither is a sign
    // without BW ("-10" is not "ten pounds lighter than nothing").
    if (sign || digits === undefined) return null;
    const lb = toLb(numberOf(digits), unit);
    return Number.isFinite(lb) ? { lb, kind: 'absolute' } : null;
  }

  // BW forms resolve only against a positive body weight; otherwise the row
  // behaves exactly as before this parser existed (reps-only PR, no tonnage).
  const body = ctx.bodyWeightLb;
  if (typeof body !== 'number' || !Number.isFinite(body) || body <= 0) return null;
  // "BW" alone, or "BW±N"; "BW25", "BW+" and "BW kg" are malformed.
  if (sign ? digits === undefined : digits !== undefined || rawUnit !== undefined) return null;
  const load = sign ? toLb(numberOf(digits!), unit) : 0;
  const lb = sign === '-' ? body - load : body + load;
  return Number.isFinite(lb) && lb > 0 ? { lb, kind: 'bodyweight' } : null;
}

/** Pounds → the display unit (identity for lb). Never rounds. */
export function lbToUnit(lb: number, unit: WeightUnit): number {
  return unit === 'kg' ? lb / LB_PER_KG : lb;
}

/** A value typed in `unit` → pounds, the stored form. Never rounds. */
export function unitToLb(value: number, unit: WeightUnit): number {
  return toLb(value, unit);
}

/**
 * A pound float as the machine-string number: a value with at most one
 * decimal prints as is (every lb entry an athlete types — 185, 62.5 — stays
 * byte-identical to before the parser), anything longer (a kg conversion,
 * 137.78875) prints rounded to the pound.
 */
export function formatLb(lb: number): string {
  return Math.abs(lb * 10 - Math.round(lb * 10)) < 1e-6 ? String(Math.round(lb * 10) / 10) : String(Math.round(lb));
}

/**
 * The context a profiles row holds: `weight_unit` ('lb' | 'kg', anything
 * else or absent reads as lb) and `body_weight_lb` (a positive number, else
 * null). Both columns can trail this code in production, so an absent key
 * is the default, never an error.
 */
export function weightContextFromProfile(
  row: { weight_unit?: unknown; body_weight_lb?: unknown } | null | undefined,
): WeightContext {
  const body = row?.body_weight_lb;
  return {
    unit: row?.weight_unit === 'kg' ? 'kg' : 'lb',
    bodyWeightLb: typeof body === 'number' && Number.isFinite(body) && body > 0 ? body : null,
  };
}
