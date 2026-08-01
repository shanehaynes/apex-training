// Parse free-text weight strings ("25lb", "10 kg", "BW+25", "bodyweight").

export type ParsedWeight =
  | { kind: 'weight'; lb: number }
  | { kind: 'bodyweight'; extraLb: number }
  | { kind: 'unparseable'; raw: string };

const KG_TO_LB = 2.20462;

const BW_RE = /^(?:bw|bodyweight|body weight)\s*(?:\+\s*(\d+(?:\.\d+)?)\s*(lbs?|kg|kgs)?)?$/i;
const WEIGHT_RE = /^(\d+(?:\.\d+)?)\s*(lbs?|lb|pounds?|kg|kgs|kilos?)?\b/i;

export function parseWeight(raw: string | undefined | null): ParsedWeight {
  if (!raw || !raw.trim()) return { kind: 'unparseable', raw: raw ?? '' };
  // Cap qualifiers ("≤50 lb", "<= 50", "under 50 lb", "max 50", "up to 50")
  // resolve to their bound — the stated ceiling is the comparable load.
  const text = raw.trim().replace(/^(?:≤|<=|<|under|max|up to|about|~)\s*/i, '');

  const bw = text.match(BW_RE);
  if (bw) {
    const extra = bw[1] ? parseFloat(bw[1]) : 0;
    const isKg = bw[2] ? /^k/i.test(bw[2]) : false;
    return { kind: 'bodyweight', extraLb: isKg ? extra * KG_TO_LB : extra };
  }

  const m = text.match(WEIGHT_RE);
  if (m) {
    const n = parseFloat(m[1]);
    const isKg = m[2] ? /^k/i.test(m[2]) : false;
    return { kind: 'weight', lb: isKg ? n * KG_TO_LB : n };
  }

  return { kind: 'unparseable', raw };
}

/** Comparable external load in lb; bodyweight counts its added load only. */
export function externalLoadLb(parsed: ParsedWeight): number | null {
  if (parsed.kind === 'weight') return parsed.lb;
  if (parsed.kind === 'bodyweight') return parsed.extraLb;
  return null;
}
