import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { requireUser } from './auth.js';
import { pickAllowed, MEAL_FAVORITE_COLUMNS } from './allowlist.js';
import { enforceRateLimit } from './rateLimit.js';
import type { MealFavoriteRow, TablesInsert } from '../../src/lib/db/types.js';
import { rowToFavorite } from '../../src/lib/nutrition/mapping.js';

// Meal favorites (phase 24): user-only meal templates, served as
// /api/meal-favorites by the consolidated router (_lib/app.ts) — a delegate
// rather than its own function file (12-function deploy cap; see the
// training-blocks delegate). GET lists the caller's favorites (W10: the
// phone's composer reads them here, the web still reads PostgREST). POST
// upserts scoped to (user_id, id) — the client reuses an existing
// favorite's id for same-title saves, so "save again" overwrites instead of
// duplicating. No AI cap or mutation log: the coach has no favorite tools,
// and favorites are cosmetic templates, not audit-worthy data.

export async function handleMealFavorites(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  // The list shares the read bucket with the other native-client reads.
  if (!(await enforceRateLimit(supabase, res, userId, req.method === 'GET' ? 'reads' : 'writes'))) return;

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('meal_favorites')
      .select('*')
      .eq('user_id', userId)
      .order('title', { ascending: true });
    if (error) {
      console.error('[api/meal-favorites] list failed:', error.message);
      res.status(500).send('Failed to load favorites');
      return;
    }
    res.status(200).json({ favorites: ((data ?? []) as MealFavoriteRow[]).map(rowToFavorite) });
    return;
  }

  if (req.method === 'POST') {
    const row = (req.body ?? {}) as Partial<MealFavoriteRow>;
    if (typeof row.id !== 'string' || typeof row.title !== 'string') {
      res.status(400).send('Missing required favorite fields');
      return;
    }

    const { picked, rejected } = pickAllowed(row as Record<string, unknown>, MEAL_FAVORITE_COLUMNS);
    if (rejected.length > 0) {
      console.error('[api/meal-favorites] upsert rejected unknown fields:', rejected.join(', '));
      res.status(400).send(`Unknown favorite fields: ${rejected.join(', ')}`);
      return;
    }

    // Conflict target is (user_id, id), never the bare id PK: a forged id
    // owned by another user finds no conflict in this user's partition and
    // dies on the PK instead of overwriting the other user's row.
    const { error } = await supabase
      .from('meal_favorites')
      .upsert(
        { ...picked, user_id: userId, updated_at: new Date().toISOString() } as TablesInsert<'meal_favorites'>,
        { onConflict: 'user_id,id' },
      );
    if (error) {
      console.error('[api/meal-favorites] upsert failed:', error.message);
      res.status(500).send('Failed to save favorite');
      return;
    }

    res.status(200).json({ id: row.id });
    return;
  }

  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    if (!id) {
      res.status(400).send('Missing id');
      return;
    }

    const { error } = await supabase.from('meal_favorites').delete().eq('id', id).eq('user_id', userId);
    if (error) {
      console.error('[api/meal-favorites] delete failed:', error.message);
      res.status(500).send('Failed to delete favorite');
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
