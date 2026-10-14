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
// Pound spellings: lb, lbs, pound, pounds, #. Kilogram spellings: kg, kgs,
// kilo, kilos, kilogram, kilograms. A bare trailing dot ("185."), an exponent
// ("1e3") and a leading dot (".5") are not numbers; "100kg x 5", "80%",
// "5.10a", "185 lbs heavy" and "heavy" match nothing.
const GRAMMAR = /^\s*(bw)?\s*([+-])?\s*(\d+(?:[.,]\d+)?)?\s*(?:(lbs?|pounds?|#|kgs?|kilos?|kilograms?)\.?)?\s*$/i;

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
  // Every kilogram spelling starts with k; every pound spelling does not.
  const unit: WeightUnit = rawUnit ? (rawUnit.toLowerCase().startsWith('k') ? 'kg' : 'lb') : ctx.unit;

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

/**
 * A weight entry as it should be stored once committed: a bare positive
 * number gets the unit it was typed in ("100" → "100 kg" under a kg profile,
 * "185" → "185 lb" under lb), so a later unit switch — which re-declares
 * what bare numbers mean — never reinterprets it. Everything else comes back
 * exactly as given: text that already names a unit, BW forms, "0", a
 * signed number, and anything parseWeight does not read as a weight. The
 * digits are kept as typed ("62,5" → "62,5 kg", "1,200" → "1,200 lb");
 * surrounding whitespace is dropped only when the unit is added.
 */
export function withExplicitUnit(text: string, ctx: WeightContext): string {
  const match = GRAMMAR.exec(text);
  if (!match) return text;
  const [, bw, sign, digits, rawUnit] = match;
  if (bw || sign || rawUnit || digits === undefined) return text;
  const parsed = parseWeight(text, ctx);
  if (!parsed || parsed.kind !== 'absolute' || !(parsed.lb > 0)) return text;
  return `${digits} ${ctx.unit}`;
}

/**
 * A set row as it should be sent: its actual weight through withExplicitUnit.
 * The save path applies this at send time, so a row that leaves before its
 * field's blur (the autosave mid-typing, a tab hide, Finish while focused)
 * still carries its unit. No rewrite when the unit is not known (ctx null)
 * or the row is a climbing pitch, whose weight column holds a grade.
 */
export function rowWithExplicitUnit<T extends { actual_weight: string | null }>(
  row: T,
  ctx: WeightContext | null,
  isClimbing: boolean,
): T {
  if (!ctx || isClimbing || !row.actual_weight) return row;
  const weight = withExplicitUnit(row.actual_weight, ctx);
  return weight === row.actual_weight ? row : { ...row, actual_weight: weight };
}

/**
 * The context to suffix with, or null when the unit is not known: the
 * profile has not loaded, or its row predates the weight_unit column. The
 * lb default there is a guess, and a suffix would store it.
 */
export function knownUnitContext(
  row: { weight_unit?: unknown; body_weight_lb?: unknown } | null | undefined,
): WeightContext | null {
  return row && (row.weight_unit === 'lb' || row.weight_unit === 'kg') ? weightContextFromProfile(row) : null;
}

/** Pounds → the display unit (identity for lb). Never rounds. */
export function lbToUnit(lb: number, unit: WeightUnit): number {
  return unit === 'kg' ? lb / LB_PER_KG : lb;
}

/** A value typed in `unit` → pounds, the stored form. Never rounds. */
export function unitToLb(value: number, unit: WeightUnit): number {
  return toLb(value, unit);
}

/** Whether a value carries at most two decimals (float noise aside). */
function atMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/**
 * A pound float as the machine-string number: a value with at most two
 * decimals prints as is (every lb entry an athlete types — 185, 62.5,
 * 136.25 — stays byte-identical to before the parser), anything longer (a
 * kg conversion, 137.78875) prints rounded to the pound.
 */
export function formatLb(lb: number): string {
  return atMostTwoDecimals(lb) ? String(Math.round(lb * 100) / 100) : String(Math.round(lb));
}

/**
 * A pound float as a person reads it in `unit`. Under lb it is formatLb (as
 * typed up to two decimals, else the whole pound). Under kg a value typed in
 * kg prints as typed (100, 62.25) and a converted one to a tenth (185 lb →
 * 83.9). No unit suffix — the caller labels it.
 */
export function displayWeight(lb: number, unit: WeightUnit): string {
  // Pounds print by the machine-string rule, so the people line and
  // describeRecord agree number for number under lb.
  if (unit === 'lb') return formatLb(lb);
  const value = lbToUnit(lb, unit);
  return atMostTwoDecimals(value) ? String(Math.round(value * 100) / 100) : String(Math.round(value * 10) / 10);
}

// ─── The profile's body-weight field ─────────────────────────────────────────

/** The body-weight field's text: the stored pounds shown in `unit` to a tenth, '' when none. */
export function bodyWeightText(bodyWeightLb: number | null, unit: WeightUnit): string {
  return bodyWeightLb != null ? String(Math.round(lbToUnit(bodyWeightLb, unit) * 10) / 10) : '';
}

export type BodyWeightEdit =
  | { kind: 'unchanged' }
  | { kind: 'invalid' }
  /** Pounds to store, to two decimals; null clears. */
  | { kind: 'save'; lb: number | null };

/**
 * What leaving the body-weight field means. Compared as TEXT against what
 * the field showed, so a blur with no edit never writes — re-deriving pounds
 * from a kg reading rounded to a tenth would never match the stored float.
 * Blank clears; anything else must be a positive number in ctx.unit.
 */
export function bodyWeightEdit(text: string, ctx: WeightContext): BodyWeightEdit {
  const trimmed = text.trim();
  if (trimmed === bodyWeightText(ctx.bodyWeightLb, ctx.unit)) return { kind: 'unchanged' };
  if (trimmed === '') return { kind: 'save', lb: null };
  const typed = /^\d+(?:[.,]\d+)?$/.test(trimmed) ? Number(trimmed.replace(',', '.')) : NaN;
  if (!Number.isFinite(typed) || typed <= 0) return { kind: 'invalid' };
  return { kind: 'save', lb: Math.round(unitToLb(typed, ctx.unit) * 100) / 100 };
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
