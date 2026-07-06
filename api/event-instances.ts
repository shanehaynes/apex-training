import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

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

  const body = req.body as InstanceBody | undefined;
  if (!body?.eventId || !body.date) {
    res.status(400).send('Missing eventId or date');
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
    .insert({ event_id: body.eventId, skipped_date: body.date });

  if (exError) {
    console.error('[api/event-instances] insert failed:', exError.message);
    res.status(500).send('Failed to skip instance');
    return;
  }

  const { error: logError } = await supabase.from('event_mutations_log').insert({
    operation: 'delete_instance',
    event_id: body.eventId,
    event_title: body.eventTitle ?? body.eventId,
    event_date: body.date,
  });
  if (logError) console.error('[api/event-instances] mutation log insert failed:', logError.message);

  res.status(200).json({ ok: true });
}
