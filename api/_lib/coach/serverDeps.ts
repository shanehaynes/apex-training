import { randomUUID } from 'node:crypto';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import * as events from '../services/events.js';
import * as instances from '../services/eventInstances.js';
import * as definitionsSvc from '../services/definitions.js';
import * as mealsSvc from '../services/meals.js';
import { recordCompletion } from '../services/completions.js';
import { quickCompletePlan } from '../trackerSession.js';
import type { CoachToolDeps } from '../../../src/lib/coach/tools.js';
import type { ExerciseDefinition, WorkoutEvent } from '../../../src/types/workout.js';
import type { Meal } from '../../../src/types/nutrition.js';
import type { CreateEventInput } from '../../../src/lib/schedule/types.js';
import { buildCompletionRows, eventFieldsToRow, eventToRow } from '../../../src/lib/schedule/mapping.js';
import { definitionFieldsToRow, slugifyName } from '../../../src/lib/schedule/definitions.js';
import { baseIdOf, makeOccurrenceId, occurrenceDateOf } from '../../../src/lib/schedule/occurrence.js';
import { mealFieldsToRow, mealToRow } from '../../../src/lib/nutrition/mapping.js';

// CoachToolDeps over the service-role client (W5b): the SAME executors the
// browser ran (src/lib/coach/tools.ts) — and the evals still drive — now run
// on the server against api/_lib/services/*. Each method mirrors what
// ScheduleContext / MealsContext did for the coach: mint the id, build the
// row, stamp triggered_by 'ai', and answer the executor's boolean/null
// contract. Reads the executors need (definitions, meals, events) arrive in
// `ctx`, loaded by the handler for the caller.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export interface ServerDepsContext {
  /** The caller's local calendar date — decides "retro-log" on create. */
  today: string;
  /** Expanded occurrences: titles, dates and recurrence for the targets. */
  events: WorkoutEvent[];
  definitions: Map<string, ExerciseDefinition>;
  meals: Meal[];
}

export function createServerDeps(supabase: Admin, userId: string, ctx: ServerDepsContext): CoachToolDeps {
  const findEvent = (id: string) => ctx.events.find(e => e.id === id);

  return {
    definitions: ctx.definitions,
    meals: ctx.meals,

    async createEvent(input: CreateEventInput) {
      // UUID, not a timestamp: workout_events.id is a global PK across users.
      const id = `ai-${randomUUID()}`;
      // An event added to a day that has already passed is a retro-log: it
      // was done, not planned, so it completes on creation (same effect as
      // the "Mark as Complete" toggle, including the plan-filled session
      // log). A recurring series is a plan whatever its anchor date — never that.
      const completedOnCreate = input.date < ctx.today && !input.recurrenceRule;
      const newEvent: WorkoutEvent = {
        id,
        type:              input.type,
        sport:             input.sport,
        title:             input.title,
        date:              input.date,
        estimatedDuration: input.estimatedDuration,
        difficulty:        input.difficulty ?? 3,
        startTime:         input.startTime,
        endTime:           input.endTime,
        description:       input.description ?? '',
        location:          input.location,
        tags:              input.tags ?? [],
        equipment:         input.equipment ?? [],
        exercises:         input.exercises ?? [],
        warmup:            input.warmup,
        cooldown:          input.cooldown,
        cardioTargets:     input.cardioTargets,
        climbingTargets:   input.climbingTargets,
        templateId:        input.templateId,
        scoringType:       input.scoringType,
        timeCapMinutes:    input.timeCapMinutes,
        isCompleted:       completedOnCreate,
        isRecurring:       !!input.recurrenceRule,
        recurrenceRule:    input.recurrenceRule,
      };
      const result = await events.createEvent(supabase, userId, eventToRow(newEvent) as unknown as Record<string, unknown>, 'ai');
      if (!result.ok) return null;
      ctx.events.push(newEvent);
      if (completedOnCreate) {
        // Best-effort, like the browser's fire-and-forget: the event exists
        // either way, and the calendar toggle can repair completion state.
        const rows = buildCompletionRows(newEvent, true);
        await recordCompletion(
          supabase, userId,
          rows.completionRow as unknown as Record<string, unknown>,
          rows.logRow as unknown as Record<string, unknown>,
        ).catch(err => console.warn('[coach-tool] retro-log completion failed:', err));
        await quickCompletePlan(supabase, userId, newEvent)
          .catch(err => console.warn('[coach-tool] retro-log quick-complete failed:', err));
      }
      return { id };
    },

    async updateEvent({ id, fields }) {
      const current = findEvent(id);
      const baseId = baseIdOf(id);
      const result = await events.updateEvent(supabase, userId, baseId, eventFieldsToRow(fields) as Record<string, unknown>, {
        event_title: fields.title ?? current?.title ?? baseId,
        event_date:  fields.date ?? current?.date,
        diff:        { before: current ?? {}, after: fields } as never,
        triggered_by: 'ai',
      });
      return result.ok;
    },

    async deleteEvent(id) {
      const event = findEvent(id);
      const baseId = baseIdOf(id);
      const result = await events.deleteEvent(supabase, userId, baseId, {
        event_title: event?.title ?? baseId, event_date: event?.date, triggered_by: 'ai',
      });
      return result.ok;
    },

    async deleteEventInstance(baseId, date) {
      const event = ctx.events.find(e => e.id === baseId || e.id.startsWith(`${baseId}__`));
      const result = await instances.skipInstance(supabase, userId, {
        eventId: baseId, date, eventTitle: event?.title ?? baseId, triggeredBy: 'ai',
      });
      return result.ok;
    },

    async rescheduleEvent(id, fields) {
      if (fields.date === undefined && fields.startTime === undefined && fields.endTime === undefined) return true;
      const event = findEvent(id);
      if (!event) return false;

      if (!event.isRecurring) return this.updateEvent({ id, fields });

      // A recurring occurrence: a per-occurrence override keyed at the
      // occurrence's original generated date (the base anchor date for the
      // base row itself), merged over any earlier override so repeated
      // edits stack — exactly what the browser did with its exceptions map.
      const baseId = baseIdOf(id);
      const keyDate = occurrenceDateOf(id) ?? findEvent(baseId)?.date ?? event.date;
      const { data: existing } = await supabase
        .from('recurring_exceptions')
        .select('override_date, override_start_time, override_end_time')
        .eq('user_id', userId).eq('event_id', baseId).eq('skipped_date', keyDate)
        .maybeSingle();
      const merged = {
        ...(existing?.override_date ? { date: existing.override_date } : {}),
        ...(existing?.override_start_time ? { startTime: existing.override_start_time } : {}),
        ...(existing?.override_end_time ? { endTime: existing.override_end_time } : {}),
        ...fields,
      };
      void makeOccurrenceId; // the key the browser used; the row is (event_id, skipped_date) here
      const result = await instances.rescheduleInstance(supabase, userId, {
        eventId: baseId, date: keyDate, eventTitle: event.title, triggeredBy: 'ai',
      }, merged);
      return result.ok;
    },

    async createDefinition(input) {
      const { triggeredBy: _ignored, ...fields } = input;
      const def: ExerciseDefinition = {
        id: fields.id ?? slugifyName(fields.canonicalName),
        aliases: [], muscleGroups: [], equipment: [], isUnilateral: false,
        ...fields,
      };
      const result = await definitionsSvc.createDefinition(
        supabase, userId, { id: def.id, ...definitionFieldsToRow(def) }, 'ai',
      );
      if (!result.ok) return null;
      // Synchronous, like the eval fixture: the executor resolves the new
      // entry on the same call instead of falling back to an inline entry.
      ctx.definitions.set(def.id, def);
      return { id: def.id };
    },

    async updateDefinition({ id, fields }) {
      const current = ctx.definitions.get(id);
      const result = await definitionsSvc.updateDefinition(supabase, userId, id, definitionFieldsToRow(fields), {
        definition_name: fields.canonicalName ?? current?.canonicalName ?? id,
        diff: { before: current ?? {}, after: fields } as never,
        triggered_by: 'ai',
      });
      if (result.ok && current) ctx.definitions.set(id, { ...current, ...fields } as ExerciseDefinition);
      return result.ok;
    },

    async createMeal(input) {
      const { triggeredBy: _ignored, ...fields } = input;
      const meal: Meal = { ...fields, id: `meal-${randomUUID()}` };
      const result = await mealsSvc.createMeal(supabase, userId, mealToRow(meal) as unknown as Record<string, unknown>, 'ai');
      if (!result.ok) return null;
      ctx.meals.push(meal);
      return { id: meal.id };
    },

    async updateMeal({ id, fields }) {
      const current = ctx.meals.find(m => m.id === id);
      const result = await mealsSvc.updateMeal(supabase, userId, id, mealFieldsToRow(fields) as Record<string, unknown>, {
        meal_title: fields.title ?? current?.title ?? id,
        diff: { before: current ?? {}, after: fields } as never,
        triggered_by: 'ai',
      });
      return result.ok;
    },

    async deleteMeal(id) {
      const meal = ctx.meals.find(m => m.id === id);
      const result = await mealsSvc.deleteMeal(supabase, userId, id, { meal_title: meal?.title ?? id, triggered_by: 'ai' });
      return result.ok;
    },
  };
}
