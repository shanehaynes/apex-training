import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceAiMutationCap, enforceRateLimit } from '../rateLimit.js';
import { purgeTrackedEventData } from '../eventCleanup.js';
import { makeOccurrenceId } from '../../../src/lib/schedule/occurrence.js';

interface InstanceBody {
  eventId?: string;
  date?: string;
  eventTitle?: string;
  /** Audit-log attribution; omitted → the DB default ('ai'). */
  triggeredBy?: 'user' | 'ai';
  /** When present, reschedules the occurrence instead of skipping it. */
  overrides?: { date?: string; startTime?: string; endTime?: string };
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
  // goes too. Ids follow the expansion convention: every occurrence but the
  // series anchor carries `${baseId}__${date}`; the anchor keeps the bare id,
  // and only the anchor ever does — so both are exact, no date filter needed.
  const purgeIds = [makeOccurrenceId(body.eventId, body.date)];
  if (parent.date === body.date) purgeIds.push(body.eventId);
  await purgeTrackedEventData(supabase, userId, purgeIds);

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
