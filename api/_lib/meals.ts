import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { requireUser } from './auth.js';
import { pickAllowed, MEAL_INSERT_COLUMNS, MEAL_PATCH_COLUMNS } from './allowlist.js';
import { enforceAiMutationCap, enforceRateLimit } from './rateLimit.js';
import type { MealMutationLogRow, MealRow } from '../../src/lib/db/types.js';

// Meal writes (phase 22) + audit trail (phase 23), served from api/events.ts
// behind ?resource=meal rather than as its own function file: the Vercel
// Hobby plan caps a deployment at 12 serverless functions and the repo sits
// exactly at the cap (same frugality as the training-blocks delegate).
// Same shape as api/events.ts: auth → rate limit → allowlist → service-role
// write → mutation log. The log feeds the daily AI cap now that the coach
// has meal tools.

interface MutationLogEntry {
  meal_title: string;
  diff?: Record<string, unknown>;
  /** Omitted → the DB default ('ai'); UI-driven edits send 'user'. */
  triggered_by?: 'ai' | 'user';
}

async function logMutation(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  userId: string,
  operation: MealMutationLogRow['operation'],
  mealId: string,
  log: MutationLogEntry,
) {
  const { error } = await supabase.from('meal_mutations_log').insert({
    user_id: userId,
    operation,
    meal_id: mealId,
    meal_title: log.meal_title,
    diff: log.diff,
    // Runtime guard, not just the type: the entry arrives in request bodies.
    ...(log.triggered_by === 'ai' || log.triggered_by === 'user'
      ? { triggered_by: log.triggered_by }
      : {}),
  });
  if (error) console.error('[api/meals] mutation log insert failed:', error.message);
}

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

    const { picked, rejected } = pickAllowed(row as Record<string, unknown>, MEAL_INSERT_COLUMNS);
    if (rejected.length > 0) {
      console.error('[api/meals] insert rejected unknown fields:', rejected.join(', '));
      res.status(400).send(`Unknown meal fields: ${rejected.join(', ')}`);
      return;
    }

    const { error } = await supabase.from('meals').insert({ ...picked, user_id: userId });
    if (error) {
      console.error('[api/meals] insert failed:', error.message);
      res.status(500).send('Failed to create meal');
      return;
    }

    await logMutation(supabase, userId, 'create', row.id, {
      meal_title: row.title,
      triggered_by: triggeredBy,
    });
    res.status(200).json({ id: row.id });
    return;
  }

  const id = typeof req.query.id === 'string' ? req.query.id : undefined;
  if (!id) {
    res.status(400).send('Missing id');
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body as { fields?: Partial<MealRow>; log?: MutationLogEntry } | undefined;
    if (!body?.fields || !body.log) {
      res.status(400).send('Missing fields or log');
      return;
    }

    if (body.log.triggered_by !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const { picked, rejected } = pickAllowed(body.fields as Record<string, unknown>, MEAL_PATCH_COLUMNS);
    if (rejected.length > 0) {
      console.error('[api/meals] update rejected unknown fields:', rejected.join(', '));
      res.status(400).send(`Unknown meal fields: ${rejected.join(', ')}`);
      return;
    }

    const { error } = await supabase
      .from('meals')
      .update({ ...picked, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[api/meals] update failed:', error.message);
      res.status(500).send('Failed to update meal');
      return;
    }

    await logMutation(supabase, userId, 'update', id, body.log);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const body = req.body as { log?: MutationLogEntry } | undefined;

    if (body?.log?.triggered_by !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const { error } = await supabase.from('meals').delete().eq('id', id).eq('user_id', userId);
    if (error) {
      console.error('[api/meals] delete failed:', error.message);
      res.status(500).send('Failed to delete meal');
      return;
    }

    await logMutation(supabase, userId, 'delete', id, body?.log ?? { meal_title: id });
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
