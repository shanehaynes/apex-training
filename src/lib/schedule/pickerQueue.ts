import type { Exercise, ExerciseDefinition } from '../../types/workout';
import { entryFromDefinition, uniqueEntryId } from './definitions';

/**
 * A pick waiting in the exercise picker's "Adding" list. The key is the
 * row's own, so the same movement can be queued twice (two holds in one
 * warm-up) and either copy removed alone.
 */
export interface QueuedPick {
  key: number;
  def: ExerciseDefinition;
}

export function enqueue(queue: QueuedPick[], def: ExerciseDefinition): QueuedPick[] {
  const key = queue.reduce((max, p) => Math.max(max, p.key), 0) + 1;
  return [...queue, { key, def }];
}

export function dequeue(queue: QueuedPick[], key: number): QueuedPick[] {
  return queue.filter(p => p.key !== key);
}

/**
 * Section entries for several picks at once, in pick order. Each id avoids
 * the existing ones and the ids handed out before it in the same batch, so
 * the same movement picked twice still gets two entries.
 */
export function entriesFromDefinitions(defs: ExerciseDefinition[], existingIds: Iterable<string>): Exercise[] {
  const taken = [...existingIds];
  return defs.map(def => {
    const entry = entryFromDefinition(def, uniqueEntryId(def.id, taken));
    taken.push(entry.id);
    return entry;
  });
}
