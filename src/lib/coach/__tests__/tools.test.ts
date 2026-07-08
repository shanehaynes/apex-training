import { describe, it, expect, vi } from 'vitest';
import { COACH_TOOLS, coachToolSchemas, findCoachTool } from '../tools';
import type { CoachToolDeps } from '../tools';
import type { ExerciseDefinition } from '../../../types/workout';

function makeDefinition(overrides: Partial<ExerciseDefinition> & Pick<ExerciseDefinition, 'id' | 'canonicalName'>): ExerciseDefinition {
  return {
    aliases: [],
    category: 'strength',
    muscleGroups: [],
    equipment: [],
    isUnilateral: false,
    ...overrides,
  };
}

const pistol = makeDefinition({
  id: 'pistol-squat',
  canonicalName: 'Pistol Squat',
  aliases: ['Pistol Squats'],
  category: 'skill',
  isUnilateral: true,
  defaultSets: 3,
  defaultReps: '5 each leg',
  defaultRest: '2 min',
});
const dip = makeDefinition({ id: 'weighted-dip', canonicalName: 'Weighted Dip', defaultWeight: '25lb' });

function makeDeps(overrides: Partial<CoachToolDeps> = {}): CoachToolDeps {
  return {
    createEvent: vi.fn(async () => ({ id: 'new-1' })),
    updateEvent: vi.fn(async () => true),
    deleteEvent: vi.fn(async () => true),
    deleteEventInstance: vi.fn(async () => true),
    rescheduleEvent: vi.fn(async () => true),
    definitions: new Map([[pistol.id, pistol], [dip.id, dip]]),
    createDefinition: vi.fn(async () => ({ id: 'zercher-squat' })),
    updateDefinition: vi.fn(async () => true),
    ...overrides,
  };
}

describe('coach tool registry', () => {
  it('exposes each tool exactly once, findable by schema name', () => {
    const names = coachToolSchemas().map(s => s.name);
    expect(names).toEqual(['delete_event', 'create_event', 'update_event', 'set_event_exercises', 'update_exercise_definition']);
    for (const name of names) expect(findCoachTool(name)?.schema.name).toBe(name);
    expect(findCoachTool('nope')).toBeUndefined();
  });

  it('every tool has a label and executor colocated with its schema', () => {
    for (const tool of COACH_TOOLS) {
      expect(typeof tool.displayLabel({})).toBe('string');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('delete_event routes instance scope through deleteEventInstance with the base id', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('delete_event')!.execute(
      { event_id: 'base__2026-07-06', scope: 'instance', date: '2026-07-06', event_title: 'Yoga' },
      deps,
    );
    expect(deps.deleteEventInstance).toHaveBeenCalledWith('base', '2026-07-06');
    expect(deps.deleteEvent).not.toHaveBeenCalled();
    expect(result).toMatch(/instance/);
  });

  it('delete_event routes scope=all through deleteEvent', async () => {
    const deps = makeDeps();
    await findCoachTool('delete_event')!.execute(
      { event_id: 'abc', scope: 'all', event_title: 'Yoga' },
      deps,
    );
    expect(deps.deleteEvent).toHaveBeenCalledWith('abc');
  });

  it('create_event maps snake_case tool input to CreateEventInput', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('create_event')!.execute(
      { type: 'yoga', title: 'Flow', date: '2026-07-08', estimated_duration: 30, start_time: '7:00 AM' },
      deps,
    );
    expect(deps.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yoga', title: 'Flow', date: '2026-07-08', estimatedDuration: 30, startTime: '7:00 AM',
    }));
    expect(result).toContain('Flow');
  });

  it('update_event forwards only the changed fields, camelCased', async () => {
    const deps = makeDeps();
    await findCoachTool('update_event')!.execute(
      { event_id: 'abc', event_title: 'Yoga', changes: { start_time: '6:00 AM', difficulty: 4 } },
      deps,
    );
    expect(deps.updateEvent).toHaveBeenCalledWith({
      id: 'abc',
      fields: { startTime: '6:00 AM', difficulty: 4 },
    });
    expect(deps.rescheduleEvent).not.toHaveBeenCalled();
  });

  it('update_event routes date/time-only changes on an occurrence id through rescheduleEvent', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('update_event')!.execute(
      {
        event_id: 'base__2026-07-06',
        event_title: 'Yoga',
        changes: { date: '2026-07-07', start_time: '6:00 AM' },
      },
      deps,
    );
    expect(deps.rescheduleEvent).toHaveBeenCalledWith('base__2026-07-06', {
      date: '2026-07-07',
      startTime: '6:00 AM',
    });
    expect(deps.updateEvent).not.toHaveBeenCalled();
    expect(result).toMatch(/occurrence/i);
  });

  it('update_event rejects non-schedule fields on an occurrence id without mutating anything', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('update_event')!.execute(
      {
        event_id: 'base__2026-07-06',
        event_title: 'Yoga',
        changes: { title: 'Hot Yoga', start_time: '6:00 AM' },
      },
      deps,
    );
    expect(deps.rescheduleEvent).not.toHaveBeenCalled();
    expect(deps.updateEvent).not.toHaveBeenCalled();
    expect(result).toContain('title');
    expect(result).toContain('"base"');
  });

  it('update_event keeps whole-series behavior for base ids', async () => {
    const deps = makeDeps();
    await findCoachTool('update_event')!.execute(
      { event_id: 'base', event_title: 'Yoga', changes: { title: 'Hot Yoga', date: '2026-07-07' } },
      deps,
    );
    expect(deps.updateEvent).toHaveBeenCalledWith({
      id: 'base',
      fields: { title: 'Hot Yoga', date: '2026-07-07' },
    });
    expect(deps.rescheduleEvent).not.toHaveBeenCalled();
  });

  it('set_event_exercises resolves library names to definition references with default prefill', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('set_event_exercises')!.execute(
      {
        event_id: 'legs-day',
        event_title: 'Legs',
        exercises: [
          { name: 'pistol squats', weight: '10lb' },        // alias, case-insensitive
          { name: 'Weighted Dip', sets: 4, reps: '8' },
        ],
      },
      deps,
    );
    expect(deps.updateEvent).toHaveBeenCalledWith({
      id: 'legs-day',
      fields: {
        exercises: [
          expect.objectContaining({
            definitionId: 'pistol-squat',
            name: 'Pistol Squat',          // canonical, not the alias spelling
            category: 'skill',
            sets: 3,                       // prefilled from defaults
            reps: '5 each leg',
            weight: '10lb',                // model-supplied wins
            restPeriod: '2 min',
          }),
          expect.objectContaining({
            definitionId: 'weighted-dip',
            sets: 4, reps: '8', weight: '25lb',
          }),
        ],
      },
    });
    expect(deps.createDefinition).not.toHaveBeenCalled();
    expect(result).toContain('2 exercises');
  });

  it('set_event_exercises creates a definition for unmatched names and says so', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('set_event_exercises')!.execute(
      {
        event_id: 'legs-day',
        event_title: 'Legs',
        exercises: [{ name: 'Zercher Squat', category: 'strength', sets: 3, reps: '5' }],
      },
      deps,
    );
    expect(deps.createDefinition).toHaveBeenCalledWith(expect.objectContaining({
      canonicalName: 'Zercher Squat', category: 'strength',
    }));
    expect(deps.updateEvent).toHaveBeenCalledWith(expect.objectContaining({
      fields: { exercises: [expect.objectContaining({ definitionId: 'zercher-squat', name: 'Zercher Squat' })] },
    }));
    expect(result).toContain('Zercher Squat');
    expect(result).toMatch(/new exercise/);
  });

  it('set_event_exercises rejects occurrence ids without mutating', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('set_event_exercises')!.execute(
      { event_id: 'legs__2026-07-06', event_title: 'Legs', exercises: [{ name: 'Weighted Dip' }] },
      deps,
    );
    expect(deps.updateEvent).not.toHaveBeenCalled();
    expect(result).toContain('"legs"');
  });

  it('set_event_exercises rejects bare rep counts on unilateral exercises', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('set_event_exercises')!.execute(
      { event_id: 'legs-day', event_title: 'Legs', exercises: [{ name: 'Pistol Squat', reps: '5' }] },
      deps,
    );
    expect(deps.updateEvent).not.toHaveBeenCalled();
    expect(deps.createDefinition).not.toHaveBeenCalled();
    expect(result).toMatch(/per side/);
  });

  it('create_event resolves an exercises array the same way', async () => {
    const deps = makeDeps();
    await findCoachTool('create_event')!.execute(
      {
        type: 'weights', title: 'Push', date: '2026-07-10', estimated_duration: 45,
        exercises: [{ name: 'Weighted Dip', reps: '8' }],
      },
      deps,
    );
    expect(deps.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      exercises: [expect.objectContaining({ definitionId: 'weighted-dip', weight: '25lb', reps: '8' })],
    }));
  });

  it('update_exercise_definition maps snake_case changes and matches by alias', async () => {
    const deps = makeDeps();
    const result = await findCoachTool('update_exercise_definition')!.execute(
      { name: 'Pistol Squats', changes: { technique_notes: 'Heel flat.', default_rest: '90s' } },
      deps,
    );
    expect(deps.updateDefinition).toHaveBeenCalledWith({
      id: 'pistol-squat',
      fields: { techniqueNotes: 'Heel flat.', defaultRest: '90s' },
    });
    expect(result).toContain('Pistol Squat');
  });

  it('update_exercise_definition rejects unknown exercises and unknown fields', async () => {
    const deps = makeDeps();
    const missing = await findCoachTool('update_exercise_definition')!.execute(
      { name: 'Nope', changes: { technique_notes: 'x' } },
      deps,
    );
    expect(missing).toContain('not in the exercise library');

    const badField = await findCoachTool('update_exercise_definition')!.execute(
      { name: 'Weighted Dip', changes: { weight: '50lb' } },
      deps,
    );
    expect(deps.updateDefinition).not.toHaveBeenCalled();
    expect(badField).toContain('set_event_exercises');
  });

  it('labels flag new library entries and blast radius when given context', () => {
    const ctx = {
      definitions: makeDeps().definitions,
      events: [
        { id: 'a', warmup: [], exercises: [{ id: 'x', name: 'Pistol Squat', category: 'skill', definitionId: 'pistol-squat' }], cooldown: [] },
        { id: 'a__2026-07-06', exercises: [{ id: 'x', name: 'Pistol Squat', category: 'skill', definitionId: 'pistol-squat' }] },
        { id: 'b', exercises: [{ id: 'y', name: 'Weighted Dip', category: 'strength', definitionId: 'weighted-dip' }] },
      ] as never[],
    };
    expect(findCoachTool('set_event_exercises')!.displayLabel(
      { event_title: 'Legs', exercises: [{ name: 'Pistol Squat' }, { name: 'Zercher Squat' }] },
      ctx,
    )).toBe('Set exercises: Legs · 2 exercises · adds 1 new: Zercher Squat');
    // Occurrences collapse to their base — one workout, not two.
    expect(findCoachTool('update_exercise_definition')!.displayLabel(
      { name: 'Pistol Squats', changes: { technique_notes: 'x' } },
      ctx,
    )).toBe('Edit exercise: Pistol Squats (technique_notes) — affects 1 workout');
  });

  it('builds human-readable confirmation labels', () => {
    expect(findCoachTool('delete_event')!.displayLabel({
      event_title: 'Upper Body', event_date_display: 'Mon Jun 29', scope: 'instance',
    })).toBe('Delete: Upper Body · Mon Jun 29 (this instance)');
    expect(findCoachTool('create_event')!.displayLabel({
      title: 'Flow', type: 'yoga', date: '2026-07-08',
    })).toBe('Create: Flow · yoga · 2026-07-08');
    expect(findCoachTool('update_event')!.displayLabel({
      event_title: 'Yoga', changes: { start_time: '6:00 AM' },
    })).toBe('Update: Yoga (start_time)');
  });
});
