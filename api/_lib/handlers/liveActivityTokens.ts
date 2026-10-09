import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { forgetLiveActivityTokens, registerLiveActivityToken, type RegisterBody } from '../services/liveActivity.js';
import { sendFailure } from '../services/result.js';

// The iOS app's Live Activity push tokens (phase52, services/liveActivity.ts).
//
//   POST   { eventId, eventDate, token, environment, startedAt }  register one
//   DELETE ?eventId=&eventDate=                                    forget a session's
//
// The app POSTs every token ActivityKit issues for the tracker's activity, and
// DELETEs when it ends the activity itself. The server's own end path deletes
// the rows it pushed to, so a missed DELETE costs one wasted push at most.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
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

  const result = req.method === 'POST'
    ? await registerLiveActivityToken(supabase, userId, (req.body ?? {}) as RegisterBody)
    : await forgetLiveActivityTokens(supabase, userId, req.query as { eventId?: unknown; eventDate?: unknown });
  if (!result.ok) return sendFailure(res, result);
  res.status(200).json({ ok: true });
}
