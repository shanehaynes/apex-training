import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { recordCompletion } from '../services/completions.js';
import { sendFailure } from '../services/result.js';
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

  const result = await recordCompletion(
    supabase,
    userId,
    body.completionRow as unknown as Record<string, unknown>,
    body.logRow as unknown as Record<string, unknown>,
  );
  if (!result.ok) return sendFailure(res, result);
  res.status(200).json({ ok: true });
}
