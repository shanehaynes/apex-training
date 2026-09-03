import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { requireUser } from './auth.js';
import { enforceAiMutationCap, enforceRateLimit } from './rateLimit.js';
import { createMeal, deleteMeal, updateMeal, type MealMutationLogEntry } from './services/meals.js';
import { sendFailure } from './services/result.js';
import type { MealRow } from '../../src/lib/db/types.js';

// Meal writes (phase 22) + audit trail (phase 23), served as /api/meals by
// the consolidated router (_lib/app.ts). HTTP door onto
// api/_lib/services/meals.ts: auth → rate limit → AI cap → service (W5b).

export async function handleMeals(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  if (req.method === 'POST') {
    const { triggered_by, ...row } = (req.body ?? {}) as Partial<MealRow> & { triggered_by?: unknown };
    if (typeof row.id !== 'string' || typeof row.title !== 'string') {
      res.status(400).send('Missing required meal fields');
      return;
    }
    const triggeredBy = triggered_by === 'user' || triggered_by === 'ai' ? triggered_by : undefined;

    // Requests not explicitly user-triggered count against the daily AI cap
    // (the coach path and unlabeled callers — matches the log's 'ai' default).
    if (triggeredBy !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const result = await createMeal(supabase, userId, row as Record<string, unknown>, triggeredBy);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json(result.value);
    return;
  }

  const id = typeof req.query.id === 'string' ? req.query.id : undefined;
  if (!id) {
    res.status(400).send('Missing id');
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body as { fields?: Partial<MealRow>; log?: MealMutationLogEntry } | undefined;
    if (!body?.fields || !body.log) {
      res.status(400).send('Missing fields or log');
      return;
    }
    if (body.log.triggered_by !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const result = await updateMeal(supabase, userId, id, body.fields as Record<string, unknown>, body.log);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const body = req.body as { log?: MealMutationLogEntry } | undefined;
    if (body?.log?.triggered_by !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const result = await deleteMeal(supabase, userId, id, body?.log);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
