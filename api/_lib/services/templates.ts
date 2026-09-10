import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { pickAllowed, WORKOUT_TEMPLATE_COLUMNS, EVENT_ID_PATTERN } from '../allowlist.js';
import { normalizeSectionColumns } from './supersets.js';
import { fail, succeed, type ServiceResult } from './result.js';
import type { TablesInsert } from '../../../src/lib/db/types.js';

// The workout library (phase 33), extracted from api/_lib/handlers/
// workoutTemplates.ts (W7) so the HTTP door and the builder's server-side
// Apply (api/_lib/services/workoutDraft.ts) share one implementation. Upserts
// are scoped to (user_id, id) — the caller reuses an existing template's id
// for same-title saves, so "save again" overwrites instead of duplicating.
// Templates are never hard-deleted (workout-level score history keys on the
// template id): archive is the only other write.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export async function upsertTemplate(
  supabase: Admin,
  userId: string,
  row: Record<string, unknown>,
): Promise<ServiceResult<{ id: string }>> {
  if (
    typeof row.id !== 'string' || !EVENT_ID_PATTERN.test(row.id) ||
    typeof row.title !== 'string' || !row.title.trim() ||
    typeof row.type !== 'string'
  ) {
    return fail(400, 'Missing required template fields');
  }

  const { picked, rejected } = pickAllowed(row, WORKOUT_TEMPLATE_COLUMNS);
  if (rejected.length > 0) {
    console.error('[api/workout-templates] upsert rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown template fields: ${rejected.join(', ')}`);
  }

  // Conflict target is (user_id, id), never a global id: a forged id owned
  // by another user finds no conflict in this user's partition and dies on
  // the PK instead of overwriting the other user's row.
  const { error } = await supabase
    .from('workout_templates')
    .upsert(
      { ...normalizeSectionColumns(picked), user_id: userId, updated_at: new Date().toISOString() } as TablesInsert<'workout_templates'>,
      { onConflict: 'user_id,id' },
    );
  if (error) {
    console.error('[api/workout-templates] upsert failed:', error.message);
    return fail(500, 'Failed to save template');
  }
  return succeed({ id: row.id });
}

/** Archive (timestamp) or restore (null) one template the caller owns. */
export async function archiveTemplate(
  supabase: Admin,
  userId: string,
  id: string,
  archivedAt: string | null,
): Promise<ServiceResult<{ id: string }>> {
  const { error, count } = await supabase
    .from('workout_templates')
    .update({ archived_at: archivedAt, updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('user_id', userId)
    .eq('id', id);
  if (error) {
    console.error('[api/workout-templates] archive failed:', error.message);
    return fail(500, 'Failed to update template');
  }
  if (!count) return fail(404, 'Template not found');
  return succeed({ id });
}
