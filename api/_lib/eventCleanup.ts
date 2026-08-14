import { getSupabaseAdmin } from './supabaseAdmin.js';

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

// Everything keyed by the event_id convention (`${baseId}__${date}` for
// recurring occurrences, the bare id otherwise). The append-only audit tables
// — event_mutations_log, workout_completion_log — are deliberately absent:
// they record that the delete happened. provider_activity_imports stays too,
// so a deleted COROS import isn't re-created by the next sync.
const TRACKED_TABLES = [
  'workout_sessions',
  'workout_set_logs',
  'workout_cardio_logs',
  'workout_completions',
  'activity_streams',
] as const;

/**
 * Delete everything logged against workouts that no longer exist. Ids are
 * matched exactly, never by LIKE prefix: event ids may contain underscores
 * (EVENT_ID_PATTERN allows them) and `_` is a LIKE wildcard, so a prefix
 * match could reach a neighbouring event's rows.
 *
 * Best-effort by design — the caller has already deleted the event, and a
 * failure here must not turn a successful delete into a 500. Failures are
 * logged for follow-up instead.
 */
export async function purgeTrackedEventData(
  supabase: Admin,
  userId: string,
  eventIds: string[],
): Promise<void> {
  if (!eventIds.length) return;
  await Promise.all(TRACKED_TABLES.map(async table => {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('user_id', userId)
      .in('event_id', eventIds);
    if (error) console.error(`[api] purge of ${table} failed for ${eventIds.join(', ')}:`, error.message);
  }));
}
