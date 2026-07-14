import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { requireUser } from './_lib/auth.js';

interface InstanceBody {
  eventId?: string;
  date?: string;
  eventTitle?: string;
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

  const body = req.body as InstanceBody | undefined;
  if (!body?.eventId || !body.date) {
    res.status(400).send('Missing eventId or date');
    return;
  }

  // The exception row attaches to a client-supplied event id — confirm the
  // caller owns that event before touching anything.
  const { data: parent, error: parentErr } = await supabase
    .from('workout_events')
    .select('id')
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

    // Upsert so repeated edits of the same occurrence update one row.
    const { error: exError } = await supabase
      .from('recurring_exceptions')
      .upsert(
        {
          user_id:             userId,
          event_id:            body.eventId,
          skipped_date:        body.date,
          override_date:       date ?? null,
          override_start_time: startTime ?? null,
          override_end_time:   endTime ?? null,
        },
        { onConflict: 'event_id,skipped_date' },
      );

    if (exError) {
      console.error('[api/event-instances] override upsert failed:', exError.message);
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
    });
    if (logError) console.error('[api/event-instances] mutation log insert failed:', logError.message);

    res.status(200).json({ ok: true });
    return;
  }

  const { error: exError } = await supabase
    .from('recurring_exceptions')
    .insert({ user_id: userId, event_id: body.eventId, skipped_date: body.date });

  if (exError) {
    console.error('[api/event-instances] insert failed:', exError.message);
    res.status(500).send('Failed to skip instance');
    return;
  }

  const { error: logError } = await supabase.from('event_mutations_log').insert({
    user_id: userId,
    operation: 'delete_instance',
    event_id: body.eventId,
    event_title: body.eventTitle ?? body.eventId,
    event_date: body.date,
  });
  if (logError) console.error('[api/event-instances] mutation log insert failed:', logError.message);

  res.status(200).json({ ok: true });
}
