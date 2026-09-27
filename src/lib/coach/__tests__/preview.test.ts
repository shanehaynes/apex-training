import { describe, it, expect } from 'vitest';
import { previewForTool, exerciseLine, formatDate, formatDuration, EMPTY } from '../preview';
import type { CoachToolContext } from '../tools';
import type { ExerciseDefinition, WorkoutEvent } from '../../../types/workout';
import type { Meal } from '../../../types/nutrition';

// The confirm card's before/after block. Every case reads the same live
// context the label reads, so a preview can never name a row the executor
// would not touch — and a target the context cannot resolve yields null,
// leaving the label's "(no matching entry …)" to speak alone.

function makeDefinition(overrides: Partial<ExerciseDefinition> & Pick<ExerciseDefinition, 'id' | 'canonicalName'>): ExerciseDefinition {
  return { aliases: [], category: 'strength', muscleGroups: [], equipment: [], isUnilateral: false, ...overrides };
}

const pistol = makeDefinition({
  id: 'pistol-squat', canonicalName: 'Pistol Squat', aliases: ['Pistol Squats'],
  category: 'skill', isUnilateral: true, defaultSets: 3, defaultReps: '5 each leg', defaultRest: '2 min',
  muscleGroups: ['quads', 'glutes'], techniqueNotes: 'Heel down.',
});
const dip = makeDefinition({ id: 'weighted-dip', canonicalName: 'Weighted Dip', defaultWeight: '25lb' });

function makeEvent(overrides: Partial<WorkoutEvent> & Pick<WorkoutEvent, 'id' | 'title' | 'date'>): WorkoutEvent {
  return {
    type: 'weights', estimatedDuration: 45, description: '', exercises: [], difficulty: 3, tags: [],
    isCompleted: false, isRecurring: false, ...overrides,
  };
}

const upper = makeEvent({
  id: 'upper', title: 'Upper Body', date: '2026-07-09', startTime: '6:30 AM', location: 'Garage',
  exercises: [
    { id: 'e1', definitionId: 'weighted-dip', name: 'Weighted Dip', category: 'strength', sets: 4, reps: '8', weight: '25lb' },
    { id: 'e2', definitionId: 'pistol-squat', name: 'Pistol Squat', category: 'skill', sets: 3, reps: '5 each leg' },
  ],
  warmup: [{ id: 'w1', name: 'Band Pull-Apart', category: 'mobility', sets: 2, reps: '15' }],
});
// A recurring series, expanded into two occurrences (ids `base__date`).
const yogaMon = makeEvent({ id: 'yoga__2026-07-06', title: 'Yoga', date: '2026-07-06', type: 'yoga', isRecurring: true, estimatedDuration: 30 });
const yogaWed = makeEvent({ id: 'yoga__2026-07-08', title: 'Yoga', date: '2026-07-08', type: 'yoga', isRecurring: true, estimatedDuration: 30 });

const burrito: Meal = {
  id: 'meal-1', title: 'Chicken burrito', date: '2026-08-06', time: '12:30 PM', mealType: 'lunch',
  proteinG: 40, carbsG: 50, fatTotalG: 25, fatSaturatedG: 9, notes: '',
};

const ctx: CoachToolContext = {
  definitions: new Map([[pistol.id, pistol], [dip.id, dip]]),
  events: [upper, yogaMon, yogaWed],
  meals: [burrito],
};

describe('formatting', () => {
  it('shows dates as EEE MMM d and durations in minutes', () => {
    expect(formatDate('2026-07-09')).toBe('Thu Jul 9');
    expect(formatDate('not a date')).toBe('not a date');
    expect(formatDate(undefined)).toBe(EMPTY);
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(undefined)).toBe(EMPTY);
  });

  it('renders an exercise as Name · sets × reps, with duration or weight when that is what it has', () => {
    expect(exerciseLine({ name: 'Pistol Squat', sets: 3, reps: '5 each leg' })).toBe('Pistol Squat · 3 × 5 each leg');
    expect(exerciseLine({ name: 'Plank', sets: 2, duration: '60s' })).toBe('Plank · 2 × 60s');
    expect(exerciseLine({ name: 'Weighted Dip', sets: 4, reps: '8', weight: '25lb' })).toBe('Weighted Dip · 4 × 8 · 25lb');
    expect(exerciseLine({ name: 'Walk', duration: '20 min' })).toBe('Walk · 20 min');
    expect(exerciseLine({ name: 'Rows', sets: 3 })).toBe('Rows · 3 sets');
    expect(exerciseLine({ name: 'Easy jog' })).toBe('Easy jog');
  });
});

describe('create_event', () => {
  it('shows when, how long, the type, and the exercises as they will be resolved', () => {
    const preview = previewForTool('create_event', {
      type: 'weights', title: 'Lower Body', date: '2026-07-10', estimated_duration: 50, start_time: '7:00 AM',
      exercises: [
        // Library match: gaps prefill from the entry's defaults (sets 3, reps "5 each leg").
        { name: 'pistol squats' },
        // Library match with an override.
        { name: 'Weighted Dip', sets: 5, reps: '6' },
        // No match: will be created.
        { name: 'Zercher Squat', sets: 3, reps: '8', weight: '135lb' },
      ],
    }, ctx);
    expect(preview).toEqual({
      kind: 'event-create',
      title: 'Lower Body',
      date: 'Fri Jul 10',
      time: '7:00 AM',
      durationMinutes: 50,
      type: 'weights',
      exercises: [
        'Pistol Squat · 3 × 5 each leg',
        'Weighted Dip · 5 × 6 · 25lb',
        'Zercher Squat (new) · 3 × 8 · 135lb',
      ],
    });
  });

  it('tolerates a create without optional fields and skips malformed exercise entries', () => {
    const preview = previewForTool('create_event', {
      type: 'cardio', title: 'Easy Run', date: '2026-07-08', exercises: [null, 'x', { sets: 3 }],
    }, ctx);
    expect(preview).toEqual({
      kind: 'event-create', title: 'Easy Run', date: 'Wed Jul 8', time: undefined,
      durationMinutes: undefined, type: 'cardio', exercises: [],
    });
  });
});

describe('update_event', () => {
  it('diffs only the fields present in the input against the live event', () => {
    const preview = previewForTool('update_event', {
      event_id: 'upper', event_title: 'Upper Body',
      changes: { date: '2026-07-10', estimated_duration: 60 },
    }, ctx);
    expect(preview).toEqual({
      kind: 'event-update',
      title: 'Upper Body',
      changes: [
        { field: 'Date', before: 'Thu Jul 9', after: 'Fri Jul 10' },
        { field: 'Duration', before: '45 min', after: '60 min' },
      ],
    });
  });

  it('shows an unset live field as — and a cleared field as —', () => {
    const preview = previewForTool('update_event', {
      event_id: 'upper', event_title: 'Upper Body',
      changes: { end_time: '7:30 AM', location: null },
    }, ctx);
    expect(preview).toMatchObject({
      changes: [
        { field: 'End', before: EMPTY, after: '7:30 AM' },
        { field: 'Location', before: 'Garage', after: EMPTY },
      ],
    });
  });

  it('bounds and strips model-authored free text', () => {
    const preview = previewForTool('update_event', {
      event_id: 'upper', event_title: 'Upper Body',
      changes: { description: '<b>' + 'x'.repeat(100) },
    }, ctx);
    const after = (preview as { changes: Array<{ after: string }> }).changes[0].after;
    expect(after).not.toContain('<');
    expect(after.endsWith('…')).toBe(true);
    expect(after.length).toBeLessThanOrEqual(61);
  });

  it('resolves an occurrence id to its base row and a base id to an occurrence', () => {
    // An occurrence id whose date is outside the loaded window: base row wins.
    const base = { ...ctx, events: [makeEvent({ id: 'yoga', title: 'Yoga', date: '2026-07-06', isRecurring: true })] };
    expect(previewForTool('update_event', { event_id: 'yoga__2026-09-01', event_title: 'Yoga', changes: { title: 'Flow' } }, base))
      .toMatchObject({ title: 'Yoga', changes: [{ field: 'Title', before: 'Yoga', after: 'Flow' }] });
    // A base id against expanded occurrences: the first occurrence stands in.
    expect(previewForTool('update_event', { event_id: 'yoga', event_title: 'Yoga', changes: { start_time: '7:00 AM' } }, ctx))
      .toMatchObject({ title: 'Yoga', changes: [{ field: 'Start', before: EMPTY, after: '7:00 AM' }] });
  });

  it('returns null when the id matches no live event — the label already says so', () => {
    expect(previewForTool('update_event', { event_id: 'nope', event_title: 'Ghost', changes: { title: 'X' } }, ctx)).toBeNull();
  });

  it('returns null when no change key is one the executor understands', () => {
    expect(previewForTool('update_event', { event_id: 'upper', event_title: 'Upper Body', changes: { colour: 'red' } }, ctx)).toBeNull();
    expect(previewForTool('update_event', { event_id: 'upper', event_title: 'Upper Body', changes: 'x' }, ctx)).toBeNull();
  });
});

describe('delete_event', () => {
  it('names the series when scope is all on a recurring id', () => {
    expect(previewForTool('delete_event', { event_id: 'yoga__2026-07-06', scope: 'all', event_title: 'Yoga' }, ctx))
      .toEqual({ kind: 'event-delete', title: 'Yoga', date: 'Mon Jul 6', scope: 'series' });
  });

  it('names the one instance, on the input date, when scope is instance', () => {
    expect(previewForTool('delete_event', { event_id: 'yoga', scope: 'instance', date: '2026-07-08', event_title: 'Yoga' }, ctx))
      .toEqual({ kind: 'event-delete', title: 'Yoga', date: 'Wed Jul 8', scope: 'one' });
  });

  it('is one workout when scope is all on a non-recurring event, unknown without a scope', () => {
    expect(previewForTool('delete_event', { event_id: 'upper', scope: 'all', event_title: 'Upper Body' }, ctx))
      .toEqual({ kind: 'event-delete', title: 'Upper Body', date: 'Thu Jul 9', scope: 'one' });
    expect(previewForTool('delete_event', { event_id: 'upper', event_title: 'Upper Body' }, ctx))
      .toMatchObject({ scope: 'unknown' });
  });

  it('returns null for an id that resolves to nothing', () => {
    expect(previewForTool('delete_event', { event_id: 'nope', scope: 'all', event_title: 'Ghost' }, ctx)).toBeNull();
  });
});

describe('set_event_exercises', () => {
  it('lists the section as it is and as it will be, resolved through the library', () => {
    const preview = previewForTool('set_event_exercises', {
      event_id: 'upper', event_title: 'Upper Body',
      exercises: [{ name: 'Weighted Dip', sets: 5, reps: '5', weight: '35lb' }, { name: 'Ring Row', sets: 3, reps: '10' }],
    }, ctx);
    expect(preview).toEqual({
      kind: 'exercises',
      title: 'Upper Body',
      before: ['Weighted Dip · 4 × 8 · 25lb', 'Pistol Squat · 3 × 5 each leg'],
      after: ['Weighted Dip · 5 × 5 · 35lb', 'Ring Row (new) · 3 × 10'],
    });
  });

  it('reads the named section, and an empty one shows as an empty list', () => {
    expect(previewForTool('set_event_exercises', {
      event_id: 'upper', event_title: 'Upper Body', section: 'warmup', exercises: [{ name: 'Cat-Cow', sets: 1, reps: '10' }],
    }, ctx)).toEqual({
      kind: 'exercises', title: 'Upper Body · warmup',
      before: ['Band Pull-Apart · 2 × 15'], after: ['Cat-Cow (new) · 1 × 10'],
    });
    expect(previewForTool('set_event_exercises', {
      event_id: 'upper', event_title: 'Upper Body', section: 'cooldown', exercises: [],
    }, ctx)).toMatchObject({ title: 'Upper Body · cooldown', before: [], after: [] });
  });

  it('returns null without a live event or a list', () => {
    expect(previewForTool('set_event_exercises', { event_id: 'nope', event_title: 'X', exercises: [] }, ctx)).toBeNull();
    expect(previewForTool('set_event_exercises', { event_id: 'upper', event_title: 'X', exercises: 'no' }, ctx)).toBeNull();
  });
});

describe('update_exercise_definition', () => {
  it('diffs the library entry, matched by name or alias, on the fields given', () => {
    const preview = previewForTool('update_exercise_definition', {
      name: 'pistol squats',
      changes: { technique_notes: 'Knee tracks over toes.', default_sets: 4, muscle_groups: ['quads', 'glutes', 'core'], is_unilateral: false },
    }, ctx);
    expect(preview).toEqual({
      kind: 'definition-update',
      name: 'Pistol Squat',
      changes: [
        { field: 'Technique notes', before: 'Heel down.', after: 'Knee tracks over toes.' },
        { field: 'Default sets', before: '3', after: '4' },
        { field: 'Muscle groups', before: 'quads, glutes', after: 'quads, glutes, core' },
        { field: 'Unilateral', before: 'yes', after: 'no' },
      ],
    });
  });

  it('returns null for a name not in the library or a change set the executor would reject', () => {
    expect(previewForTool('update_exercise_definition', { name: 'Nope', changes: { default_sets: 4 } }, ctx)).toBeNull();
    expect(previewForTool('update_exercise_definition', { name: 'Pistol Squat', changes: { sets: 4 } }, ctx)).toBeNull();
  });
});

describe('meals', () => {
  it('log_meal lists when, the calories it will show, and the macros', () => {
    const preview = previewForTool('log_meal', {
      title: 'Greek yogurt', date: '2026-08-07', time: '8:00 AM', meal_type: 'breakfast',
      protein_g: 20, carbs_g: 15, fat_total_g: 5, fiber_g: 2,
    }, ctx);
    expect(preview).toEqual({
      kind: 'meal', action: 'log', title: 'Greek yogurt',
      lines: ['Fri Aug 7 · 8:00 AM · breakfast', '185 kcal (from macros)', 'P 20 g · C 15 g · F 5 g', 'Fiber 2 g'],
    });
  });

  it('log_meal keeps a given calorie figure and notes, and copes with no macros at all', () => {
    expect(previewForTool('log_meal', { title: 'Bar', date: '2026-08-07', calories: 250, notes: 'from the label' }, ctx))
      .toEqual({ kind: 'meal', action: 'log', title: 'Bar', lines: ['Fri Aug 7', '250 kcal', 'Notes: from the label'] });
    expect(previewForTool('log_meal', { title: 'Water', date: '2026-08-07' }, ctx))
      .toEqual({ kind: 'meal', action: 'log', title: 'Water', lines: ['Fri Aug 7'] });
  });

  it('update_meal shows before → after for the fields present, including clears', () => {
    expect(previewForTool('update_meal', {
      meal_id: 'meal-1', meal_title: 'Chicken burrito', changes: { protein_g: 45, time: null, calories: 600 },
    }, ctx)).toEqual({
      kind: 'meal', action: 'update', title: 'Chicken burrito',
      lines: [`Time: 12:30 PM → ${EMPTY}`, `Calories: ${EMPTY} → 600 kcal`, 'Protein: 40 g → 45 g'],
    });
  });

  it('delete_meal restates the live meal', () => {
    expect(previewForTool('delete_meal', { meal_id: 'meal-1', meal_title: 'Chicken burrito' }, ctx)).toEqual({
      kind: 'meal', action: 'delete', title: 'Chicken burrito',
      lines: ['Thu Aug 6 · 12:30 PM · lunch', '585 kcal · P 40 g · C 50 g · F 25 g'],
    });
  });

  it('returns null for a meal id not in the context', () => {
    expect(previewForTool('update_meal', { meal_id: 'nope', meal_title: 'X', changes: { calories: 1 } }, ctx)).toBeNull();
    expect(previewForTool('delete_meal', { meal_id: 'nope', meal_title: 'X' }, ctx)).toBeNull();
  });
});

describe('garbage in', () => {
  it('returns null, never throws, for unknown tools and malformed input', () => {
    expect(previewForTool('nope', {}, ctx)).toBeNull();
    expect(previewForTool('update_workout_draft', { title: 'x' }, ctx)).toBeNull();
    expect(previewForTool('create_event', {}, ctx)).toBeNull();
    expect(previewForTool('create_event', { title: 42, date: [] }, ctx)).toBeNull();
    expect(previewForTool('log_meal', { title: 'x' }, ctx)).toBeNull();
    expect(previewForTool('update_event', null as unknown as Record<string, unknown>, ctx)).toBeNull();
    expect(previewForTool('update_event', { event_id: 'upper', changes: { title: 'x' } }, undefined as unknown as CoachToolContext)).toBeNull();
    // A context whose rows are not what the types promise.
    const broken = { definitions: new Map(), events: [null], meals: 'x' } as unknown as CoachToolContext;
    expect(previewForTool('update_event', { event_id: 'upper', changes: { title: 'x' } }, broken)).toBeNull();
    expect(previewForTool('delete_meal', { meal_id: 'meal-1' }, broken)).toBeNull();
  });
});
