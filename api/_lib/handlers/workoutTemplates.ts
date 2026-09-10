import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { archiveTemplate, upsertTemplate } from '../services/templates.js';
import { sendFailure } from '../services/result.js';
import type { WorkoutTemplateRow } from '../../../src/lib/db/types.js';

// HTTP door onto api/_lib/services/templates.ts: the workout library
// (phase 33), served as /api/workout-templates by the consolidated router
// (_lib/app.ts). POST upserts scoped to (user_id, id); PATCH exists only to
// archive/unarchive. No AI cap or mutation log: the coach has no template
// tools — only the user's Apply writes here (and, for the native client,
// /api/workout-draft through the same service).

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
    const result = await upsertTemplate(supabase, userId, row as Record<string, unknown>);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json(result.value);
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
    const result = await archiveTemplate(supabase, userId, id, archivedAt);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json(result.value);
    return;
  }

  res.status(405).send('Method not allowed');
}
