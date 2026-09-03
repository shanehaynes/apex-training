import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { migrateTrackedEventDate, purgeTrackedEventData, relabelTrackedEventId } from '../eventCleanup.js';
import { pickAllowed, EVENT_INSERT_COLUMNS, EVENT_ID_PATTERN, SERVER_STAMPED_COLUMNS } from '../allowlist.js';
import { makeOccurrenceId } from '../../../src/lib/schedule/occurrence.js';
import { fail, succeed, type ServiceResult } from './result.js';
import type { Json, TablesInsert } from '../../../src/lib/db/types.js';
import type { TriggeredBy } from './events.js';

// Per-occurrence mutations on a recurring series — skip, reschedule, detach —
// extracted from api/_lib/handlers/eventInstances.ts (W5b) so the HTTP
// handler and the coach's server-side executors share one implementation.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export interface InstanceTarget {
  eventId: string;
  date: string;
  eventTitle?: string;
  triggeredBy?: TriggeredBy;
}

export interface InstanceOverrides {
  date?: string;
  startTime?: string;
  endTime?: string;
}

/**
 * Every id anything logged against one occurrence can sit under. Ids follow
 * the expansion convention: every occurrence but the series anchor carries
 * `${baseId}__${date}`; the anchor keeps the bare id, and only the anchor ever
 * does — so both are exact, no date filter needed.
 */
function occurrenceIds(eventId: string, date: string, parentDate: string): string[] {
  const ids = [makeOccurrenceId(eventId, date)];
  if (parentDate === date) ids.push(eventId);
  return ids;
}

/** The exception row attaches to a client-supplied event id — confirm the
 *  caller owns that event before touching anything. */
async function loadParent(supabase: Admin, userId: string, eventId: string): Promise<ServiceResult<{ id: string; date: string }>> {
  const { data: parent, error } = await supabase
    .from('workout_events')
    .select('id,date')
    .eq('id', eventId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[api/event-instances] ownership check failed:', error.message);
    return fail(500, 'Failed to verify event');
  }
  if (!parent) return fail(404, 'Event not found');
  return succeed(parent as { id: string; date: string });
}

async function logInstanceMutation(
  supabase: Admin,
  userId: string,
  operation: 'update_instance' | 'delete_instance',
  target: InstanceTarget,
  eventDate: string,
  diff?: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('event_mutations_log').insert({
    user_id: userId,
    operation,
    event_id: target.eventId,
    event_title: target.eventTitle ?? target.eventId,
    event_date: eventDate,
    ...(diff ? { diff: diff as Json } : {}),
    ...(target.triggeredBy ? { triggered_by: target.triggeredBy } : {}),
  });
  if (error) console.error('[api/event-instances] mutation log insert failed:', error.message);
}

/**
 * "Edit this event only": insert the edited content as a standalone event,
 * skip the occurrence on the series, and relabel anything already logged so
 * a half-tracked session follows.
 */
export async function detachInstance(
  supabase: Admin,
  userId: string,
  target: InstanceTarget,
  row: Record<string, unknown>,
): Promise<ServiceResult<{ id: string }>> {
  const parent = await loadParent(supabase, userId, target.eventId);
  if (!parent.ok) return parent;

  const newId = row.id;
  if (
    typeof newId !== 'string' || !EVENT_ID_PATTERN.test(newId) ||
    // '__' is the occurrence-id separator — baseIdOf would misparse it.
    newId.includes('__') || newId === target.eventId
  ) {
    return fail(400, 'Invalid detached event id');
  }
  const { picked, rejected } = pickAllowed(row, EVENT_INSERT_COLUMNS, SERVER_STAMPED_COLUMNS);
  if (rejected.length > 0) {
    console.error('[api/event-instances] detach rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown event fields: ${rejected.join(', ')}`);
  }

  // A detached occurrence is one concrete day — never recurring itself.
  const { error: insertErr } = await supabase.from('workout_events').insert({
    ...picked,
    id: newId,
    user_id: userId,
    is_recurring: false,
    recurrence_rule: null,
    recurring_frequency: null,
    recurring_days: null,
    recurring_end_date: null,
  } as TablesInsert<'workout_events'>);
  if (insertErr) {
    console.error('[api/event-instances] detach insert failed:', insertErr.message);
    return fail(500, 'Failed to detach instance');
  }

  // The all-NULL exception removes the occurrence from the series. Update-
  // then-insert so an earlier per-occurrence move is overwritten, not kept.
  const skipRow = { override_date: null, override_start_time: null, override_end_time: null };
  const { data: existingSkip, error: skipUpdateErr } = await supabase
    .from('recurring_exceptions')
    .update(skipRow)
    .eq('user_id', userId)
    .eq('event_id', target.eventId)
    .eq('skipped_date', target.date)
    .select('id');
  let skipErr = skipUpdateErr;
  if (!skipUpdateErr && (existingSkip ?? []).length === 0) {
    const { error } = await supabase
      .from('recurring_exceptions')
      .insert({ user_id: userId, event_id: target.eventId, skipped_date: target.date, ...skipRow });
    if (error && error.code !== '23505') skipErr = error;
  }
  if (skipErr) {
    // The standalone row exists but the occurrence still renders — undo the
    // insert rather than leaving the workout visibly duplicated.
    await supabase.from('workout_events').delete().eq('user_id', userId).eq('id', newId);
    console.error('[api/event-instances] detach skip failed:', skipErr.message);
    return fail(500, 'Failed to detach instance');
  }

  const newDate = typeof picked.date === 'string' ? picked.date : target.date;
  await relabelTrackedEventId(
    supabase,
    userId,
    occurrenceIds(target.eventId, target.date, parent.value.date),
    newId,
    newDate,
  );
  await logInstanceMutation(supabase, userId, 'update_instance', target, newDate, {
    occurrence_date: target.date, detached_to: newId,
  });
  return succeed({ id: newId });
}

/** Move one occurrence (date and/or times) via a per-occurrence override. */
export async function rescheduleInstance(
  supabase: Admin,
  userId: string,
  target: InstanceTarget,
  overrides: InstanceOverrides,
): Promise<ServiceResult> {
  const { date, startTime, endTime } = overrides;
  if (date === undefined && startTime === undefined && endTime === undefined) {
    return fail(400, 'Empty overrides');
  }
  const parent = await loadParent(supabase, userId, target.eventId);
  if (!parent.ok) return parent;

  // Update-then-insert instead of upsert: an upsert names a specific
  // unique constraint, and phase25 replaces (event_id, skipped_date) with
  // the user-prefixed (user_id, event_id, skipped_date) — this shape works
  // against both, so code and migration can deploy in either order.
  const overrideRow = {
    override_date:       date ?? null,
    override_start_time: startTime ?? null,
    override_end_time:   endTime ?? null,
  };
  const { data: existing, error: updateErr } = await supabase
    .from('recurring_exceptions')
    .update(overrideRow)
    .eq('user_id', userId)
    .eq('event_id', target.eventId)
    .eq('skipped_date', target.date)
    .select('id');
  let exError = updateErr;
  if (!updateErr && (existing ?? []).length === 0) {
    const { error: insertErr } = await supabase
      .from('recurring_exceptions')
      .insert({ user_id: userId, event_id: target.eventId, skipped_date: target.date, ...overrideRow });
    // 23505 = a concurrent request created the row between our update and
    // insert — apply the overrides to the winner instead of failing.
    if (insertErr?.code === '23505') {
      const { error: retryErr } = await supabase
        .from('recurring_exceptions')
        .update(overrideRow)
        .eq('user_id', userId)
        .eq('event_id', target.eventId)
        .eq('skipped_date', target.date);
      exError = retryErr;
    } else {
      exError = insertErr;
    }
  }
  if (exError) {
    console.error('[api/event-instances] override write failed:', exError.message);
    return fail(500, 'Failed to reschedule instance');
  }

  // A moved workout still happened, so nothing is purged — but the logs have
  // to follow it. The occurrence id stays pinned to the original date, so
  // only event_date drifts, and every read path that buckets on event_date
  // alone would otherwise report a phantom session on the old day.
  await migrateTrackedEventDate(
    supabase,
    userId,
    occurrenceIds(target.eventId, target.date, parent.value.date),
    date ?? target.date,
  );
  await logInstanceMutation(supabase, userId, 'update_instance', target, date ?? target.date, {
    occurrence_date: target.date, overrides,
  });
  return succeed(undefined);
}

/** Remove one occurrence from the series (idempotent) and purge its logs. */
export async function skipInstance(
  supabase: Admin,
  userId: string,
  target: InstanceTarget,
): Promise<ServiceResult> {
  const parent = await loadParent(supabase, userId, target.eventId);
  if (!parent.ok) return parent;

  const { error: exError } = await supabase
    .from('recurring_exceptions')
    .insert({ user_id: userId, event_id: target.eventId, skipped_date: target.date });

  // 23505: the occurrence is already skipped — idempotent success, and no
  // duplicate audit entry for a skip that didn't happen now.
  if (exError?.code === '23505') return succeed(undefined);
  if (exError) {
    console.error('[api/event-instances] insert failed:', exError.message);
    return fail(500, 'Failed to skip instance');
  }

  // The occurrence is gone from the calendar, so anything logged against it
  // goes too.
  await purgeTrackedEventData(supabase, userId, occurrenceIds(target.eventId, target.date, parent.value.date));
  await logInstanceMutation(supabase, userId, 'delete_instance', target, target.date);
  return succeed(undefined);
}
