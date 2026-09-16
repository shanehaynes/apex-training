import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { pickAllowed, MEAL_INSERT_COLUMNS, MEAL_PATCH_COLUMNS } from '../allowlist.js';
import { fail, succeed, type ServiceResult } from './result.js';
import type { Json, MealMutationLogRow, TablesInsert } from '../../../src/lib/db/types.js';
import type { TriggeredBy } from './events.js';
import {
  FAT_SPLIT_MESSAGE,
  MACRO_LABELS,
  negativeMacroMessage,
  validateFatSplit,
} from '../../../src/lib/nutrition/mapping.js';

// Meal writes (phase 22) + audit trail (phase 23), extracted from
// api/_lib/meals.ts (W5b). The log feeds the daily AI cap.
//
// The composer's own checks run here too (W10): every macro a finite number
// of at least zero, and a fat total never below saturated + trans. The web
// composer refuses before sending; the native one shows this refusal inline,
// so the words are the composer's (src/lib/nutrition/mapping.ts). Before
// this the DB CHECK constraints answered a bad macro with a raw 500.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const FAT_COLUMNS = ['fat_total_g', 'fat_saturated_g', 'fat_trans_g'] as const;

const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** The first macro present in the row that is not a finite number ≥ 0. */
function macroProblem(row: Record<string, unknown>): string | null {
  for (const [column, label] of MACRO_LABELS) {
    if (!(column in row)) continue;
    const value = row[column];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return negativeMacroMessage(label);
  }
  return null;
}

function fatSplitProblem(row: Record<string, unknown>): string | null {
  return validateFatSplit(asNumber(row.fat_total_g), asNumber(row.fat_saturated_g), asNumber(row.fat_trans_g))
    ? null
    : FAT_SPLIT_MESSAGE;
}

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
  const problem = macroProblem(picked) ?? fatSplitProblem(picked);
  if (problem) return fail(400, problem);

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
  const negative = macroProblem(picked);
  if (negative) return fail(400, negative);

  // The split is judged as it will exist after the merge, so a patch that
  // touches any fat column reads the other two first. A patch that touches
  // none cannot break the split and skips the read.
  if (FAT_COLUMNS.some(column => column in picked)) {
    const { data: current, error: readError } = await supabase
      .from('meals')
      .select('fat_total_g, fat_saturated_g, fat_trans_g')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (readError) {
      console.error('[api/meals] read before update failed:', readError.message);
      return fail(500, 'Failed to update meal');
    }
    if (!current) return fail(404, 'Meal not found');
    const merged: Record<string, unknown> = { ...current };
    for (const column of FAT_COLUMNS) if (column in picked) merged[column] = picked[column];
    const split = fatSplitProblem(merged);
    if (split) return fail(400, split);
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
