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

/**
 * Re-date everything logged against an occurrence that moved.
 *
 * expand() pins an occurrence id to the occurrence's ORIGINAL date and then
 * applies override_date to the DISPLAYED date, while logging writes event_date
 * from the displayed date. So rescheduling an occurrence that already has logs
 * leaves the earlier rows behind at the old date under an id that still
 * matches. Nothing filtering on (event_id, event_date) — the tracker,
 * get_workout_detail — can see them, but get_exercise_history, the library
 * stats and the review email bucket on event_date alone, where a stranded row
 * reads as a phantom extra session on the old day.
 *
 * The invariant is that every tracked row for one occurrence shares a single
 * event_date, so the update is unconditional rather than scoped to the date
 * being moved from: it also heals rows an earlier move stranded. Because the
 * invariant holds, the target key is always free and this can never collide
 * with the unique constraints on (user_id, event_id, event_date, …).
 *
 * Best-effort for the same reason as the purge above — the override row is
 * already written, and a failure here must not turn a successful reschedule
 * into a 500.
 */
export async function migrateTrackedEventDate(
  supabase: Admin,
  userId: string,
  eventIds: string[],
  eventDate: string,
): Promise<void> {
  if (!eventIds.length) return;
  await Promise.all(TRACKED_TABLES.map(async table => {
    const { error } = await supabase
      .from(table)
      .update({ event_date: eventDate })
      .eq('user_id', userId)
      .in('event_id', eventIds)
      .neq('event_date', eventDate);
    if (error) console.error(`[api] event_date migrate of ${table} failed for ${eventIds.join(', ')}:`, error.message);
  }));
}
