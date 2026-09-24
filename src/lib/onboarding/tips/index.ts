import type { TipDefinition, TipPriority } from './types.js';
import { CALENDAR_TIPS } from './calendar.js';
import { WORKOUT_TIPS } from './workout.js';
import { TRACKER_TIPS } from './tracker.js';
import { COACH_TIPS } from './coach.js';
import { BUILDER_TIPS } from './builder.js';
import { LIBRARY_MEALS_TIPS } from './library-meals.js';
import { BLOCKS_ANALYTICS_TIPS } from './blocks-analytics.js';
import { PROFILE_TIPS } from './profile.js';
import { COROS_TIPS } from './coros.js';

// The whole tip catalog, one file per feature so parallel lanes never share a
// hunk. Orchestrator-owned: a feature lane edits its own file, never this one.
// Catalog order is the tie-break when two tips of equal priority qualify at
// once, so the order here is deliberate: the things a user meets first, first.

export type { TipDefinition, TipPriority };

export const TIPS = [
  ...CALENDAR_TIPS,
  ...WORKOUT_TIPS,
  ...TRACKER_TIPS,
  ...COACH_TIPS,
  ...BUILDER_TIPS,
  ...LIBRARY_MEALS_TIPS,
  ...BLOCKS_ANALYTICS_TIPS,
  ...PROFILE_TIPS,
  ...COROS_TIPS,
] as const;

/** Every tip id, as a union — `useTip('typo')` is a compile error. */
export type TipId = (typeof TIPS)[number]['id'];

export const TIP_IDS: readonly TipId[] = TIPS.map(t => t.id);

export function isTipId(value: unknown): value is TipId {
  return typeof value === 'string' && (TIP_IDS as readonly string[]).includes(value);
}

export function tipById(id: TipId): TipDefinition {
  // TIPS is exhaustive over TipId by construction.
  return TIPS.find(t => t.id === id)!;
}
