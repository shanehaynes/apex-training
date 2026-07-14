import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { requireUser } from './_lib/auth.js';
import type { WorkoutEventRow } from '../src/lib/db/types.js';

interface MutationLogEntry {
  event_title: string;
  event_date?: string;
  diff?: Record<string, unknown>;
  /** Omitted → the DB default ('ai'); UI-driven edits send 'user'. */
  triggered_by?: string;
}

async function logMutation(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  userId: string,
  operation: 'create' | 'update' | 'delete',
  eventId: string,
  log: MutationLogEntry,
) {
  const { error } = await supabase.from('event_mutations_log').insert({
    user_id: userId,
    operation,
    event_id: eventId,
    event_title: log.event_title,
    event_date: log.event_date,
    diff: log.diff,
    ...(log.triggered_by ? { triggered_by: log.triggered_by } : {}),
  });
  if (error) console.error('[api/events] mutation log insert failed:', error.message);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  if (req.method === 'POST') {
    const row = req.body as Omit<WorkoutEventRow, never> | undefined;
    if (!row || typeof row.id !== 'string' || typeof row.title !== 'string') {
      res.status(400).send('Missing required event fields');
      return;
    }

    const { error } = await supabase.from('workout_events').insert({ ...row, user_id: userId });
    if (error) {
      console.error('[api/events] insert failed:', error.message);
      res.status(500).send('Failed to create event');
      return;
    }

    await logMutation(supabase, userId, 'create', row.id, { event_title: row.title, event_date: row.date });
    res.status(200).json({ id: row.id });
    return;
  }

  const id = typeof req.query.id === 'string' ? req.query.id : undefined;
  if (!id) {
    res.status(400).send('Missing id');
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body as { fields?: Partial<WorkoutEventRow>; log?: MutationLogEntry } | undefined;
    if (!body?.fields || !body.log) {
      res.status(400).send('Missing fields or log');
      return;
    }

    // id and user_id are identity, never patchable fields.
    const { id: _id, user_id: _uid, ...fields } = body.fields as Partial<WorkoutEventRow> & { user_id?: string };

    const { error } = await supabase
      .from('workout_events')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[api/events] update failed:', error.message);
      res.status(500).send('Failed to update event');
      return;
    }

    await logMutation(supabase, userId, 'update', id, body.log);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const body = req.body as { log?: MutationLogEntry } | undefined;

    const { error } = await supabase.from('workout_events').delete().eq('id', id).eq('user_id', userId);
    if (error) {
      console.error('[api/events] delete failed:', error.message);
      res.status(500).send('Failed to delete event');
      return;
    }

    await logMutation(supabase, userId, 'delete', id, body?.log ?? { event_title: id });
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
