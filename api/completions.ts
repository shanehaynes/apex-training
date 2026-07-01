import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

interface CompletionRow {
  event_id: string;
  event_date: string;
  event_type: string;
  event_title: string;
  duration_minutes: number | null;
  is_completed: boolean;
  completed_at: string | null;
  updated_at: string;
}

interface CompletionLogRow {
  event_id: string;
  event_date: string;
  event_type: string;
  event_title: string;
  duration_minutes: number | null;
  action: 'complete' | 'uncomplete';
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

  const body = req.body as { completionRow?: CompletionRow; logRow?: CompletionLogRow } | undefined;
  if (!body?.completionRow || !body.logRow) {
    res.status(400).send('Missing completionRow or logRow');
    return;
  }

  const [{ error: upsertErr }, { error: logErr }] = await Promise.all([
    supabase.from('workout_completions').upsert(body.completionRow),
    supabase.from('workout_completion_log').insert(body.logRow),
  ]);

  if (upsertErr) console.error('[api/completions] upsert failed:', upsertErr.message);
  if (logErr) console.error('[api/completions] log insert failed:', logErr.message);

  if (upsertErr || logErr) {
    res.status(500).send('Failed to record completion');
    return;
  }

  res.status(200).json({ ok: true });
}
