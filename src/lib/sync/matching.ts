import type { WorkoutEvent } from '../../types/workout';
import { timeToMinutes } from '../time.js';

// Pure matcher pairing a provider activity (COROS etc.) with the planned
// occurrence it should fill. React-free and I/O-free (expand.ts placement
// philosophy) so the api handler imports it with a .js extension and
// vitest exercises it directly.
//
// A planned occurrence qualifies when it's the same LOCAL day (timezone
// conversion upstream is authoritative — no ±1-day fuzz), type-compatible,
// not already completed (a workout the user tracked by hand is never
// offered for replacement), and not already provider-filled. Greedy: the
// caller iterates activities in start order and adds each fill to
// filledKeys so one occurrence absorbs at most one activity.

export interface MatchableActivity {
  /** Local calendar date (YYYY-MM-DD) after timezone conversion. */
  localDate: string;
  /** Minutes since local midnight; null when the start time is unknown. */
  startMinutes: number | null;
  durationMin: number;
  /** Already mapped through mapSport — an Apex workout type. */
  apexType: WorkoutEvent['type'];
}

export function occurrenceKey(eventId: string, eventDate: string): string {
  return `${eventId}|${eventDate}`;
}

/** climbing ↔ outdoor-climbing accept each other; everything else is exact. */
function typeCompatible(a: WorkoutEvent['type'], b: WorkoutEvent['type']): boolean {
  if (a === b) return true;
  const climbs = new Set(['climbing', 'outdoor-climbing']);
  return climbs.has(a) && climbs.has(b);
}

export function matchActivity(
  activity: MatchableActivity,
  occurrences: WorkoutEvent[],
  completedKeys: ReadonlySet<string>,
  filledKeys: ReadonlySet<string>,
): WorkoutEvent | null {
  const candidates = occurrences.filter(occ =>
    occ.date === activity.localDate
    && typeCompatible(activity.apexType, occ.type)
    && !completedKeys.has(occurrenceKey(occ.id, occ.date))
    && !filledKeys.has(occurrenceKey(occ.id, occ.date)),
  );
  if (candidates.length === 0) return null;

  // timeToMinutes yields Infinity for missing/unparseable planned times;
  // Infinity - Infinity is NaN, so normalize both sides explicitly.
  const startDelta = (occ: WorkoutEvent): number => {
    const planned = timeToMinutes(occ.startTime);
    if (activity.startMinutes === null || !Number.isFinite(planned)) return Number.MAX_SAFE_INTEGER;
    return Math.abs(planned - activity.startMinutes);
  };
  const durationDelta = (occ: WorkoutEvent): number =>
    Math.abs(occ.estimatedDuration - activity.durationMin);

  // Sort is stable, so equal deltas keep expansion order (earliest planned).
  return [...candidates].sort((a, b) =>
    startDelta(a) - startDelta(b) || durationDelta(a) - durationDelta(b),
  )[0];
}
