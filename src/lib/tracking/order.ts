import type { TrackedSection } from '../db/types';
import type { TrackedSectionGroup } from './plan';

// ─── This sitting's exercise order ────────────────────────────────────────────
// Mid-workout the athlete can reorder exercises ("the rack is free, squat
// first"). The order is this session's alone (workout_sessions.exercise_order,
// phase60): the plan is often a recurring series, and today's order must not
// become every Friday's. Pure, so the server (bootstrap) and the tracker
// apply it the same way.

/** Per section, entry ids in the order the athlete arranged them. */
export type ExerciseOrder = Partial<Record<TrackedSection, string[]>>;

const SECTIONS: readonly TrackedSection[] = ['warmup', 'exercise', 'cooldown'];

/** Bounds a client may send: ids per section, and characters per id. */
export const MAX_ORDER_IDS = 500;
export const MAX_ORDER_ID_LENGTH = 200;

/**
 * The stored or sent value as an ExerciseOrder, or null when it is not one:
 * an object whose keys are tracker sections and whose values are arrays of
 * distinct, non-empty id strings within the bounds above. Anything else —
 * an unknown section, a duplicate id, a number — makes the whole value null,
 * never a partly-trusted order.
 */
export function parseExerciseOrder(value: unknown): ExerciseOrder | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const order: ExerciseOrder = {};
  for (const [key, ids] of Object.entries(value)) {
    if (!SECTIONS.includes(key as TrackedSection)) return null;
    if (!Array.isArray(ids) || ids.length > MAX_ORDER_IDS) return null;
    if (!ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_ORDER_ID_LENGTH)) return null;
    if (new Set(ids).size !== ids.length) return null;
    order[key as TrackedSection] = [...ids] as string[];
  }
  return order;
}

/**
 * Arrange each section by the saved order. Ids the order names come first,
 * in its order; exercises it does not name (planned after the reorder, or
 * added since) follow in the plan's order. Ids it names that are gone are
 * ignored. A group with nothing to change is returned as is.
 */
export function applyExerciseOrder(
  groups: TrackedSectionGroup[],
  order: ExerciseOrder | null | undefined,
): TrackedSectionGroup[] {
  if (!order) return groups;
  return groups.map(group => {
    const ids = order[group.section];
    if (!ids?.length) return group;
    const rank = new Map(ids.map((id, i) => [id, i]));
    const named = group.exercises.filter(t => rank.has(t.exercise.id))
      .sort((a, b) => rank.get(a.exercise.id)! - rank.get(b.exercise.id)!);
    const rest = group.exercises.filter(t => !rank.has(t.exercise.id));
    const exercises = [...named, ...rest];
    return exercises.every((t, i) => t === group.exercises[i]) ? group : { ...group, exercises };
  });
}

/** The order the tracker shows now, every section, for saving. */
export function exerciseOrderOf(groups: TrackedSectionGroup[]): ExerciseOrder {
  const order: ExerciseOrder = {};
  // Distinct ids only: a plan carrying a duplicate entry id would otherwise
  // send an order the server refuses, and every later save with it.
  for (const group of groups) order[group.section] = [...new Set(group.exercises.map(t => t.exercise.id))];
  return order;
}

/**
 * Move one exercise within its section, from one index to another. A move
 * that changes nothing (same place, out of range) returns `groups` itself.
 */
export function moveTrackedExercise(
  groups: TrackedSectionGroup[],
  section: TrackedSection,
  from: number,
  to: number,
): TrackedSectionGroup[] {
  const next = groups.map(group => {
    if (group.section !== section) return group;
    const last = group.exercises.length - 1;
    if (from === to || from < 0 || to < 0 || from > last || to > last) return group;
    const exercises = [...group.exercises];
    const [moved] = exercises.splice(from, 1);
    exercises.splice(to, 0, moved);
    return { ...group, exercises };
  });
  return next.every((group, i) => group === groups[i]) ? groups : next;
}
