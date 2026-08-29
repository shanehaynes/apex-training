import type { DisplayUnit } from './spec';

// ─── Length units ────────────────────────────────────────────────────────────
// The repo-wide rule stands: free-text quantities are never silently
// converted across units (review stats sum per-unit maps). Analytics tiles
// add ONE opt-in exception: a tile with displayUnit set converts the four
// known length units deterministically, and everything it cannot convert is
// COUNTED and surfaced ("3 entries excluded"), never dropped silently.

/** Exact by definition (international mile / foot). Same constants as the sync path. */
const METERS_PER: Record<DisplayUnit, number> = {
  m: 1,
  km: 1000,
  mi: 1609.344,
  ft: 0.3048,
};

export function isDisplayUnit(unit: string): unit is DisplayUnit {
  return unit in METERS_PER;
}

/** Convert between known length units; null when the source unit is unknown. */
export function convertLength(value: number, fromUnit: string, toUnit: DisplayUnit): number | null {
  if (!isDisplayUnit(fromUnit)) return null;
  return (value * METERS_PER[fromUnit]) / METERS_PER[toUnit];
}

export interface QuantityEntry {
  value: number;
  /** Normalized unit from parseQuantity ('' for bare numbers). */
  unit: string;
}

export interface UnitResolution {
  /** Entries expressed in `unit`, in input order (paired with their sources by index elsewhere). */
  kept: number[];
  /** Which entries were kept (same length as the input). */
  keptMask: boolean[];
  /** The unit every kept value is in ('' possible only without displayUnit). */
  unit: string;
  excludedOtherUnit: number;
  excludedUnparseable: number;
}

/**
 * Resolve a series' mixed-unit entries to one charted unit.
 * - displayUnit set: convert every known-unit entry; unknown units are excluded.
 * - no displayUnit: chart the dominant unit (most entries, ties alphabetical —
 *   the dominantHighlight rule from review stats); other units are excluded.
 * `unparseable` counts entries whose text never yielded a quantity at all —
 * the caller passes them as nulls in the entry list.
 */
export function resolveUnits(
  entries: Array<QuantityEntry | null>,
  displayUnit: DisplayUnit | undefined,
): UnitResolution {
  const parsed = entries.filter((e): e is QuantityEntry => e !== null);
  const unparseable = entries.length - parsed.length;

  if (displayUnit) {
    const kept: number[] = [];
    const keptMask = entries.map(() => false);
    let excluded = 0;
    entries.forEach((e, i) => {
      if (!e) return;
      const converted = convertLength(e.value, e.unit, displayUnit);
      if (converted === null) { excluded += 1; return; }
      kept.push(converted);
      keptMask[i] = true;
    });
    return { kept, keptMask, unit: displayUnit, excludedOtherUnit: excluded, excludedUnparseable: unparseable };
  }

  if (parsed.length === 0) {
    return { kept: [], keptMask: entries.map(() => false), unit: '', excludedOtherUnit: 0, excludedUnparseable: unparseable };
  }

  const countByUnit = new Map<string, number>();
  for (const e of parsed) countByUnit.set(e.unit, (countByUnit.get(e.unit) ?? 0) + 1);
  const dominant = [...countByUnit.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

  const kept: number[] = [];
  const keptMask = entries.map(() => false);
  let excluded = 0;
  entries.forEach((e, i) => {
    if (!e) return;
    if (e.unit !== dominant) { excluded += 1; return; }
    kept.push(e.value);
    keptMask[i] = true;
  });
  return { kept, keptMask, unit: dominant, excludedOtherUnit: excluded, excludedUnparseable: unparseable };
}
