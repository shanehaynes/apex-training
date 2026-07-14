import type Anthropic from '@anthropic-ai/sdk';

// The coach tools' Anthropic schemas — a deliberately dependency-free module
// (the SDK import is type-only and erased at build). api/chat.ts imports
// this file directly; keeping the serverless import surface free of the
// executor logic in tools.ts (and its schedule/definitions graph) keeps the
// lambda bundle identical in shape to the known-good coach-summary function.
// Executors, labels, and the registry stay in tools.ts.

export const EXERCISE_INPUT_SCHEMA = {
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

export const deleteEventSchema: Anthropic.Tool = {
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
};

export const createEventSchema: Anthropic.Tool = {
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
};

export const setEventExercisesSchema: Anthropic.Tool = {
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
};

export const updateExerciseDefinitionSchema: Anthropic.Tool = {
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
};

export const updateEventSchema: Anthropic.Tool = {
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
};

/** Schemas in registry order (must match COACH_TOOLS in tools.ts). */
export function coachToolSchemas(): Anthropic.Tool[] {
  return [
    deleteEventSchema,
    createEventSchema,
    updateEventSchema,
    setEventExercisesSchema,
    updateExerciseDefinitionSchema,
  ];
}
