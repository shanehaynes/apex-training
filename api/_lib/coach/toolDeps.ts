import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchExpandedSchedule } from '../mcp/data.js';
import { loadMealsForDate } from '../trackerSession.js';
import { createServerDeps } from './serverDeps.js';
import { applyMemoryCommand } from './memory.js';
import { applyContractEdit } from '../reflection/contract.js';
import type { CoachToolDeps } from '../../../src/lib/coach/tools.js';
import type { NewCoachAnnotation } from '../../../src/lib/coach/annotations.js';
import { rowToMeal } from '../../../src/lib/nutrition/mapping.js';
import type { MealRow } from '../../../src/lib/db/types.js';

// The full CoachToolDeps for one confirmed (or, through the MCP connector,
// one directly requested) mutation tool call: the schedule and meal context
// the executors resolve ids against, plus the memory, contract and note
// backends. Shared by api/_lib/handlers/coachTool.ts (the in-app coach's
// confirm cards) and api/_lib/mcp/writeTools.ts (the connector), so both
// doors run the executors src/lib/coach/tools.ts defines — the ones the
// evals test — over the same service-role deps, with attribution ('ai')
// stamped by serverDeps rather than declared by any caller.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export async function buildCoachToolDeps(
  supabase: Admin,
  userId: string,
  today: string,
  input: Record<string, unknown>,
): Promise<CoachToolDeps> {
  const [{ occurrences, definitions }, todayMeals] = await Promise.all([
    fetchExpandedSchedule(supabase, userId, today),
    loadMealsForDate(supabase, userId, today).catch(() => []),
  ]);
  // update_meal validates the fat split against the current row, which
  // need not be today's — fetch the one the call names.
  const meals = [...todayMeals];
  if (typeof input.meal_id === 'string' && !meals.some(m => m.id === input.meal_id)) {
    const { data } = await supabase.from('meals').select('*').eq('user_id', userId).eq('id', input.meal_id).maybeSingle();
    if (data) meals.push(rowToMeal(data as MealRow));
  }
  // The memory backend rides alongside the schedule/meal deps: a confirmed
  // memory write (lane C02) lands as confirmed rows — the click is the
  // confirmation — stamped 'chat'. The service-role client and the
  // verified uid are bound here, never taken from the tool input.
  // The contract and note backends (lane D01) ride the same way: a
  // confirmed propose_contract_edit replaces profiles.coach_contract when
  // its `before` still matches; a confirmed leave_note inserts the
  // coach_annotations row with created_by stamped 'coach' — the same
  // validation the HTTP handler applies, inside the executor.
  return {
    ...createServerDeps(supabase, userId, { today, events: occurrences, definitions, meals }),
    applyMemoryCommand: (cmd: Record<string, unknown>) => applyMemoryCommand(supabase, userId, cmd, { sourceKind: 'chat' }),
    applyContractEdit: (before: string, after: string) => applyContractEdit(supabase, userId, before, after),
    createAnnotation: async (note: NewCoachAnnotation) => {
      const { data, error } = await supabase
        .from('coach_annotations')
        .insert({
          user_id: userId,
          target_kind: note.target_kind,
          target_id: note.target_id,
          body: note.body,
          severity: note.severity ?? 'info',
          created_by: 'coach',
        })
        .select('id')
        .single();
      if (error || !data) {
        console.error('[coach-tool] leave_note insert failed:', error?.message);
        return null;
      }
      return { id: data.id as string };
    },
  };
}
