import type Anthropic from '@anthropic-ai/sdk';
import {
  createEventSchema,
  deleteEventSchema,
  setEventExercisesSchema,
  updateEventSchema,
  updateExerciseDefinitionSchema,
} from './schemas.js';
import { baseIdOf, isOccurrenceId } from '../schedule/occurrence.js';
import { countDefinitionReferences, entryFromDefinition, hasPerSideCount, matchDefinitionByName } from '../schedule/definitions.js';
import type { CreateDefinitionInput, CreateEventInput, OccurrenceOverride, UpdateDefinitionInput, UpdateEventInput } from '../schedule/types.js';
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
}

/**
 * Live app state for confirmation-card labels — lets a label state its blast
 * radius ("affects 14 workouts") and flag new library entries. Optional:
 * labels degrade gracefully without it.
 */
export interface CoachToolContext {
  definitions: Map<string, ExerciseDefinition>;
  events: WorkoutEvent[];
}

export interface CoachToolDef {
  schema: Anthropic.Tool;
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
          climbStyle: input.climb_style, grade: input.grade, ascentStyle: input.ascent_style,
        });
        continue;
      }
    }
    entries.push(entryFromDefinition(def, `${def.id}-${i + 1}`, overrides));
  }
  return { entries, created };
}

function describeCreated(created: string[]): string {
  return created.length ? ` Added ${created.length} new exercise(s) to the library: ${created.join(', ')}.` : '';
}

const deleteEventTool: CoachToolDef = {
  schema: deleteEventSchema,
  displayLabel(input) {
    const scope = input.scope === 'instance' ? '(this instance)' : '(entire series)';
    const date  = (input.event_date_display as string | undefined) ?? (input.date as string | undefined) ?? '';
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
    return result
      ? `Created "${title}" on ${date}.${describeCreated(created)}`
      : 'Failed to create the event.';
  },
};

const setEventExercisesTool: CoachToolDef = {
  schema: setEventExercisesSchema,
  displayLabel(input, ctx) {
    const exercises = (input.exercises as ExerciseInput[] | undefined) ?? [];
    const section = input.section && input.section !== 'exercises' ? ` ${input.section}` : '';
    const created = ctx ? unmatchedNames(exercises, ctx.definitions) : [];
    return `Set${section} exercises: ${input.event_title} · ${exercises.length} exercises` +
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
  displayLabel(input) {
    const keys = Object.keys((input.changes as Record<string, unknown>) ?? {}).join(', ');
    return `Update: ${input.event_title} (${keys})`;
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

export const COACH_TOOLS: CoachToolDef[] = [
  deleteEventTool,
  createEventTool,
  updateEventTool,
  setEventExercisesTool,
  updateExerciseDefinitionTool,
];


export function findCoachTool(name: string): CoachToolDef | undefined {
  return COACH_TOOLS.find(t => t.schema.name === name);
}
