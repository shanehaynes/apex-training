// The scope decision behind "Save exercises" on a series occurrence, kept
// pure and apart from the editor so it can be tested without a DOM.

import { baseIdOf, isOccurrenceId } from '../../lib/schedule/occurrence';
import type { WorkoutEvent } from '../../types/workout';

/** Where an exercise edit on a series lands — the builder's "This day only" / "Whole series". */
export type SaveScope = 'occurrence' | 'series';

/**
 * Whether saving this event's exercises asks for a scope. Only a series
 * occurrence has one; a one-off saves to itself and never sees the prompt.
 */
export function asksScope(event: Pick<WorkoutEvent, 'id' | 'isRecurring'>): boolean {
  return !!event.isRecurring || isOccurrenceId(event.id);
}

/**
 * The write a scope resolves to. "This day only" on a series is a detach —
 * the occurrence leaves the series as a standalone event carrying the edit
 * (there is no per-occurrence exercise override; detach is the mechanism).
 * Everything else PATCHes the base event, which for a series is every day.
 */
export function saveRequest(
  event: Pick<WorkoutEvent, 'id' | 'isRecurring'>,
  scope?: SaveScope,
): { kind: 'detach'; eventId: string } | { kind: 'update'; id: string } {
  if (scope === 'occurrence' && asksScope(event)) return { kind: 'detach', eventId: event.id };
  return { kind: 'update', id: baseIdOf(event.id) };
}
