import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { requireUser } from './_lib/auth.js';
import type { ExerciseDefinitionRow } from '../src/lib/db/types.js';

// Exercise library mutations (EXERCISE_LIBRARY_SPEC.md §3). Writes go through
// the service role; every mutation appends to definition_mutations_log.

interface MutationLogEntry {
  definition_name: string;
  diff?: Record<string, unknown>;
}

async function logMutation(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  userId: string,
  operation: 'create' | 'update' | 'archive' | 'unarchive',
  definitionId: string,
  log: MutationLogEntry,
) {
  const { error } = await supabase.from('definition_mutations_log').insert({
    user_id: userId,
    operation,
    definition_id: definitionId,
    definition_name: log.definition_name,
    diff: log.diff,
  });
  if (error) console.error('[api/exercise-definitions] mutation log insert failed:', error.message);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  if (req.method === 'POST') {
    const row = req.body as Partial<ExerciseDefinitionRow> | undefined;
    if (!row || typeof row.id !== 'string' || typeof row.canonical_name !== 'string' || typeof row.category !== 'string') {
      res.status(400).send('Missing required definition fields (id, canonical_name, category)');
      return;
    }

    const { error } = await supabase.from('exercise_definitions').insert({ ...row, user_id: userId });
    if (error) {
      console.error('[api/exercise-definitions] insert failed:', error.message);
      res.status(500).send('Failed to create definition');
      return;
    }

    await logMutation(supabase, userId, 'create', row.id, { definition_name: row.canonical_name });
    res.status(200).json({ id: row.id });
    return;
  }

  if (req.method === 'PATCH') {
    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    if (!id) {
      res.status(400).send('Missing id');
      return;
    }
    const body = req.body as { fields?: Partial<ExerciseDefinitionRow>; log?: MutationLogEntry } | undefined;
    if (!body?.fields || !body.log) {
      res.status(400).send('Missing fields or log');
      return;
    }

    const { data: current, error: fetchErr } = await supabase
      .from('exercise_definitions')
      .select('canonical_name,aliases,archived_at')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (fetchErr || !current) {
      res.status(404).send('Definition not found');
      return;
    }

    const fields = { ...body.fields };
    // Renames auto-append the old canonical name as an alias, so history
    // matching never forks (spec §2.3). Never skip this.
    if (fields.canonical_name && fields.canonical_name !== current.canonical_name) {
      const aliases = new Set([...(fields.aliases ?? current.aliases ?? []), current.canonical_name]);
      aliases.delete(fields.canonical_name);
      fields.aliases = [...aliases];
    }

    const { error } = await supabase
      .from('exercise_definitions')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) {
      console.error('[api/exercise-definitions] update failed:', error.message);
      res.status(500).send('Failed to update definition');
      return;
    }

    const operation =
      'archived_at' in body.fields
        ? (body.fields.archived_at ? 'archive' : 'unarchive')
        : 'update';
    await logMutation(supabase, userId, operation, id, body.log);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
