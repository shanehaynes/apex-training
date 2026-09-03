import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceAiMutationCap, enforceRateLimit } from '../rateLimit.js';
import { createDefinition, updateDefinition, type DefinitionMutationLogEntry } from '../services/definitions.js';
import { sendFailure } from '../services/result.js';
import type { ExerciseDefinitionRow } from '../../../src/lib/db/types.js';

// HTTP door onto api/_lib/services/definitions.ts (EXERCISE_LIBRARY_SPEC.md
// §3). Auth, throttles and body parsing here; the mutations are shared with
// the coach's server-side tool executors (W5b).

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
    const { triggered_by, ...row } = (req.body ?? {}) as Partial<ExerciseDefinitionRow> & { triggered_by?: unknown };
    if (typeof row.id !== 'string' || typeof row.canonical_name !== 'string' || typeof row.category !== 'string') {
      res.status(400).send('Missing required definition fields (id, canonical_name, category)');
      return;
    }
    const triggeredBy = triggered_by === 'user' || triggered_by === 'ai' ? triggered_by : undefined;
    if (triggeredBy !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const result = await createDefinition(supabase, userId, row as Record<string, unknown>, triggeredBy);
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
    const body = req.body as { fields?: Partial<ExerciseDefinitionRow>; log?: DefinitionMutationLogEntry } | undefined;
    if (!body?.fields || !body.log) {
      res.status(400).send('Missing fields or log');
      return;
    }
    if (body.log.triggered_by !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const result = await updateDefinition(supabase, userId, id, body.fields as Record<string, unknown>, body.log);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
