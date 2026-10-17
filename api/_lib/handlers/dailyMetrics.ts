import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { ConsentError, postDailyMetrics, readDailyMetrics, type PostBody } from '../services/dailyMetrics.js';
import { sendFailure } from '../services/result.js';

// Apple Health's daily metrics (W16 M3b, services/dailyMetrics.ts).
//
//   POST { provider:'apple', timezone, days:[…1..62] } → { ok, upserted, profileBodyWeightLb? }
//        409 { error:'not-connected' } | 409 { error:'category-off', category }
//   GET  ?start=YYYY-MM-DD&end=YYYY-MM-DD (≤ 400 days) → { days }
//
// POST spends the providerSync bucket (the phone's background delivery is
// what calls it); GET is a read.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
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

  if (!(await enforceRateLimit(supabase, res, userId, req.method === 'POST' ? 'providerSync' : 'reads'))) return;

  try {
    if (req.method === 'GET') {
      const result = await readDailyMetrics(supabase, userId, req.query as { start?: unknown; end?: unknown });
      if (!result.ok) return sendFailure(res, result);
      res.status(200).json(result.value);
      return;
    }
    const result = await postDailyMetrics(supabase, userId, (req.body ?? {}) as PostBody);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json({ ok: true, ...result.value });
  } catch (err) {
    if (err instanceof ConsentError) {
      res.status(409).json(err.body);
      return;
    }
    console.error(`[api/daily-metrics] ${req.method} failed:`, err instanceof Error ? err.message : err);
    res.status(500).send('Failed to handle daily metrics');
  }
}
