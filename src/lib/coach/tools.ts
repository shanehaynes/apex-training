import type Anthropic from '@anthropic-ai/sdk';
import {
  createEventSchema,
  deleteEventSchema,
  deleteMealSchema,
  leaveNoteSchema,
  logMealSchema,
  proposeContractEditSchema,
  setEventExercisesSchema,
  updateEventSchema,
  updateExerciseDefinitionSchema,
  updateMealSchema,
} from './schemas.js';
import { baseIdOf, isOccurrenceId } from '../schedule/occurrence.js';
import { countDefinitionReferences, entryFromDefinition, hasPerSideCount, matchDefinitionByName } from '../schedule/definitions.js';
import { normalizeSupersets } from '../schedule/supersets.js';
import { sanitizeInlineText } from './prompt.js';
import { isMemoryView, MEMORY_TOOL, memoryReadChip, memoryToolSchema, memoryWriteLabel } from './memory.js';
import { CONTRACT_MAX, contractsEqual, normalizeContract } from './contract.js';
import { isSeverity, isTargetKind, normalizeBody, targetProblem, type NewCoachAnnotation } from './annotations.js';
import { validateFatSplit } from '../nutrition/mapping.js';
import type { CreateDefinitionInput, CreateEventInput, OccurrenceOverride, UpdateDefinitionInput, UpdateEventInput } from '../schedule/types.js';
import type { CreateMealInput, Meal, MealType, UpdateMealInput } from '../../types/nutrition.js';
import type { Exercise, ExerciseDefinition, WorkoutEvent, WorkoutType } from '../../types/workout.js';

// The coach's tool registry: each tool's confirmation-card label and
// executor live with its schema reference, so adding a tool is one entry
// here — not edits to three string-coupled switch sites. Executors receive
// the schedule mutations as `deps` (injected, so this module stays
// React-free and testable). The schemas themselves live in schemas.ts —
// api/chat.ts imports THAT file, never this one, so the serverless bundle
// stays free of the executor/schedule graph.

export interface CoachToolDeps {
  createEvent(input: CreateEventInput): Promise<{ id: string } | null>;
  updateEvent(input: UpdateEventInput): Promise<boolean>;
  deleteEvent(id: string): Promise<boolean>;
  deleteEventInstance(baseId: string, date: string): Promise<boolean>;
  rescheduleEvent(id: string, fields: OccurrenceOverride): Promise<boolean>;
  /** The exercise library, for name → definition resolution. */
  definitions: Map<string, ExerciseDefinition>;
  createDefinition(input: CreateDefinitionInput): Promise<{ id: string } | null>;
  updateDefinition(input: UpdateDefinitionInput): Promise<boolean>;
  /** Logged meals, for update_meal's merge-validation of the fat split. */
  meals: Meal[];
  createMeal(input: CreateMealInput): Promise<{ id: string } | null>;
  updateMeal(input: UpdateMealInput): Promise<boolean>;
  deleteMeal(id: string): Promise<boolean>;
  /** The memory backend (api/_lib/coach/memory.ts applyMemoryCommand), for a
   *  confirmed memory write. Optional: deps built without a database — the
   *  eval harness — answer that memory is unavailable rather than fail. */
  applyMemoryCommand?(input: Record<string, unknown>): Promise<string>;
  /** The contract backend (api/_lib/reflection/contract.ts applyContractEdit)
   *  for a confirmed propose_contract_edit (lane D01): replaces the contract
   *  when `before` still matches what is stored. Optional, like memory. */
  applyContractEdit?(before: string, after: string): Promise<{ ok: true; contract: string } | { ok: false; reason: string }>;
  /** The annotation insert for a confirmed leave_note (lane D01): the row
   *  lands with created_by 'coach' through the service-role client. Optional,
   *  like memory. */
  createAnnotation?(note: NewCoachAnnotation): Promise<{ id: string } | null>;
}

/**
 * Live app state for confirmation-card labels — lets a label resolve the
 * model-supplied event_id/meal_id against real rows (so the card names what
 * will actually change, not what the model claims), state its blast radius
 * ("affects 14 workouts"), and flag new library entries. Optional: labels
 * degrade gracefully without it.
 */
export interface CoachToolContext {
  definitions: Map<string, ExerciseDefinition>;
  events: WorkoutEvent[];
  meals: Meal[];
  /** The stored coaching contract (lane D01), when the caller has it — the
   *  server does (api/_lib/coach/context.ts); a card built without it shows
   *  the model's copy of the "before" instead. */
  contract?: string;
}

// ─── Confirmation-card target resolution ─────────────────────────────────────
//
// The model supplies event_title / meal_title fields alongside the id, but
// those are model-controlled text: nothing stops a tool call from pairing a
// rest day's id with a workout's title. When live context is available the
// card label therefore comes from the row the id actually resolves to, and an
// id that resolves to nothing is surfaced as such instead of trusting the
// claimed title. The model-text fallback only applies without ctx (the queue's
// stream-time label in actionQueue.ts, and the eval harness).

/**
 * The event an id refers to: exact match first; a base id falls back to its
 * expanded occurrences (ctx.events holds `base__date` rows for recurring
 * series, preferring one on `date` when given); an out-of-window occurrence
 * id falls back to its base row.
 */
function resolveEvent(ctx: CoachToolContext | undefined, id: unknown, date?: unknown): WorkoutEvent | undefined {
  if (!ctx || typeof id !== 'string') return undefined;
  const exact = ctx.events.find(e => e.id === id);
  if (exact) return exact;
  const occurrences = ctx.events.filter(e => baseIdOf(e.id) === id);
  if (occurrences.length) {
    return (typeof date === 'string' && occurrences.find(e => e.date === date)) || occurrences[0];
  }
  return ctx.events.find(e => e.id === baseIdOf(id));
}

function resolveMeal(ctx: CoachToolContext | undefined, id: unknown): Meal | undefined {
  if (!ctx || typeof id !== 'string') return undefined;
  return ctx.meals.find(m => m.id === id);
}

function unresolvedTarget(id: unknown): string {
  return `(no matching entry for id "${String(id)}")`;
}

/**
 * "date → 2026-08-09, clear location" — the actual new values, not just keys.
 * Values are model-authored free text (update_event's description,
 * update_meal's notes), so they get the same inline sanitize-and-bound
 * treatment as every other model string that reaches the UI — an unbounded
 * description would otherwise render in full inside the confirmation card.
 */
const CHANGE_VALUE_MAX = 40;

function describeChanges(changes: unknown): string {
  return Object.entries((changes as Record<string, unknown>) ?? {})
    .map(([key, value]) => {
      if (value === null || value === undefined) return `clear ${key}`;
      const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
      const shown = sanitizeInlineText(raw, CHANGE_VALUE_MAX);
      return `${key} → ${shown}${raw.length > CHANGE_VALUE_MAX ? '…' : ''}`;
    })
    .join(', ');
}

export interface CoachToolDef {
  /** The request-side definition: a custom tool, or the API's typed memory tool. */
  schema: Anthropic.Tool | Anthropic.MemoryTool20250818;
  /** One-liner for the confirmation card, e.g. "Delete: Upper Body · Mon Jun 29". */
  displayLabel(input: Record<string, unknown>, ctx?: CoachToolContext): string;
  /** Runs the confirmed action; the returned string becomes the tool_result. */
  execute(input: Record<string, unknown>, deps: CoachToolDeps): Promise<string>;
}

// ─── Exercise entry resolution (EXERCISE_LIBRARY_SPEC.md §5) ─────────────────

/** One exercise as the model supplies it inside a tool call. */
interface ExerciseInput {
  name: string;
  category?: Exercise['category'];
  muscle_groups?: string[];
  sets?: number;
  reps?: string;
  duration?: string;
  weight?: string;
  rest_period?: string;
  superset?: string;
  notes?: string;
  climb_style?: Exercise['climbStyle'];
  grade?: string;
  ascent_style?: Exercise['ascentStyle'];
}

/** Names in the input that match no library entry (case-insensitively) — i.e. would be created. */
function unmatchedNames(inputs: ExerciseInput[], definitions: Map<string, ExerciseDefinition>): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    if (!matchDefinitionByName(input.name, definitions.values()) && !out.includes(input.name)) out.push(input.name);
  }
  return out;
}

/**
 * Resolve model-supplied exercises into event entries: exact name match →
 * reference that definition (prescription gaps prefilled from its defaults);
 * no match → create a new definition first. Unilateral entries must state
 * per-side counts — violations abort with an instructive error so the model
 * can restate instead of polluting the data.
 */
async function buildExerciseEntries(
  inputs: ExerciseInput[],
  deps: CoachToolDeps,
): Promise<{ entries: Exercise[]; created: string[] } | { error: string }> {
  const violations: string[] = [];
  for (const input of inputs) {
    const def = matchDefinitionByName(input.name, deps.definitions.values());
    const counted = input.reps ?? input.duration;
    if (def?.isUnilateral && counted && !hasPerSideCount(counted)) {
      violations.push(`${def.canonicalName}: "${counted}" — state the count per side ("${counted} each side") or as "total".`);
    }
  }
  if (violations.length) {
    return { error: `Unilateral exercises need per-side counts. Fix and retry:\n${violations.join('\n')}` };
  }

  const entries: Exercise[] = [];
  const created: string[] = [];
  for (const [i, input] of inputs.entries()) {
    const overrides = {
      sets: input.sets, reps: input.reps, duration: input.duration,
      weight: input.weight, restPeriod: input.rest_period, notes: input.notes,
      superset: input.superset,
      climbStyle: input.climb_style, grade: input.grade, ascentStyle: input.ascent_style,
    };
    let def = matchDefinitionByName(input.name, deps.definitions.values());
    if (!def) {
      const result = await deps.createDefinition({
        canonicalName: input.name,
        category: input.category ?? 'strength',
        muscleGroups: input.muscle_groups ?? [],
        isUnilateral: hasPerSideCount(`${input.reps ?? ''} ${input.duration ?? ''}`),
      });
      if (!result) return { error: `Failed to create new exercise "${input.name}".` };
      def = deps.definitions.get(result.id);
      created.push(input.name);
      if (!def) {
        // Injected map not updated synchronously — build the entry from the input.
        entries.push({
          id: `${result.id}-${i + 1}`,
          definitionId: result.id,
          name: input.name,
          category: input.category ?? 'strength',
          sets: input.sets, reps: input.reps, duration: input.duration,
          weight: input.weight, restPeriod: input.rest_period, notes: input.notes,
          superset: input.superset,
          climbStyle: input.climb_style, grade: input.grade, ascentStyle: input.ascent_style,
        });
        continue;
      }
    }
    entries.push(entryFromDefinition(def, `${def.id}-${i + 1}`, overrides));
  }
  // The model's labels go through the same normalizer as the editor's: run
  // lettering, adjacency, and no singleton groups.
  return { entries: normalizeSupersets(entries), created };
}

function describeCreated(created: string[]): string {
  return created.length ? ` Added ${created.length} new exercise(s) to the library: ${created.join(', ')}.` : '';
}

const deleteEventTool: CoachToolDef = {
  schema: deleteEventSchema,
  displayLabel(input, ctx) {
    const scope = input.scope === 'instance' ? '(this instance)' : '(entire series)';
    const event = resolveEvent(ctx, input.event_id, input.date);
    if (event) return `Delete: ${event.title} · ${event.date} ${scope}`;
    if (ctx)   return `Delete: ${unresolvedTarget(input.event_id)} ${scope}`;
    const date = (input.event_date_display as string | undefined) ?? (input.date as string | undefined) ?? '';
    return `Delete: ${input.event_title}${date ? ' · ' + date : ''} ${scope}`;
  },
  async execute(input, deps) {
    const { event_id, scope, date } = input as {
      event_id: string; scope: 'instance' | 'all'; date?: string;
    };
    if (scope === 'instance' && date) {
      // Recurring instances have synthetic occurrence ids (`base__date`).
      const ok = await deps.deleteEventInstance(baseIdOf(event_id), date);
      return ok ? 'Deleted that instance successfully.' : 'Failed to delete the instance.';
    }
    const ok = await deps.deleteEvent(event_id);
    return ok ? 'Deleted the event successfully.' : 'Failed to delete the event.';
  },
};

const createEventTool: CoachToolDef = {
  schema: createEventSchema,
  displayLabel(input, ctx) {
    const label = `Create: ${input.title} · ${input.type} · ${input.date}`;
    const exercises = (input.exercises as ExerciseInput[] | undefined) ?? [];
    if (!exercises.length) return label;
    const created = ctx ? unmatchedNames(exercises, ctx.definitions) : [];
    return `${label} · ${exercises.length} exercises${created.length ? ` · adds ${created.length} new: ${created.join(', ')}` : ''}`;
  },
  async execute(input, deps) {
    const { type, title, date, estimated_duration, start_time, difficulty, description, location, tags, equipment, exercises } =
      input as {
        type: WorkoutType; title: string; date: string; estimated_duration: number;
        start_time?: string; difficulty?: number; description?: string;
        location?: string; tags?: string[]; equipment?: string[];
        exercises?: ExerciseInput[];
      };

    let entries: Exercise[] = [];
    let created: string[] = [];
    if (exercises?.length) {
      const built = await buildExerciseEntries(exercises, deps);
      if ('error' in built) return built.error;
      ({ entries, created } = built);
    }

    const createInput: CreateEventInput = {
      type, title, date,
      estimatedDuration: estimated_duration,
      startTime:   start_time,
      difficulty:  difficulty as 1 | 2 | 3 | 4 | 5 | undefined,
      description, location, tags, equipment,
      exercises: entries,
    };
    const result = await deps.createEvent(createInput);
    // The id is load-bearing: without it the model cannot reference the event
    // it just created (its refreshed schedule shows a same-titled entry it may
    // mistake for a pre-existing duplicate). Bracketed to match the schedule
    // rendering in prompt.ts.
    return result
      ? `Created "${title}" on ${date} [${result.id}].${describeCreated(created)}`
      : 'Failed to create the event.';
  },
};

const setEventExercisesTool: CoachToolDef = {
  schema: setEventExercisesSchema,
  displayLabel(input, ctx) {
    const exercises = (input.exercises as ExerciseInput[] | undefined) ?? [];
    const section = input.section && input.section !== 'exercises' ? ` ${input.section}` : '';
    const event = resolveEvent(ctx, input.event_id);
    // The executor rejects occurrence ids and rewrites the whole series (one
    // shared exercise list), so naming a single date here would understate
    // the blast radius — a series states its occurrence count instead.
    const occurrences = event && ctx
      ? ctx.events.filter(e => baseIdOf(e.id) === baseIdOf(event.id)).length
      : 0;
    const target = !event ? (ctx ? unresolvedTarget(input.event_id) : String(input.event_title))
      : occurrences > 1 ? `${event.title} · every occurrence (${occurrences} workouts)`
      : `${event.title} · ${event.date}`;
    const created = ctx ? unmatchedNames(exercises, ctx.definitions) : [];
    return `Set${section} exercises: ${target} · ${exercises.length} exercises` +
      (created.length ? ` · adds ${created.length} new: ${created.join(', ')}` : '');
  },
  async execute(input, deps) {
    const { event_id, section = 'exercises', exercises } = input as {
      event_id: string; section?: 'warmup' | 'exercises' | 'cooldown'; exercises: ExerciseInput[];
    };
    if (isOccurrenceId(event_id)) {
      return (
        `Cannot change exercises on a single occurrence of a recurring event — the series shares ` +
        `one exercise list. Use the base event ID "${baseIdOf(event_id)}" (this changes every occurrence).`
      );
    }
    const built = await buildExerciseEntries(exercises, deps);
    if ('error' in built) return built.error;
    const ok = await deps.updateEvent({ id: event_id, fields: { [section]: built.entries } });
    return ok
      ? `Replaced the ${section} list (${built.entries.length} exercises).${describeCreated(built.created)}`
      : 'Failed to update the exercises.';
  },
};

// Library-tier fields the coach may edit; prescriptions live on events.
const DEFINITION_CHANGE_FIELDS: Record<string, keyof ExerciseDefinition> = {
  canonical_name:   'canonicalName',
  category:         'category',
  muscle_groups:    'muscleGroups',
  equipment:        'equipment',
  technique_notes:  'techniqueNotes',
  is_unilateral:    'isUnilateral',
  default_sets:     'defaultSets',
  default_reps:     'defaultReps',
  default_duration: 'defaultDuration',
  default_weight:   'defaultWeight',
  default_rest:     'defaultRest',
};

const updateExerciseDefinitionTool: CoachToolDef = {
  schema: updateExerciseDefinitionSchema,
  displayLabel(input, ctx) {
    const keys = Object.keys((input.changes as Record<string, unknown>) ?? {}).join(', ');
    let radius = '';
    if (ctx) {
      const def = matchDefinitionByName(String(input.name ?? ''), ctx.definitions.values());
      if (def) {
        const count = countDefinitionReferences(def.id, ctx.events);
        radius = ` — affects ${count} workout${count === 1 ? '' : 's'}`;
      }
    }
    return `Edit exercise: ${input.name} (${keys})${radius}`;
  },
  async execute(input, deps) {
    const { name, changes } = input as { name: string; changes: Record<string, unknown> };
    const def = matchDefinitionByName(name, deps.definitions.values());
    if (!def) {
      return `"${name}" is not in the exercise library. Check the EXERCISE LIBRARY list for the exact name.`;
    }
    const fields: UpdateDefinitionInput['fields'] = {};
    const unknown: string[] = [];
    for (const [key, value] of Object.entries(changes ?? {})) {
      const mapped = DEFINITION_CHANGE_FIELDS[key];
      if (mapped) (fields as Record<string, unknown>)[mapped] = value;
      else unknown.push(key);
    }
    if (unknown.length) {
      return `Cannot change ${unknown.join(', ')} on a library entry. Prescriptions (sets/reps/weight for a specific workout) are edited with set_event_exercises.`;
    }
    if (Object.keys(fields).length === 0) return 'No valid changes given.';
    const ok = await deps.updateDefinition({ id: def.id, fields });
    return ok
      ? `Updated "${def.canonicalName}" — the change applies to every workout referencing it.` +
        (fields.canonicalName ? ` The old name stays attached as an alias, so history is preserved.` : '')
      : 'Failed to update the exercise.';
  },
};

const updateEventTool: CoachToolDef = {
  schema: updateEventSchema,
  displayLabel(input, ctx) {
    const changes = describeChanges(input.changes);
    const event = resolveEvent(ctx, input.event_id);
    if (event) return `Update: ${event.title} · ${event.date} (${changes})`;
    if (ctx)   return `Update: ${unresolvedTarget(input.event_id)} (${changes})`;
    return `Update: ${input.event_title} (${changes})`;
  },
  async execute(input, deps) {
    const { event_id, changes } = input as {
      event_id: string;
      changes: {
        title?: string; date?: string; start_time?: string; end_time?: string;
        estimated_duration?: number; description?: string; location?: string; difficulty?: number;
      };
    };
    if (isOccurrenceId(event_id)) {
      const rescheduleKeys = ['date', 'start_time', 'end_time'];
      const otherKeys = Object.keys(changes).filter(k => !rescheduleKeys.includes(k));
      if (otherKeys.length > 0) {
        return (
          `Cannot change ${otherKeys.join(', ')} on a single occurrence of a recurring event. ` +
          `Only date, start_time, and end_time can be changed per-occurrence; ` +
          `to edit the whole series, use the base event ID "${baseIdOf(event_id)}".`
        );
      }
      const ok = await deps.rescheduleEvent(event_id, {
        ...(changes.date       !== undefined && { date: changes.date }),
        ...(changes.start_time !== undefined && { startTime: changes.start_time }),
        ...(changes.end_time   !== undefined && { endTime: changes.end_time }),
      });
      return ok
        ? 'Rescheduled that occurrence successfully (the rest of the series is unchanged).'
        : 'Failed to reschedule the occurrence.';
    }

    const fields: UpdateEventInput['fields'] = {
      ...(changes.title              !== undefined && { title: changes.title }),
      ...(changes.date               !== undefined && { date: changes.date }),
      ...(changes.start_time         !== undefined && { startTime: changes.start_time }),
      ...(changes.end_time           !== undefined && { endTime: changes.end_time }),
      ...(changes.estimated_duration !== undefined && { estimatedDuration: changes.estimated_duration }),
      ...(changes.description        !== undefined && { description: changes.description }),
      ...(changes.location           !== undefined && { location: changes.location }),
      ...(changes.difficulty         !== undefined && { difficulty: changes.difficulty as 1|2|3|4|5 }),
    };
    const ok = await deps.updateEvent({ id: event_id, fields });
    return ok ? 'Updated the event successfully.' : 'Failed to update the event.';
  },
};

// ─── Meal tools ──────────────────────────────────────────────────────────────

/** Snake_case numeric macro fields as the model supplies them. */
interface MealFieldsInput {
  title?: string | null;
  date?: string | null;
  time?: string | null;
  meal_type?: string | null;
  calories?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fiber_g?: number | null;
  sugar_g?: number | null;
  fat_total_g?: number | null;
  fat_saturated_g?: number | null;
  fat_trans_g?: number | null;
  alcohol_g?: number | null;
  notes?: string | null;
}

const MEAL_NUMERIC_KEYS = [
  'calories', 'protein_g', 'carbs_g', 'fiber_g', 'sugar_g',
  'fat_total_g', 'fat_saturated_g', 'fat_trans_g', 'alcohol_g',
] as const;

/** Negative macro values abort with an instructive error before the DB CHECK 500s. */
function negativeMacroError(input: MealFieldsInput): string | null {
  const bad = MEAL_NUMERIC_KEYS.filter(k => typeof input[k] === 'number' && (input[k] as number) < 0);
  return bad.length ? `Macro values cannot be negative: ${bad.join(', ')}.` : null;
}

const FAT_SPLIT_ERROR =
  'fat_total_g must be at least fat_saturated_g + fat_trans_g (unsaturated fat makes up the rest). Fix and retry.';

/**
 * Snake_case tool fields → camelCase Meal fields. Only keys present in the
 * input appear in the result; null values become present-but-undefined keys,
 * which mealFieldsToRow turns into column clears.
 */
function mealFieldsFromInput(input: MealFieldsInput): Partial<Omit<Meal, 'id'>> {
  const fields: Partial<Omit<Meal, 'id'>> = {};
  const set = <K extends keyof Meal>(key: K, value: Meal[K] | null | undefined) => {
    (fields as Record<string, unknown>)[key] = value ?? undefined;
  };
  if ('title' in input)           set('title', input.title ?? undefined);
  if ('date' in input)            set('date', input.date ?? undefined);
  if ('time' in input)            set('time', input.time);
  if ('meal_type' in input)       set('mealType', input.meal_type as MealType | null);
  if ('calories' in input)        set('calories', input.calories);
  if ('protein_g' in input)       set('proteinG', input.protein_g);
  if ('carbs_g' in input)         set('carbsG', input.carbs_g);
  if ('fiber_g' in input)         set('fiberG', input.fiber_g);
  if ('sugar_g' in input)         set('sugarG', input.sugar_g);
  if ('fat_total_g' in input)     set('fatTotalG', input.fat_total_g);
  if ('fat_saturated_g' in input) set('fatSaturatedG', input.fat_saturated_g);
  if ('fat_trans_g' in input)     set('fatTransG', input.fat_trans_g);
  if ('alcohol_g' in input)       set('alcoholG', input.alcohol_g);
  if ('notes' in input)           set('notes', input.notes ?? '');
  return fields;
}

function mealMacroSummary(input: MealFieldsInput): string {
  const parts = [
    input.protein_g != null ? `P ${input.protein_g}` : null,
    input.carbs_g != null ? `C ${input.carbs_g}` : null,
    input.fat_total_g != null ? `F ${input.fat_total_g}` : null,
  ].filter(Boolean);
  return parts.length ? ` · ${parts.join(' / ')}` : '';
}

const logMealTool: CoachToolDef = {
  schema: logMealSchema,
  displayLabel(input) {
    return `Log meal: ${input.title} · ${input.date}${mealMacroSummary(input as MealFieldsInput)}`;
  },
  async execute(input, deps) {
    const fields = input as unknown as MealFieldsInput & { title: string; date: string };
    const negative = negativeMacroError(fields);
    if (negative) return negative;
    if (!validateFatSplit(fields.fat_total_g ?? undefined, fields.fat_saturated_g ?? undefined, fields.fat_trans_g ?? undefined)) {
      return FAT_SPLIT_ERROR;
    }

    const createInput: CreateMealInput = {
      ...mealFieldsFromInput(fields),
      title: fields.title,
      date: fields.date,
      notes: fields.notes ?? '',
    };
    const result = await deps.createMeal(createInput);
    // Bracketed id so the model can reference the meal it just logged.
    return result
      ? `Logged "${fields.title}" on ${fields.date} [${result.id}].`
      : 'Failed to log the meal.';
  },
};

const updateMealTool: CoachToolDef = {
  schema: updateMealSchema,
  displayLabel(input, ctx) {
    const changes = describeChanges(input.changes);
    const meal = resolveMeal(ctx, input.meal_id);
    if (meal) return `Update meal: ${meal.title} · ${meal.date} (${changes})`;
    if (ctx)  return `Update meal: ${unresolvedTarget(input.meal_id)} (${changes})`;
    return `Update meal: ${input.meal_title} (${changes})`;
  },
  async execute(input, deps) {
    const { meal_id, changes } = input as { meal_id: string; changes: MealFieldsInput };
    const current = deps.meals.find(m => m.id === meal_id);
    if (!current) {
      return `No logged meal with id "${meal_id}". Check the MEALS list for the exact bracketed id.`;
    }
    const negative = negativeMacroError(changes ?? {});
    if (negative) return negative;

    const fields = mealFieldsFromInput(changes ?? {});
    if (Object.keys(fields).length === 0) return 'No valid changes given.';

    // Validate the fat split as it will exist after the merge.
    const merged = { ...current, ...fields };
    if (!validateFatSplit(merged.fatTotalG, merged.fatSaturatedG, merged.fatTransG)) {
      return FAT_SPLIT_ERROR;
    }

    const ok = await deps.updateMeal({ id: meal_id, fields });
    return ok ? 'Updated the meal successfully.' : 'Failed to update the meal.';
  },
};

const deleteMealTool: CoachToolDef = {
  schema: deleteMealSchema,
  displayLabel(input, ctx) {
    const meal = resolveMeal(ctx, input.meal_id);
    if (meal) return `Delete meal: ${meal.title} · ${meal.date}`;
    if (ctx)  return `Delete meal: ${unresolvedTarget(input.meal_id)}`;
    return `Delete meal: ${input.meal_title}`;
  },
  async execute(input, deps) {
    const { meal_id } = input as { meal_id: string };
    const ok = await deps.deleteMeal(meal_id);
    return ok ? 'Deleted the meal successfully.' : 'Failed to delete the meal.';
  },
};

// ─── Memory ──────────────────────────────────────────────────────────────────

/**
 * The memory tool's WRITE half (lane C02). The model issues memory_20250818
 * commands over /memories; `view` is a read that api/chat.ts answers itself
 * (isServerSideTool below), and every other command lands here as a confirm
 * card — "Remember: …", "Forget: …", "Update memory: …" — whose confirmed
 * execution is applyMemoryCommand on the server. Nothing is remembered
 * without the click (D-C03). The label and preview come from the command
 * alone: the client holds no memory rows to resolve against.
 */
const memoryTool: CoachToolDef = {
  schema: memoryToolSchema,
  displayLabel(input) {
    return memoryWriteLabel(input);
  },
  async execute(input, deps) {
    if (!deps.applyMemoryCommand) return 'Memory is not available here; nothing was remembered.';
    return deps.applyMemoryCommand(input);
  },
};

// ─── Contract and notes (lane D01) ───────────────────────────────────────────

/** How much of a contract or a note a card label shows before it is cut. */
const LABEL_TEXT_MAX = 60;

function cut(text: unknown, max = LABEL_TEXT_MAX): string {
  const raw = typeof text === 'string' ? text : '';
  const shown = sanitizeInlineText(raw, max);
  return shown + (raw.trim().length > max ? '…' : '');
}

/**
 * propose_contract_edit: the coach proposes the whole new coaching contract;
 * the card shows before and after; the confirmed execution replaces the
 * stored text only when `before` still matches it (applyContractEdit's
 * optimistic check — a proposal made against last week's contract cannot
 * overwrite an edit the athlete made since). The "before" on the label is
 * the stored contract when the context carries it, the model's copy
 * otherwise; the executor trusts neither over the database.
 */
const proposeContractEditTool: CoachToolDef = {
  schema: proposeContractEditSchema,
  displayLabel(input, ctx) {
    const before = normalizeContract(ctx?.contract ?? input.before);
    const after = normalizeContract(input.after);
    if (!after) return 'Contract edit: (empty proposal)';
    if (!before) return `Set coaching contract: ${cut(after)}`;
    if (contractsEqual(before, after)) return 'Contract edit: no change';
    return `Edit coaching contract: ${cut(before, 40)} → ${cut(after, 40)}`;
  },
  async execute(input, deps) {
    const after = normalizeContract(input.after);
    if (!after) return 'Nothing to propose: `after` is empty. Send the whole new contract text.';
    if (after.length > CONTRACT_MAX) return `The contract must be ${CONTRACT_MAX} characters or fewer (this one is ${after.length}). Shorten and retry.`;
    if (!deps.applyContractEdit) return 'The coaching contract is not available here; nothing was changed.';
    const result = await deps.applyContractEdit(normalizeContract(input.before), after);
    if (!result.ok) return result.reason;
    return contractsEqual(result.contract, normalizeContract(input.before))
      ? 'The contract already read that way; nothing was changed.'
      : 'Coaching contract updated. It applies from the next turn.';
  },
};

/**
 * leave_note: a short note pinned to a day, an event occurrence or a block
 * (coach_annotations). The label names the target from the live context when
 * it can — a day as its date, an event as its title and date — and falls back
 * to the model's target_label. The confirmed execution validates with the
 * same helpers the HTTP handler uses and inserts through deps.
 */
const leaveNoteTool: CoachToolDef = {
  schema: leaveNoteSchema,
  displayLabel(input, ctx) {
    const severity = isSeverity(input.severity) ? input.severity : 'info';
    const kind = isTargetKind(input.target_kind) ? input.target_kind : null;
    let target: string;
    if (kind === 'event') {
      const event = resolveEvent(ctx, input.target_id);
      target = event ? `${event.title} · ${event.date}`
        : ctx ? unresolvedTarget(input.target_id)
        : cut(input.target_label, 40) || String(input.target_id ?? '');
    } else if (kind === 'day') {
      target = typeof input.target_id === 'string' ? input.target_id : cut(input.target_label, 40);
    } else {
      target = cut(input.target_label, 40) || `${kind ?? 'unknown target'} ${String(input.target_id ?? '')}`.trim();
    }
    const tag = severity === 'info' ? '' : ` (${severity})`;
    return `Leave note${tag}: ${target} — ${cut(input.body)}`;
  },
  async execute(input, deps) {
    if (!isTargetKind(input.target_kind)) return 'target_kind must be day, event or block.';
    const problem = targetProblem(input.target_kind, input.target_id);
    if (problem) return `Cannot leave the note: ${problem}.`;
    const note = normalizeBody(input.body);
    if ('reason' in note) return `Cannot leave the note: ${note.reason}.`;
    if (input.severity !== undefined && !isSeverity(input.severity)) return 'severity must be info, caution or alert.';
    if (!deps.createAnnotation) return 'Notes are not available here; nothing was pinned.';
    const severity = isSeverity(input.severity) ? input.severity : 'info';
    const result = await deps.createAnnotation({
      target_kind: input.target_kind,
      target_id: input.target_id as string,
      body: note.body,
      severity,
    });
    return result
      ? `Left a ${severity} note on ${input.target_kind} ${String(input.target_id)} [${result.id}]: "${note.body}"`
      : 'Failed to leave the note.';
  },
};

export const COACH_TOOLS: CoachToolDef[] = [
  deleteEventTool,
  createEventTool,
  updateEventTool,
  setEventExercisesTool,
  updateExerciseDefinitionTool,
  logMealTool,
  updateMealTool,
  deleteMealTool,
  proposeContractEditTool,
  leaveNoteTool,
  memoryTool,
];


export function findCoachTool(name: string): CoachToolDef | undefined {
  return COACH_TOOLS.find(t => t.schema.name === name);
}

// ─── Server-side tools (the sight loop) ─────────────────────────────────────
//
// The read tools and read_doctrine never reach a confirmation card: api/chat.ts
// executes them itself, several rounds deep, inside one user turn. The client
// needs the same predicate — to keep them out of the pending-action queue and
// to label them on a reloaded thread — but cannot import
// api/_lib/coach/readTools.ts, whose graph is the MCP tool implementations.
// So the names are mirrored BY HAND here, like the analytics enums in
// schemas.ts, and src/lib/coach/__tests__/tools.test.ts pins the mirror to
// COACH_READ_TOOLS so the two cannot drift silently. The server uses this
// predicate too: one definition, one test.

export const READ_DOCTRINE_TOOL = 'read_doctrine';

/** COACH_READ_TOOLS by name, in its fixed order (api/_lib/coach/readTools.ts). */
export const SERVER_SIDE_READ_TOOL_NAMES: readonly string[] = [
  'get_schedule',
  'get_workout_detail',
  'get_exercise_history',
  'get_prs',
  'get_period_stats',
  'get_training_blocks',
  'search_exercises',
  'get_meals',
  'get_session_summaries',
  'get_reviews',
  'search_history',
];

const SERVER_SIDE = new Set([...SERVER_SIDE_READ_TOOL_NAMES, READ_DOCTRINE_TOOL]);

/**
 * True for a call api/chat.ts runs itself; false for every confirm-card
 * call. The read tools and read_doctrine are decided by NAME. The memory
 * tool is one name with six commands, and only `view` is a read — so it is
 * decided by the INPUT: `memory` with `command: 'view'` is server-side,
 * `memory` with anything else (or no input at all) is a confirm card.
 */
export function isServerSideTool(name: string, input?: unknown): boolean {
  if (name === MEMORY_TOOL) return isMemoryView(input);
  return SERVER_SIDE.has(name);
}

/**
 * The chip for a server-side call on a RELOADED thread, where the wire's
 * label (readToolLabel on the server, with the arguments in it) is gone and
 * only the stored tool_use block remains. Coarser than the live chip on
 * purpose: "Checked: exercise history" rather than "Checked: Deadlift
 * history". Never throws.
 */
export function serverSideToolChip(name: string, input: unknown): string {
  if (name === MEMORY_TOOL) return memoryReadChip(input);
  if (name === READ_DOCTRINE_TOOL) {
    const topic = typeof input === 'object' && input !== null ? (input as { topic?: unknown }).topic : undefined;
    return typeof topic === 'string' && topic ? `Read doctrine: ${topic}` : 'Read doctrine';
  }
  const verb = name.startsWith('search_') ? 'Searched' : 'Checked';
  const subject = name.replace(/^(get|search)_/, '').replace(/_/g, ' ');
  return `${verb}: ${subject}`;
}
