import type Anthropic from '@anthropic-ai/sdk';
import { baseIdOf, isOccurrenceId } from '../schedule/occurrence.js';
import { countDefinitionReferences, entryFromDefinition, hasPerSideCount, matchDefinitionByName } from '../schedule/definitions.js';
import type { CreateDefinitionInput, CreateEventInput, OccurrenceOverride, UpdateDefinitionInput, UpdateEventInput } from '../schedule/types.js';
import type { Exercise, ExerciseDefinition, WorkoutEvent, WorkoutType } from '../../types/workout.js';

// The coach's tool registry: each tool's Anthropic schema, its
// confirmation-card label, and its executor live together, so adding a
// tool is one entry here — not edits to three string-coupled switch sites.
// Executors receive the schedule mutations as `deps` (injected, so this
// module stays React-free and testable). api/chat.ts imports the schemas;
// the SDK import above is type-only and never reaches the client bundle.

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
}

const EXERCISE_INPUT_SCHEMA = {
  type: 'array' as const,
  description:
    'Exercises in performance order, one movement per entry. `name` must exactly match an ' +
    'EXERCISE LIBRARY name to reference it; any other name creates a NEW library entry — never ' +
    'use a variant spelling of an existing exercise. Unset prescription fields prefill from the ' +
    "library entry's defaults.",
  items: {
    type: 'object' as const,
    properties: {
      name:          { type: 'string' },
      category:      { type: 'string', enum: ['strength', 'stretch', 'cardio', 'skill', 'mobility'], description: 'Only used when creating a new library entry.' },
      muscle_groups: { type: 'array', items: { type: 'string' }, description: 'Only used when creating a new library entry.' },
      sets:          { type: 'number' },
      reps:          { type: 'string', description: 'Per side for unilateral movements — "5 each leg", never a bare number.' },
      duration:      { type: 'string', description: 'For timed holds, e.g. "30s each side".' },
      weight:        { type: 'string' },
      rest_period:   { type: 'string' },
      notes:         { type: 'string', description: 'Day-specific intent only — form cues live on the library entry.' },
    },
    required: ['name'],
  },
};

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
  schema: {
    name: 'delete_event',
    description:
      'Delete a workout event from the schedule. ' +
      'For recurring events always ask the user first: delete just this one instance, or the entire series? ' +
      'Use scope="instance" + date for a single occurrence; scope="all" to remove the whole event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The event ID shown in [brackets] in the schedule.',
        },
        scope: {
          type: 'string',
          enum: ['instance', 'all'],
          description:
            '"instance" = skip only this date (recurring events only). ' +
            '"all" = delete the event (or entire series) permanently.',
        },
        date: {
          type: 'string',
          description: 'YYYY-MM-DD date of the instance to skip. Required when scope is "instance".',
        },
        event_title: {
          type: 'string',
          description: 'Human-readable event title — shown in the confirmation card.',
        },
        event_date_display: {
          type: 'string',
          description: 'Human-readable date — shown in the confirmation card, e.g. "Monday June 29".',
        },
      },
      required: ['event_id', 'scope', 'event_title'],
    },
  },
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
  schema: {
    name: 'create_event',
    description: 'Add a new workout event to the schedule.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['stretching', 'morning-routine', 'weights', 'climbing', 'cardio', 'yoga'],
        },
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        estimated_duration: { type: 'number', description: 'Minutes' },
        start_time: { type: 'string', description: 'e.g. "6:30 AM"' },
        difficulty: { type: 'number', description: '1–5' },
        description: { type: 'string' },
        location: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        equipment: { type: 'array', items: { type: 'string' } },
        exercises: EXERCISE_INPUT_SCHEMA,
      },
      required: ['type', 'title', 'date', 'estimated_duration'],
    },
  },
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
  schema: {
    name: 'set_event_exercises',
    description:
      'Replace the full exercise list of one section of a workout event. ' +
      'Always send the complete list in performance order — it overwrites what is there. ' +
      'Only works on base event ids; for a recurring series this changes every occurrence.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The event ID shown in [brackets] in the schedule.' },
        event_title: { type: 'string', description: 'Current title — shown in the confirmation card.' },
        section: {
          type: 'string',
          enum: ['warmup', 'exercises', 'cooldown'],
          description: 'Which section to replace. Defaults to "exercises" (main work).',
        },
        exercises: EXERCISE_INPUT_SCHEMA,
      },
      required: ['event_id', 'event_title', 'exercises'],
    },
  },
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
  schema: {
    name: 'update_exercise_definition',
    description:
      'Edit an exercise in the shared library — the change propagates to EVERY workout that ' +
      'references it, past and future. Use for form cues (technique_notes), renames ' +
      '(canonical_name — history follows automatically), categorization, and default ' +
      'prescriptions (defaults only prefill newly added exercises; existing workouts keep their ' +
      "own sets/reps/weight — edit those with set_event_exercises).",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact EXERCISE LIBRARY name (current name, not the new one).' },
        changes: {
          type: 'object',
          description: 'Only include fields that should change.',
          properties: {
            canonical_name:   { type: 'string' },
            category:         { type: 'string', enum: ['strength', 'stretch', 'cardio', 'skill', 'mobility'] },
            muscle_groups:    { type: 'array', items: { type: 'string' } },
            equipment:        { type: 'array', items: { type: 'string' } },
            technique_notes:  { type: 'string' },
            is_unilateral:    { type: 'boolean' },
            default_sets:     { type: 'number' },
            default_reps:     { type: 'string' },
            default_duration: { type: 'string' },
            default_weight:   { type: 'string' },
            default_rest:     { type: 'string' },
          },
        },
      },
      required: ['name', 'changes'],
    },
  },
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
  schema: {
    name: 'update_event',
    description:
      'Update fields on an existing workout event. ' +
      'For recurring event instances (id contains "__"): date/start_time/end_time changes move only that ' +
      'occurrence; other fields cannot be edited on an instance id — use the base id (before "__") to ' +
      'change the whole series.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The event ID.' },
        event_title: { type: 'string', description: 'Current title — shown in the confirmation card.' },
        changes: {
          type: 'object',
          description: 'Only include fields that should change.',
          properties: {
            title:              { type: 'string' },
            date:               { type: 'string', description: 'YYYY-MM-DD' },
            start_time:         { type: 'string' },
            end_time:           { type: 'string' },
            estimated_duration: { type: 'number' },
            description:        { type: 'string' },
            location:           { type: 'string' },
            difficulty:         { type: 'number' },
          },
        },
      },
      required: ['event_id', 'event_title', 'changes'],
    },
  },
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

export function coachToolSchemas(): Anthropic.Tool[] {
  return COACH_TOOLS.map(t => t.schema);
}

export function findCoachTool(name: string): CoachToolDef | undefined {
  return COACH_TOOLS.find(t => t.schema.name === name);
}
