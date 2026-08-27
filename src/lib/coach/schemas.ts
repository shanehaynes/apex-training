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
      category:      { type: 'string', enum: ['strength', 'stretch', 'cardio', 'skill', 'mobility', 'climbing'], description: 'Only used when creating a new library entry.' },
      muscle_groups: { type: 'array', items: { type: 'string' }, description: 'Only used when creating a new library entry.' },
      sets:          { type: 'number' },
      reps:          { type: 'string', description: 'Per side for unilateral movements — "5 each leg", never a bare number.' },
      duration:      { type: 'string', description: 'For timed holds, e.g. "30s each side".' },
      weight:        { type: 'string' },
      rest_period:   { type: 'string' },
      superset:      { type: 'string', description: 'Superset/circuit group label ("A", "B"). CONSECUTIVE entries sharing a label are performed together, alternating sets. A label on a single entry is dropped.' },
      notes:         { type: 'string', description: 'Day-specific intent only — form cues live on the library entry.' },
      climb_style:   { type: 'string', enum: ['sport', 'trad', 'boulder', 'ice-mixed'], description: 'Climbing pitches only (outdoor climbing events: one entry per pitch).' },
      grade:         { type: 'string', description: 'Climbing pitches only — e.g. "5.11a", "V5", "WI4".' },
      ascent_style:  { type: 'string', enum: ['flash', 'redpoint', 'follow', 'attempt'], description: 'Climbing pitches only — how the ascent went. "follow" is roped-only, never on boulders.' },
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
        enum: ['stretching', 'morning-routine', 'weights', 'climbing', 'outdoor-climbing', 'cardio', 'yoga'],
        description: '"climbing" is indoor; "outdoor-climbing" events hold one exercise entry per pitch, with a cardio approach/descent as warmup/cooldown.',
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
          category:         { type: 'string', enum: ['strength', 'stretch', 'cardio', 'skill', 'mobility', 'climbing'] },
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

// Shared by log_meal and update_meal's changes object. Grams throughout;
// total fat is independent of the sat/trans split (unsaturated fats make up
// the rest), so never invent a total by summing the split.
const MEAL_FIELD_PROPERTIES = {
  title:           { type: 'string' as const },
  date:            { type: 'string' as const, description: 'YYYY-MM-DD' },
  time:            { type: 'string' as const, description: 'When eaten, e.g. "12:30 PM"' },
  meal_type:       { type: 'string' as const, enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
  calories:        { type: 'number' as const, description: 'Only when known (e.g. from a label); omit to auto-derive 4/4/9 from the macros.' },
  protein_g:       { type: 'number' as const },
  carbs_g:         { type: 'number' as const },
  fiber_g:         { type: 'number' as const },
  sugar_g:         { type: 'number' as const },
  fat_total_g:     { type: 'number' as const, description: 'Total fat — at least saturated + trans (unsaturated makes up the rest). Never derive it by summing the split.' },
  fat_saturated_g: { type: 'number' as const },
  fat_trans_g:     { type: 'number' as const },
  notes:           { type: 'string' as const },
};

export const logMealSchema: Anthropic.Tool = {
  name: 'log_meal',
  description:
    'Log a meal with its macros onto a calendar day. Grams for all macro fields. ' +
    'Omit calories to auto-derive them (4/4/9) from protein/carbs/fat.',
  input_schema: {
    type: 'object',
    properties: MEAL_FIELD_PROPERTIES,
    required: ['title', 'date'],
  },
};

export const updateMealSchema: Anthropic.Tool = {
  name: 'update_meal',
  description:
    'Update fields on an already-logged meal. Only include fields that should change; ' +
    'set a field to null to clear it.',
  input_schema: {
    type: 'object',
    properties: {
      meal_id: { type: 'string', description: 'The meal ID shown in [brackets] in the meals list.' },
      meal_title: { type: 'string', description: 'Current title — shown in the confirmation card.' },
      changes: {
        type: 'object',
        description: 'Only include fields that should change.',
        properties: MEAL_FIELD_PROPERTIES,
      },
    },
    required: ['meal_id', 'meal_title', 'changes'],
  },
};

export const deleteMealSchema: Anthropic.Tool = {
  name: 'delete_meal',
  description: 'Delete a logged meal.',
  input_schema: {
    type: 'object',
    properties: {
      meal_id: { type: 'string', description: 'The meal ID shown in [brackets] in the meals list.' },
      meal_title: { type: 'string', description: 'Human-readable title — shown in the confirmation card.' },
    },
    required: ['meal_id', 'meal_title'],
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
    logMealSchema,
    updateMealSchema,
    deleteMealSchema,
  ];
}

// ─── Builder mode (toolMode: 'builder') ──────────────────────────────────────
// The workout builder embeds its own coach thread with exactly ONE tool: a
// partial update over the draft form. The calendar/meal tools above do not
// exist in this mode, which makes "the coach can never apply, save, or touch
// the schedule from the builder" structural rather than prompt-enforced.
// Executed client-side against React draft state — nothing persists until
// the user presses Apply.

export const updateWorkoutDraftSchema: Anthropic.Tool = {
  name: 'update_workout_draft',
  description:
    'Update the workout draft the user is building. Partial: only the fields you pass change; ' +
    'a passed section (warmup/exercises/cooldown) REPLACES that whole section. This edits the ' +
    'form only — nothing is saved or scheduled until the user presses Apply, which only they can do.',
  input_schema: {
    type: 'object',
    properties: {
      title:            { type: 'string' },
      type:             { type: 'string', enum: ['weights', 'climbing', 'outdoor-climbing', 'cardio', 'yoga', 'stretching', 'morning-routine'] },
      scoring_type:     { type: 'string', enum: ['strength', 'for-time', 'amrap'], description: 'What the PR means: strength = per-exercise records; for-time = fastest completion of fixed work; amrap = most rounds+reps inside the time cap.' },
      time_cap_minutes: { type: 'number', description: 'AMRAP only: the working window in minutes.' },
      date:             { type: 'string', description: 'YYYY-MM-DD.' },
      start_time:       { type: 'string', description: '24h HH:MM.' },
      end_time:         { type: 'string', description: '24h HH:MM.' },
      duration_minutes: { type: 'number' },
      difficulty:       { type: 'number', description: '1–5.' },
      description:      { type: 'string' },
      location:         { type: 'string' },
      tags:             { type: 'array', items: { type: 'string' } },
      warmup:           EXERCISE_INPUT_SCHEMA,
      exercises:        EXERCISE_INPUT_SCHEMA,
      cooldown:         EXERCISE_INPUT_SCHEMA,
      repeat: {
        type: 'object',
        description: 'Weekly repeat schedule. Pass { off: true } to disable; otherwise days is required.',
        properties: {
          days:           { type: 'array', items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] } },
          interval_weeks: { type: 'number', description: '1 = every week, 2 = every other week…' },
          until:          { type: 'string', description: 'YYYY-MM-DD, inclusive; omit for no end.' },
          off:            { type: 'boolean' },
        },
      },
    },
  },
};

/** The builder thread's constant tool list — per-mode caching invariant. */
export function builderToolSchemas(): Anthropic.Tool[] {
  return [updateWorkoutDraftSchema];
}
