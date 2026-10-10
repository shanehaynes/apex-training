import type { ExerciseDefinition, LogField } from '../../types/workout';
import type { TrackedExercise } from './plan';
import { resolvePlannedSets } from './plan.js';

// Which actual inputs a tracked set row offers. Pure so the union rules are
// unit-testable apart from the tracker component.

export type SetField = 'actualWeight' | 'actualReps' | 'actualDuration';

export const FIELD_ORDER: SetField[] = ['actualWeight', 'actualReps', 'actualDuration'];

const LOG_FIELD_TO_SET_FIELD: Record<LogField, SetField> = {
  weight: 'actualWeight',
  reps: 'actualReps',
  duration: 'actualDuration',
};
export const SET_FIELD_TO_LOG_FIELD: Record<SetField, LogField> = {
  actualWeight: 'weight',
  actualReps: 'reps',
  actualDuration: 'duration',
};

/**
 * Which actual inputs an exercise gets: the union of its planned targets, of
 * whatever already carries a value, of the dimensions its library definition
 * is always logged in (plus any added this sitting before that save lands),
 * and — once swapped — of what the replacement movement is normally logged
 * in. Reps is the fallback so every set has something to log.
 *
 * The already-has-a-value rule keeps logged data reachable no matter which
 * plan it was entered against; without it a swap onto a loaded movement
 * (ring dips → single-arm DB press) would have nowhere to put the weight,
 * since the dips it replaced never prescribed one.
 */
export function inputFields(
  tracked: TrackedExercise,
  definition?: ExerciseDefinition,
  addedHere: Iterable<SetField> = [],
): SetField[] {
  // A pitch logs exactly one thing: the grade (stored in the weight column —
  // see resolvePlannedSets).
  if (tracked.exercise.category === 'climbing') return ['actualWeight'];

  const fields = new Set<SetField>();
  const planned = resolvePlannedSets(tracked.exercise);
  if (planned.some(p => p.targetWeight)) fields.add('actualWeight');
  if (planned.some(p => p.targetReps)) fields.add('actualReps');
  if (planned.some(p => p.targetDuration)) fields.add('actualDuration');

  for (const set of tracked.sets) {
    for (const field of FIELD_ORDER) if (set[field]) fields.add(field);
  }

  for (const field of definition?.logFields ?? []) fields.add(LOG_FIELD_TO_SET_FIELD[field]);
  for (const field of addedHere) fields.add(field);

  const swappedTo = tracked.substitutedFrom ? definition : undefined;
  if (tracked.substitutedFrom) {
    if (swappedTo?.defaultDuration) fields.add('actualDuration');
    if (swappedTo?.defaultWeight || swappedTo?.category === 'strength' || !swappedTo) fields.add('actualWeight');
    if (swappedTo?.defaultReps || swappedTo?.category === 'strength' || !swappedTo) fields.add('actualReps');
  }

  if (!fields.size) fields.add('actualReps');
  return FIELD_ORDER.filter(f => fields.has(f));
}
