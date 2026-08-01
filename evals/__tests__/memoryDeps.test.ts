import { describe, it, expect } from 'vitest';
import { createMemoryDeps } from '../src/memoryDeps';
import { loadLibrary } from '../src/library';
import { findCoachTool } from '../../src/lib/coach/tools';
import { makeEvent } from '../src/fixtures';

// The real executors from src/lib/coach/tools.ts running against the
// in-memory deps — verifying the tool_result strings match production
// semantics, including the unilateral-rejection error the model must
// recover from.

describe('createMemoryDeps + real executors', () => {
  it('create_event resolves canonical names without forking the library', async () => {
    const { deps, state } = createMemoryDeps([], loadLibrary());
    const result = await findCoachTool('create_event')!.execute({
      type: 'weights', title: 'Pull Day', date: '2026-08-08', estimated_duration: 60,
      exercises: [{ name: 'Barbell Row', sets: 4, reps: '8' }],
    }, deps);
    expect(result).toContain('Created "Pull Day"');
    expect(result).not.toContain('new exercise');
    expect(state.createdDefinitionNames).toEqual([]);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].exercises[0].definitionId).toBeTruthy();
  });

  it('create_event with an unknown name creates a definition and reports it', async () => {
    const { deps, state } = createMemoryDeps([], loadLibrary());
    const result = await findCoachTool('create_event')!.execute({
      type: 'cardio', title: 'Run', date: '2026-08-08', estimated_duration: 40,
      exercises: [{ name: 'Easy Run', category: 'cardio', duration: '40 min' }],
    }, deps);
    expect(result).toContain('Added 1 new exercise');
    expect(state.createdDefinitionNames).toEqual(['Easy Run']);
  });

  it('rejects unilateral exercises without per-side counts, exactly like production', async () => {
    const { deps, state } = createMemoryDeps(
      [makeEvent({ id: 'evt-1', date: '2026-08-03', title: 'Legs' })],
      loadLibrary(),
    );
    const result = await findCoachTool('set_event_exercises')!.execute({
      event_id: 'evt-1',
      exercises: [{ name: 'Pistol Squats', sets: 3, reps: '5' }],
    }, deps);
    expect(result).toContain('Unilateral exercises need per-side counts');
    expect(state.events[0].exercises).toHaveLength(0);

    const retry = await findCoachTool('set_event_exercises')!.execute({
      event_id: 'evt-1',
      exercises: [{ name: 'Pistol Squats', sets: 3, reps: '5 each leg' }],
    }, deps);
    expect(retry).toContain('Replaced the exercises list');
    expect(state.events[0].exercises).toHaveLength(1);
  });

  it('refuses set_event_exercises on an occurrence id, like production', async () => {
    const { deps } = createMemoryDeps(
      [makeEvent({ id: 'evt-rec__2026-08-05', date: '2026-08-05', title: 'Yoga', isRecurring: true })],
      loadLibrary(),
    );
    const result = await findCoachTool('set_event_exercises')!.execute({
      event_id: 'evt-rec__2026-08-05',
      exercises: [{ name: 'Cat-Cow', duration: '2 min' }],
    }, deps);
    expect(result).toContain('Cannot change exercises on a single occurrence');
  });

  it('update_event and delete_event mutate fixture state', async () => {
    const { deps, state } = createMemoryDeps(
      [makeEvent({ id: 'evt-1', date: '2026-08-05', title: 'Strength' })],
      loadLibrary(),
    );
    const updated = await findCoachTool('update_event')!.execute({
      event_id: 'evt-1', event_title: 'Strength', changes: { date: '2026-08-06' },
    }, deps);
    expect(updated).toContain('Updated the event successfully');
    expect(state.events[0].date).toBe('2026-08-06');

    const deleted = await findCoachTool('delete_event')!.execute({
      event_id: 'evt-1', event_title: 'Strength', scope: 'all',
    }, deps);
    expect(deleted).toContain('Deleted the event successfully');
    expect(state.events).toHaveLength(0);
  });

  it('update_exercise_definition renames preserve the old name as an alias', async () => {
    const { deps, state } = createMemoryDeps([], loadLibrary());
    const result = await findCoachTool('update_exercise_definition')!.execute({
      name: 'Face Pulls', changes: { canonical_name: 'Cable Face Pulls' },
    }, deps);
    expect(result).toContain('Updated');
    const def = [...state.definitions.values()].find(d => d.canonicalName === 'Cable Face Pulls');
    expect(def?.aliases).toContain('Face Pulls');
  });
});
