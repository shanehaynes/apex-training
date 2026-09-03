import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { pickAllowed, EVENT_INSERT_COLUMNS, EVENT_PATCH_COLUMNS, EVENT_ID_PATTERN } from '../allowlist.js';
import { purgeTrackedEventData } from '../eventCleanup.js';
import { fail, succeed, type ServiceResult } from './result.js';
import type { Json, TablesInsert, WorkoutEventRow } from '../../../src/lib/db/types.js';

// Calendar event mutations, extracted from api/_lib/handlers/events.ts (W5b)
// so the HTTP handler and the coach's server-side tool executors share one
// implementation. Every function takes the verified user id and scopes its
// writes by it; auth, rate limits and the AI cap stay with the callers.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export type TriggeredBy = 'ai' | 'user';

export interface EventMutationLogEntry {
  event_title: string;
  event_date?: string;
  diff?: Json;
  /** Omitted → the DB default ('ai'); UI-driven edits send 'user'. */
  triggered_by?: TriggeredBy;
}

export async function logEventMutation(
  supabase: Admin,
  userId: string,
  operation: 'create' | 'update' | 'delete',
  eventId: string,
  log: EventMutationLogEntry,
): Promise<void> {
  const { error } = await supabase.from('event_mutations_log').insert({
    user_id: userId,
    operation,
    event_id: eventId,
    event_title: log.event_title,
    event_date: log.event_date,
    diff: log.diff,
    // Runtime guard, not just the type: the entry arrives in request bodies.
    ...(log.triggered_by === 'ai' || log.triggered_by === 'user'
      ? { triggered_by: log.triggered_by }
      : {}),
  });
  if (error) console.error('[api/events] mutation log insert failed:', error.message);
}

/** Insert one event row (snake_case, allowlisted) and log it. */
export async function createEvent(
  supabase: Admin,
  userId: string,
  row: Record<string, unknown>,
  triggeredBy: TriggeredBy | undefined,
): Promise<ServiceResult<{ id: string }>> {
  if (typeof row.id !== 'string' || typeof row.title !== 'string') {
    return fail(400, 'Missing required event fields');
  }
  // Ids reach the ICS feed and occurrence-id composition — enforce the
  // slug shape here so a CRLF or oversized id never lands in the table.
  if (!EVENT_ID_PATTERN.test(row.id)) {
    return fail(400, 'Invalid event id — use letters, digits, hyphens, underscores (max 128)');
  }
  if (row.title.length > 300) {
    return fail(400, 'Event title is too long');
  }

  const { picked, rejected } = pickAllowed(row, EVENT_INSERT_COLUMNS);
  if (rejected.length > 0) {
    console.error('[api/events] insert rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown event fields: ${rejected.join(', ')}`);
  }

  const { error } = await supabase
    .from('workout_events')
    .insert({ ...picked, user_id: userId } as TablesInsert<'workout_events'>);
  if (error) {
    console.error('[api/events] insert failed:', error.message);
    return fail(500, 'Failed to create event');
  }

  await logEventMutation(supabase, userId, 'create', row.id, {
    event_title: row.title,
    event_date: typeof row.date === 'string' ? row.date : undefined,
    triggered_by: triggeredBy,
  });
  return succeed({ id: row.id });
}

/** Patch one event the caller owns (allowlisted fields) and log it. */
export async function updateEvent(
  supabase: Admin,
  userId: string,
  id: string,
  fields: Record<string, unknown>,
  log: EventMutationLogEntry,
): Promise<ServiceResult> {
  const { picked, rejected } = pickAllowed(fields, EVENT_PATCH_COLUMNS);
  if (rejected.length > 0) {
    console.error('[api/events] update rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown event fields: ${rejected.join(', ')}`);
  }

  // .select('id') exposes the affected rows: Supabase reports no error on
  // a 0-row update, which used to return 200 and write a phantom audit
  // entry for someone else's (or a mistyped) id.
  const { data: updated, error } = await supabase
    .from('workout_events')
    .update({ ...picked, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select('id');
  if (error) {
    console.error('[api/events] update failed:', error.message);
    return fail(500, 'Failed to update event');
  }
  if (!updated || updated.length === 0) return fail(404, 'Event not found');

  await logEventMutation(supabase, userId, 'update', id, log);
  return succeed(undefined);
}

/** Delete one event the caller owns, purge a one-off's logs, and log it. */
export async function deleteEvent(
  supabase: Admin,
  userId: string,
  id: string,
  log: EventMutationLogEntry | undefined,
): Promise<ServiceResult> {
  const { data: deleted, error } = await supabase
    .from('workout_events')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select('id,is_recurring');
  if (error) {
    console.error('[api/events] delete failed:', error.message);
    return fail(500, 'Failed to delete event');
  }
  if (!deleted || deleted.length === 0) return fail(404, 'Event not found');

  // A one-off event has exactly one occurrence, logged under the bare id —
  // deleting the workout deletes what was logged against it. A recurring
  // series keeps its logs: the whole series disappearing from the calendar
  // must not erase months of sessions that genuinely happened.
  if (!(deleted[0] as Pick<WorkoutEventRow, 'is_recurring'>)?.is_recurring) {
    await purgeTrackedEventData(supabase, userId, [id]);
  }

  await logEventMutation(supabase, userId, 'delete', id, log ?? { event_title: id });
  return succeed(undefined);
}
