import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

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

  const body = req.body as { eventId?: string; date?: string; eventTitle?: string } | undefined;
  if (!body?.eventId || !body.date) {
    res.status(400).send('Missing eventId or date');
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
