import type { WorkoutEventRow } from '../db/types';

// Pure helpers for the starter-template copy (api/template-copy.ts).
// Definitions are cloned keeping their ids — exercise_definitions is keyed
// (user_id, id) since phase9 — so the definitionId references inside the
// event JSONB stay valid as-is; only events need fresh globally-unique ids.

interface ExerciseEntryLike {
  definitionId?: unknown;
}

/**
 * Every exercise-library id referenced by the events' warmup / exercises /
 * cooldown JSONB arrays (camelCase payloads), deduplicated.
 */
export function collectDefinitionIds(rows: WorkoutEventRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const section of [row.warmup, row.exercises, row.cooldown]) {
      if (!Array.isArray(section)) continue;
      for (const entry of section) {
        const definitionId = (entry as ExerciseEntryLike | null)?.definitionId;
        if (typeof definitionId === 'string' && definitionId) ids.add(definitionId);
      }
    }
  }
  return [...ids];
}

/**
 * Re-identify an event row for the target user: fresh id and owner, DB-owned
 * timestamps dropped so insert defaults restamp them.
 */
export function cloneEventRow(
  row: WorkoutEventRow,
  newId: string,
  userId: string,
): Omit<WorkoutEventRow, 'created_at' | 'updated_at'> {
  const { created_at: _created, updated_at: _updated, ...rest } = row;
  return { ...rest, id: newId, user_id: userId };
}
