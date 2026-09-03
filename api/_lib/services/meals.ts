import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { pickAllowed, MEAL_INSERT_COLUMNS, MEAL_PATCH_COLUMNS } from '../allowlist.js';
import { fail, succeed, type ServiceResult } from './result.js';
import type { Json, MealMutationLogRow, TablesInsert } from '../../../src/lib/db/types.js';
import type { TriggeredBy } from './events.js';

// Meal writes (phase 22) + audit trail (phase 23), extracted from
// api/_lib/meals.ts (W5b). The log feeds the daily AI cap.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export interface MealMutationLogEntry {
  meal_title: string;
  diff?: Json;
  /** Omitted → the DB default ('ai'); UI-driven edits send 'user'. */
  triggered_by?: TriggeredBy;
}

async function logMealMutation(
  supabase: Admin,
  userId: string,
  operation: MealMutationLogRow['operation'],
  mealId: string,
  log: MealMutationLogEntry,
): Promise<void> {
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

export async function createMeal(
  supabase: Admin,
  userId: string,
  row: Record<string, unknown>,
  triggeredBy: TriggeredBy | undefined,
): Promise<ServiceResult<{ id: string }>> {
  if (typeof row.id !== 'string' || typeof row.title !== 'string') {
    return fail(400, 'Missing required meal fields');
  }
  const { picked, rejected } = pickAllowed(row, MEAL_INSERT_COLUMNS);
  if (rejected.length > 0) {
    console.error('[api/meals] insert rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown meal fields: ${rejected.join(', ')}`);
  }

  const { error } = await supabase
    .from('meals')
    .insert({ ...picked, user_id: userId } as TablesInsert<'meals'>);
  if (error) {
    console.error('[api/meals] insert failed:', error.message);
    return fail(500, 'Failed to create meal');
  }

  await logMealMutation(supabase, userId, 'create', row.id, { meal_title: row.title, triggered_by: triggeredBy });
  return succeed({ id: row.id });
}

export async function updateMeal(
  supabase: Admin,
  userId: string,
  id: string,
  fields: Record<string, unknown>,
  log: MealMutationLogEntry,
): Promise<ServiceResult> {
  const { picked, rejected } = pickAllowed(fields, MEAL_PATCH_COLUMNS);
  if (rejected.length > 0) {
    console.error('[api/meals] update rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown meal fields: ${rejected.join(', ')}`);
  }

  const { error } = await supabase
    .from('meals')
    .update({ ...picked, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId);
  if (error) {
    console.error('[api/meals] update failed:', error.message);
    return fail(500, 'Failed to update meal');
  }

  await logMealMutation(supabase, userId, 'update', id, log);
  return succeed(undefined);
}

export async function deleteMeal(
  supabase: Admin,
  userId: string,
  id: string,
  log: MealMutationLogEntry | undefined,
): Promise<ServiceResult> {
  const { error } = await supabase.from('meals').delete().eq('id', id).eq('user_id', userId);
  if (error) {
    console.error('[api/meals] delete failed:', error.message);
    return fail(500, 'Failed to delete meal');
  }
  await logMealMutation(supabase, userId, 'delete', id, log ?? { meal_title: id });
  return succeed(undefined);
}
