import type Anthropic from '@anthropic-ai/sdk';
import { baseIdOf } from '../schedule/occurrence.js';
import type { CreateEventInput, UpdateEventInput } from '../schedule/types.js';
import type { WorkoutType } from '../../types/workout.js';

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
}

export interface CoachToolDef {
  schema: Anthropic.Tool;
  /** One-liner for the confirmation card, e.g. "Delete: Upper Body · Mon Jun 29". */
  displayLabel(input: Record<string, unknown>): string;
  /** Runs the confirmed action; the returned string becomes the tool_result. */
  execute(input: Record<string, unknown>, deps: CoachToolDeps): Promise<string>;
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
      },
      required: ['type', 'title', 'date', 'estimated_duration'],
    },
  },
  displayLabel(input) {
    return `Create: ${input.title} · ${input.type} · ${input.date}`;
  },
  async execute(input, deps) {
    const { type, title, date, estimated_duration, start_time, difficulty, description, location, tags, equipment } =
      input as {
        type: WorkoutType; title: string; date: string; estimated_duration: number;
        start_time?: string; difficulty?: number; description?: string;
        location?: string; tags?: string[]; equipment?: string[];
      };
    const createInput: CreateEventInput = {
      type, title, date,
      estimatedDuration: estimated_duration,
      startTime:   start_time,
      difficulty:  difficulty as 1 | 2 | 3 | 4 | 5 | undefined,
      description, location, tags, equipment,
    };
    const result = await deps.createEvent(createInput);
    return result ? `Created "${title}" on ${date}.` : 'Failed to create the event.';
  },
};

const updateEventTool: CoachToolDef = {
  schema: {
    name: 'update_event',
    description:
      'Update fields on an existing workout event. ' +
      'For recurring event instances (id contains "__"), this updates the base event and affects all future occurrences.',
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

export const COACH_TOOLS: CoachToolDef[] = [deleteEventTool, createEventTool, updateEventTool];

export function coachToolSchemas(): Anthropic.Tool[] {
  return COACH_TOOLS.map(t => t.schema);
}

export function findCoachTool(name: string): CoachToolDef | undefined {
  return COACH_TOOLS.find(t => t.schema.name === name);
}
