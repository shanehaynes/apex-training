import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { pickAllowed, DEFINITION_INSERT_COLUMNS, DEFINITION_PATCH_COLUMNS } from '../allowlist.js';
import { fail, succeed, type ServiceResult } from './result.js';
import type { ExerciseDefinitionRow, Json, TablesInsert } from '../../../src/lib/db/types.js';
import type { TriggeredBy } from './events.js';

// Exercise library mutations (EXERCISE_LIBRARY_SPEC.md §3), extracted from
// api/_lib/handlers/exerciseDefinitions.ts (W5b). Every mutation appends to
// definition_mutations_log.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export interface DefinitionMutationLogEntry {
  definition_name: string;
  diff?: Json;
  /** Omitted → the DB default ('ai'); UI-driven edits send 'user'. */
  triggered_by?: TriggeredBy;
}

async function logDefinitionMutation(
  supabase: Admin,
  userId: string,
  operation: 'create' | 'update' | 'archive' | 'unarchive',
  definitionId: string,
  log: DefinitionMutationLogEntry,
): Promise<void> {
  const { error } = await supabase.from('definition_mutations_log').insert({
    user_id: userId,
    operation,
    definition_id: definitionId,
    definition_name: log.definition_name,
    diff: log.diff,
    // Runtime guard, not just the type: the entry arrives in request bodies.
    ...(log.triggered_by === 'ai' || log.triggered_by === 'user'
      ? { triggered_by: log.triggered_by }
      : {}),
  });
  if (error) console.error('[api/exercise-definitions] mutation log insert failed:', error.message);
}

export async function createDefinition(
  supabase: Admin,
  userId: string,
  row: Record<string, unknown>,
  triggeredBy: TriggeredBy | undefined,
): Promise<ServiceResult<{ id: string }>> {
  if (typeof row.id !== 'string' || typeof row.canonical_name !== 'string' || typeof row.category !== 'string') {
    return fail(400, 'Missing required definition fields (id, canonical_name, category)');
  }
  const { picked, rejected } = pickAllowed(row, DEFINITION_INSERT_COLUMNS);
  if (rejected.length > 0) {
    console.error('[api/exercise-definitions] insert rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown definition fields: ${rejected.join(', ')}`);
  }

  const { error } = await supabase
    .from('exercise_definitions')
    .insert({ ...picked, user_id: userId } as TablesInsert<'exercise_definitions'>);
  if (error) {
    console.error('[api/exercise-definitions] insert failed:', error.message);
    return fail(500, 'Failed to create definition');
  }

  await logDefinitionMutation(supabase, userId, 'create', row.id, {
    definition_name: row.canonical_name,
    triggered_by: triggeredBy,
  });
  return succeed({ id: row.id });
}

export async function updateDefinition(
  supabase: Admin,
  userId: string,
  id: string,
  fields: Record<string, unknown>,
  log: DefinitionMutationLogEntry,
): Promise<ServiceResult> {
  const { data: current, error: fetchErr } = await supabase
    .from('exercise_definitions')
    .select('canonical_name,aliases,archived_at')
    .eq('id', id)
    .eq('user_id', userId)
    .single();
  if (fetchErr || !current) return fail(404, 'Definition not found');

  const { picked, rejected } = pickAllowed(fields, DEFINITION_PATCH_COLUMNS);
  if (rejected.length > 0) {
    console.error('[api/exercise-definitions] update rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown definition fields: ${rejected.join(', ')}`);
  }

  const patch = picked as Partial<ExerciseDefinitionRow>;
  // Renames auto-append the old canonical name as an alias, so history
  // matching never forks (spec §2.3). Never skip this.
  if (patch.canonical_name && patch.canonical_name !== current.canonical_name) {
    const aliases = new Set([...(patch.aliases ?? current.aliases ?? []), current.canonical_name]);
    aliases.delete(patch.canonical_name);
    patch.aliases = [...aliases];
  }

  const { error } = await supabase
    .from('exercise_definitions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId);
  if (error) {
    console.error('[api/exercise-definitions] update failed:', error.message);
    return fail(500, 'Failed to update definition');
  }

  const operation =
    'archived_at' in fields
      ? (fields.archived_at ? 'archive' : 'unarchive')
      : 'update';
  await logDefinitionMutation(supabase, userId, operation, id, log);
  return succeed(undefined);
}
