// Parse the free-text reps/duration strings the coach emits ("5 each leg",
// "8-10", "30 sec", "AMRAP"). Unparseable strings are surfaced, never dropped
// — a checker that silently skips what it can't read reports false passes.

export type ParsedReps =
  | { kind: 'reps'; min: number; max: number; perSide: boolean }
  | { kind: 'time'; seconds: number; perSide: boolean }
  | { kind: 'amrap' }
  | { kind: 'unparseable'; raw: string };

const PER_SIDE_RE = /\beach\b|\bper\s+(side|leg|arm)\b/i;
const RANGE_RE = /^(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)/;
const NUMBER_RE = /^(\d+(?:\.\d+)?)/;
const TIME_UNIT_RE = /\b(sec|secs|second|seconds|s|min|mins|minute|minutes|m)\b/i;

function timeMultiplier(unit: string): number {
  return /^m/i.test(unit) ? 60 : 1;
}

export function parseReps(raw: string | undefined | null): ParsedReps {
  if (!raw || !raw.trim()) return { kind: 'unparseable', raw: raw ?? '' };
  const text = raw.trim();
  const perSide = PER_SIDE_RE.test(text);

  if (/\bamrap\b|\bmax reps\b|\bto failure\b|\bmax\b/i.test(text)) return { kind: 'amrap' };

  const unitMatch = text.match(TIME_UNIT_RE);
  const range = text.match(RANGE_RE);
  if (range) {
    const min = parseFloat(range[1]);
    const max = parseFloat(range[2]);
    if (unitMatch) {
      const mult = timeMultiplier(unitMatch[1]);
      // Use the midpoint for timed ranges ("20-30 sec").
      return { kind: 'time', seconds: ((min + max) / 2) * mult, perSide };
    }
    return { kind: 'reps', min, max, perSide };
  }

  const single = text.match(NUMBER_RE);
  if (single) {
    const n = parseFloat(single[1]);
    if (unitMatch) return { kind: 'time', seconds: n * timeMultiplier(unitMatch[1]), perSide };
    return { kind: 'reps', min: n, max: n, perSide };
  }

  return { kind: 'unparseable', raw };
}

/** Midpoint rep count (×2 for per-side) — the rep-volume metric input. AMRAP counts as 0 with a flag upstream. */
export function repVolume(parsed: ParsedReps): number | null {
  if (parsed.kind === 'reps') {
    const mid = (parsed.min + parsed.max) / 2;
    return parsed.perSide ? mid * 2 : mid;
  }
  return null;
}
