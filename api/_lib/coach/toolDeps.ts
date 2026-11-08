import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchExpandedSchedule } from '../mcp/data.js';
import { loadMealsForDate } from '../trackerSession.js';
import { createServerDeps } from './serverDeps.js';
import { applyMemoryCommand } from './memory.js';
import { applyContractEdit } from '../reflection/contract.js';
import { applyEditTimes } from '../trackerSession.js';
import { logEventMutation } from '../services/events.js';
import { baseIdOf, isOccurrenceId, makeOccurrenceId } from '../../../src/lib/schedule/occurrence.js';
import type { CoachToolDeps, SessionTimesEdit } from '../../../src/lib/coach/tools.js';
import type { RecordedSessionTimes } from '../../../src/lib/coach/sessionTimes.js';
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
    getSessionTimes: (eventId: string, date: string) => loadSessionTimes(supabase, userId, eventId, date),
    editSessionTimes: (edit: SessionTimesEdit) => editSessionTimes(supabase, userId, edit),
  };
}

/**
 * The recorded session edit_session_times corrects. A recurring workout's
 * session is keyed by its occurrence id (base__date), so a base id the model
 * took from elsewhere is tried as that too; the exact id wins when both exist.
 */
async function loadSessionTimes(
  supabase: Admin,
  userId: string,
  eventId: string,
  date: string,
): Promise<RecordedSessionTimes | null> {
  const ids = isOccurrenceId(eventId) ? [eventId] : [eventId, makeOccurrenceId(eventId, date)];
  const [sessions, event] = await Promise.all([
    supabase
      .from('workout_sessions')
      .select('event_id, started_at, finished_at, total_duration_seconds')
      .eq('user_id', userId).eq('event_date', date).in('event_id', ids),
    supabase.from('workout_events').select('title').eq('user_id', userId).eq('id', baseIdOf(eventId)).maybeSingle(),
  ]);
  if (sessions.error) throw new Error(`workout_sessions fetch failed: ${sessions.error.message}`);
  const rows = sessions.data ?? [];
  const row = rows.find(r => r.event_id === eventId) ?? rows[0];
  if (!row) return null;
  return {
    eventId: row.event_id,
    title: event.data?.title ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totalDurationSeconds: row.total_duration_seconds,
  };
}

/** applyEditTimes, then the 'ai' row that counts it toward the cap and lists it in Coach activity. */
async function editSessionTimes(
  supabase: Admin,
  userId: string,
  edit: SessionTimesEdit,
): Promise<{ ok: true; totalDurationSeconds: number } | { ok: false; reason: string }> {
  const result = await applyEditTimes(supabase, userId, edit.eventId, edit.date, {
    startedAt: edit.startedAt,
    finishedAt: edit.finishedAt,
  });
  if (!result.ok) return { ok: false, reason: result.message };
  const after = result.value;
  await logEventMutation(supabase, userId, 'update', baseIdOf(edit.eventId), {
    event_title: edit.title,
    event_date: edit.date,
    diff: {
      session_times: {
        before: {
          started_at: edit.before.startedAt,
          finished_at: edit.before.finishedAt,
          total_duration_seconds: edit.before.totalDurationSeconds,
        },
        after: {
          started_at: after.startedAt.toISOString(),
          finished_at: after.finishedAt.toISOString(),
          total_duration_seconds: after.totalDurationSeconds,
        },
      },
    },
    triggered_by: 'ai',
  });
  return { ok: true, totalDurationSeconds: after.totalDurationSeconds };
}
