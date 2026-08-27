import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { pickAllowed, WORKOUT_TEMPLATE_COLUMNS, EVENT_ID_PATTERN } from '../allowlist.js';
import { enforceRateLimit } from '../rateLimit.js';
import type { WorkoutTemplateRow, TablesInsert } from '../../../src/lib/db/types.js';

// Workout templates (phase 33): the workout library, served as
// /api/workout-templates by the consolidated router (_lib/app.ts). POST
// upserts scoped to (user_id, id) — the client reuses an existing template's
// id for same-title saves, so "save again" overwrites instead of
// duplicating. PATCH exists only to archive/unarchive (workout-level score
// history keys on the template id, so templates are never hard-deleted —
// the exercise_definitions precedent). No AI cap or mutation log: the coach
// has no template tools — only the user's Apply writes here.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  if (req.method === 'POST') {
    const row = (req.body ?? {}) as Partial<WorkoutTemplateRow>;
    if (
      typeof row.id !== 'string' || !EVENT_ID_PATTERN.test(row.id) ||
      typeof row.title !== 'string' || !row.title.trim() ||
      typeof row.type !== 'string'
    ) {
      res.status(400).send('Missing required template fields');
      return;
    }

    const { picked, rejected } = pickAllowed(row as Record<string, unknown>, WORKOUT_TEMPLATE_COLUMNS);
    if (rejected.length > 0) {
      console.error('[api/workout-templates] upsert rejected unknown fields:', rejected.join(', '));
      res.status(400).send(`Unknown template fields: ${rejected.join(', ')}`);
      return;
    }

    // Conflict target is (user_id, id), never a global id: a forged id owned
    // by another user finds no conflict in this user's partition and dies on
    // the PK instead of overwriting the other user's row.
    const { error } = await supabase
      .from('workout_templates')
      .upsert(
        { ...picked, user_id: userId, updated_at: new Date().toISOString() } as TablesInsert<'workout_templates'>,
        { onConflict: 'user_id,id' },
      );
    if (error) {
      console.error('[api/workout-templates] upsert failed:', error.message);
      res.status(500).send('Failed to save template');
      return;
    }

    res.status(200).json({ id: row.id });
    return;
  }

  if (req.method === 'PATCH') {
    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    if (!id) {
      res.status(400).send('Missing id');
      return;
    }
    // Archive toggle only — every other field flows through the POST upsert.
    const { archived_at: archivedAt } = (req.body ?? {}) as { archived_at?: unknown };
    if (archivedAt !== null && typeof archivedAt !== 'string') {
      res.status(400).send('archived_at must be a timestamp or null');
      return;
    }

    const { error, count } = await supabase
      .from('workout_templates')
      .update({ archived_at: archivedAt, updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('user_id', userId)
      .eq('id', id);
    if (error) {
      console.error('[api/workout-templates] archive failed:', error.message);
      res.status(500).send('Failed to update template');
      return;
    }
    if (!count) {
      res.status(404).send('Template not found');
      return;
    }

    res.status(200).json({ id });
    return;
  }

  res.status(405).send('Method not allowed');
}
