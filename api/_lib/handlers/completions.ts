import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import {
  pickAllowed,
  COMPLETION_COLUMNS,
  COMPLETION_LOG_COLUMNS,
  SERVER_STAMPED_COLUMNS,
} from '../allowlist.js';
import { enforceRateLimit } from '../rateLimit.js';
import type { CompletionLogRow, CompletionRow } from '../../../src/lib/db/types.js';

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

  const body = req.body as { completionRow?: CompletionRow; logRow?: CompletionLogRow } | undefined;
  if (!body?.completionRow || !body.logRow) {
    res.status(400).send('Missing completionRow or logRow');
    return;
  }

  // workout_completion_log is the append-only source of truth for analytics,
  // so both row shapes are allowlisted: logged_at/updated_at are stamped
  // server-side and unknown columns are rejected — a caller cannot backdate
  // or fabricate history.
  const completion = pickAllowed(
    body.completionRow as unknown as Record<string, unknown>,
    COMPLETION_COLUMNS,
    SERVER_STAMPED_COLUMNS,
  );
  const log = pickAllowed(
    body.logRow as unknown as Record<string, unknown>,
    COMPLETION_LOG_COLUMNS,
    SERVER_STAMPED_COLUMNS,
  );
  const rejected = [...completion.rejected, ...log.rejected];
  if (rejected.length > 0) {
    console.error('[api/completions] rejected unknown fields:', rejected.join(', '));
    res.status(400).send(`Unknown completion fields: ${rejected.join(', ')}`);
    return;
  }

  if (typeof completion.picked.event_id !== 'string' || typeof completion.picked.event_date !== 'string') {
    res.status(400).send('completionRow needs event_id and event_date');
    return;
  }
  if (log.picked.action !== 'complete' && log.picked.action !== 'uncomplete') {
    res.status(400).send("logRow.action must be 'complete' or 'uncomplete'");
    return;
  }

  const now = new Date().toISOString();
  const [{ error: upsertErr }, { error: logErr }] = await Promise.all([
    supabase
      .from('workout_completions')
      .upsert({ ...completion.picked, user_id: userId, updated_at: now }, { onConflict: 'user_id,event_id' }),
    supabase.from('workout_completion_log').insert({ ...log.picked, user_id: userId }),
  ]);

  if (upsertErr) console.error('[api/completions] upsert failed:', upsertErr.message);
  if (logErr) console.error('[api/completions] log insert failed:', logErr.message);

  if (upsertErr || logErr) {
    res.status(500).send('Failed to record completion');
    return;
  }

  res.status(200).json({ ok: true });
}
