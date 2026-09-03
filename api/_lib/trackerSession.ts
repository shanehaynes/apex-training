import type { getSupabaseAdmin } from './supabaseAdmin.js';
import { fetchDefinitionRows } from './mcp/data.js';
import type { WorkoutEventRow } from '../../src/lib/db/types.js';
import type { WorkoutEvent } from '../../src/types/workout.js';
import { rowToEvent } from '../../src/lib/schedule/mapping.js';
import { resolveEventExercises, rowToDefinition } from '../../src/lib/schedule/definitions.js';
import { baseIdOf } from '../../src/lib/schedule/occurrence.js';

// Server-side tracker session support. W0 (docs/ios/backend-changes.md)
// adds the event loader that quick-complete needs; W3 adds bootstrap,
// finish-time PR detection and the recap here.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/**
 * The resolved plan for one occurrence: the base row (accepting either the
 * base id or a `${base}__${date}` occurrence id), exercises resolved against
 * the caller's library, re-keyed to the occurrence id and date the tracker
 * logs against. Null when the caller owns no such event.
 */
export async function loadResolvedOccurrence(
  supabase: Admin,
  userId: string,
  eventId: string,
  eventDate: string,
): Promise<WorkoutEvent | null> {
  const [{ data, error }, definitionRows] = await Promise.all([
    supabase.from('workout_events').select('*').eq('user_id', userId).eq('id', baseIdOf(eventId)).maybeSingle(),
    fetchDefinitionRows(supabase, userId),
  ]);
  if (error) throw new Error(`workout_events fetch failed: ${error.message}`);
  if (!data) return null;
  const definitions = new Map(definitionRows.map(r => [r.id, rowToDefinition(r)]));
  const base = resolveEventExercises(rowToEvent(data as WorkoutEventRow), definitions);
  return { ...base, id: eventId, date: eventDate };
}
