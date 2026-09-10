import { normalizeSupersets } from '../../../src/lib/schedule/supersets.js';
import type { Exercise } from '../../../src/types/workout.js';

// Superset labels are canonical (A, B, … in order of appearance, adjacent
// runs only, singletons cleared — src/lib/schedule/supersets.ts). The web's
// editor and the coach's draft reducer normalise before they send; a native
// client that edits sections directly should not have to. Every write that
// carries a section column passes through here, so the table never holds a
// label the expander would render wrong (docs/ios/backend-changes.md, W7).

const SECTION_COLUMNS = ['warmup', 'exercises', 'cooldown'] as const;

/** Re-letter the section columns present on a (snake_case) row, in place of nothing else. */
export function normalizeSectionColumns<T extends Record<string, unknown>>(row: T): T {
  let out: Record<string, unknown> | null = null;
  for (const column of SECTION_COLUMNS) {
    const value = row[column];
    if (!Array.isArray(value)) continue;
    const normalized = normalizeSupersets(value as Exercise[]);
    if (normalized === value) continue;
    out ??= { ...row };
    out[column] = normalized;
  }
  return (out ?? row) as T;
}
