import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceAiMutationCap, enforceRateLimit } from '../rateLimit.js';
import { migrateTrackedEventDate, purgeTrackedEventData, relabelTrackedEventId } from '../eventCleanup.js';
import { pickAllowed, EVENT_INSERT_COLUMNS, EVENT_ID_PATTERN, SERVER_STAMPED_COLUMNS } from '../allowlist.js';
import { makeOccurrenceId } from '../../../src/lib/schedule/occurrence.js';
import type { TablesInsert } from '../../../src/lib/db/types.js';

interface InstanceBody {
  eventId?: string;
  date?: string;
  eventTitle?: string;
  /** Audit-log attribution; omitted → the DB default ('ai'). */
  triggeredBy?: 'user' | 'ai';
  /** When present, reschedules the occurrence instead of skipping it. */
  overrides?: { date?: string; startTime?: string; endTime?: string };
  /** 'detach': materialize the occurrence as the standalone event in `event`. */
  action?: 'detach';
  /** The detached occurrence's new standalone row (snake_case, allowlisted). */
  event?: Record<string, unknown>;
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  const body = req.body as InstanceBody | undefined;
  if (!body?.eventId || !body.date) {
    res.status(400).send('Missing eventId or date');
    return;
  }

  const triggeredBy = body.triggeredBy === 'user' || body.triggeredBy === 'ai' ? body.triggeredBy : undefined;
  if (triggeredBy !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

  // The exception row attaches to a client-supplied event id — confirm the
  // caller owns that event before touching anything.
  const { data: parent, error: parentErr } = await supabase
    .from('workout_events')
    .select('id,date')
    .eq('id', body.eventId)
    .eq('user_id', userId)
    .maybeSingle();
  if (parentErr) {
    console.error('[api/event-instances] ownership check failed:', parentErr.message);
    res.status(500).send('Failed to verify event');
    return;
  }
  if (!parent) {
    res.status(404).send('Event not found');
    return;
  }

  if (body.action === 'detach') {
    // "Edit this event only" on a recurring occurrence: insert the edited
    // content as a standalone event, skip the occurrence on the series, and
    // relabel anything already logged so a half-tracked session follows.
    const row = body.event ?? {};
    const newId = row.id;
    if (
      typeof newId !== 'string' || !EVENT_ID_PATTERN.test(newId) ||
      // '__' is the occurrence-id separator — baseIdOf would misparse it.
      newId.includes('__') || newId === body.eventId
    ) {
      res.status(400).send('Invalid detached event id');
      return;
    }
    const { picked, rejected } = pickAllowed(row, EVENT_INSERT_COLUMNS, SERVER_STAMPED_COLUMNS);
    if (rejected.length > 0) {
      console.error('[api/event-instances] detach rejected unknown fields:', rejected.join(', '));
      res.status(400).send(`Unknown event fields: ${rejected.join(', ')}`);
      return;
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
      res.status(500).send('Failed to detach instance');
      return;
    }

    // The all-NULL exception removes the occurrence from the series. Update-
    // then-insert so an earlier per-occurrence move is overwritten, not kept.
    const skipRow = { override_date: null, override_start_time: null, override_end_time: null };
    const { data: existingSkip, error: skipUpdateErr } = await supabase
      .from('recurring_exceptions')
      .update(skipRow)
      .eq('user_id', userId)
      .eq('event_id', body.eventId)
      .eq('skipped_date', body.date)
      .select('id');
    let skipErr = skipUpdateErr;
    if (!skipUpdateErr && (existingSkip ?? []).length === 0) {
      const { error } = await supabase
        .from('recurring_exceptions')
        .insert({ user_id: userId, event_id: body.eventId, skipped_date: body.date, ...skipRow });
      if (error && error.code !== '23505') skipErr = error;
    }
    if (skipErr) {
      // The standalone row exists but the occurrence still renders — undo the
      // insert rather than leaving the workout visibly duplicated.
      await supabase.from('workout_events').delete().eq('user_id', userId).eq('id', newId);
      console.error('[api/event-instances] detach skip failed:', skipErr.message);
      res.status(500).send('Failed to detach instance');
      return;
    }

    const newDate = typeof picked.date === 'string' ? picked.date : body.date;
    await relabelTrackedEventId(
      supabase,
      userId,
      occurrenceIds(body.eventId, body.date, parent.date),
      newId,
      newDate,
    );

    const { error: logError } = await supabase.from('event_mutations_log').insert({
      user_id: userId,
      operation: 'update_instance',
      event_id: body.eventId,
      event_title: body.eventTitle ?? body.eventId,
      event_date: newDate,
      diff: { occurrence_date: body.date, detached_to: newId },
      ...(triggeredBy ? { triggered_by: triggeredBy } : {}),
    });
    if (logError) console.error('[api/event-instances] mutation log insert failed:', logError.message);

    res.status(200).json({ id: newId });
    return;
  }

  if (body.overrides) {
    const { date, startTime, endTime } = body.overrides;
    if (date === undefined && startTime === undefined && endTime === undefined) {
      res.status(400).send('Empty overrides');
      return;
    }

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
      .eq('event_id', body.eventId)
      .eq('skipped_date', body.date)
      .select('id');
    let exError = updateErr;
    if (!updateErr && (existing ?? []).length === 0) {
      const { error: insertErr } = await supabase
        .from('recurring_exceptions')
        .insert({ user_id: userId, event_id: body.eventId, skipped_date: body.date, ...overrideRow });
      // 23505 = a concurrent request created the row between our update and
      // insert — apply the overrides to the winner instead of failing.
      if (insertErr?.code === '23505') {
        const { error: retryErr } = await supabase
          .from('recurring_exceptions')
          .update(overrideRow)
          .eq('user_id', userId)
          .eq('event_id', body.eventId)
          .eq('skipped_date', body.date);
        exError = retryErr;
      } else {
        exError = insertErr;
      }
    }

    if (exError) {
      console.error('[api/event-instances] override write failed:', exError.message);
      res.status(500).send('Failed to reschedule instance');
      return;
    }

    // A moved workout still happened, so nothing is purged — but the logs have
    // to follow it. The occurrence id stays pinned to the original date, so
    // only event_date drifts, and every read path that buckets on event_date
    // alone would otherwise report a phantom session on the old day.
    await migrateTrackedEventDate(
      supabase,
      userId,
      occurrenceIds(body.eventId, body.date, parent.date),
      date ?? body.date,
    );

    const { error: logError } = await supabase.from('event_mutations_log').insert({
      user_id: userId,
      operation: 'update_instance',
      event_id: body.eventId,
      event_title: body.eventTitle ?? body.eventId,
      event_date: date ?? body.date,
      diff: { occurrence_date: body.date, overrides: body.overrides },
      ...(triggeredBy ? { triggered_by: triggeredBy } : {}),
    });
    if (logError) console.error('[api/event-instances] mutation log insert failed:', logError.message);

    res.status(200).json({ ok: true });
    return;
  }

  const { error: exError } = await supabase
    .from('recurring_exceptions')
    .insert({ user_id: userId, event_id: body.eventId, skipped_date: body.date });

  // 23505: the occurrence is already skipped — idempotent success, and no
  // duplicate audit entry for a skip that didn't happen now.
  if (exError?.code === '23505') {
    res.status(200).json({ ok: true });
    return;
  }
  if (exError) {
    console.error('[api/event-instances] insert failed:', exError.message);
    res.status(500).send('Failed to skip instance');
    return;
  }

  // The occurrence is gone from the calendar, so anything logged against it
  // goes too.
  await purgeTrackedEventData(supabase, userId, occurrenceIds(body.eventId, body.date, parent.date));

  const { error: logError } = await supabase.from('event_mutations_log').insert({
    user_id: userId,
    operation: 'delete_instance',
    event_id: body.eventId,
    event_title: body.eventTitle ?? body.eventId,
    event_date: body.date,
    ...(triggeredBy ? { triggered_by: triggeredBy } : {}),
  });
  if (logError) console.error('[api/event-instances] mutation log insert failed:', logError.message);

  res.status(200).json({ ok: true });
}
