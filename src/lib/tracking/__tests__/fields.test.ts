import { describe, expect, it } from 'vitest';
import type { Exercise, ExerciseDefinition } from '../../../types/workout';
import { buildTrackerModel, type TrackedExercise } from '../plan';
import { inputFields } from '../fields';

function tracked(exercise: Partial<Exercise>): TrackedExercise {
  const groups = buildTrackerModel({
    id: 'evt', title: 'Pull day', date: '2026-10-10', type: 'weights',
    exercises: [{ id: 'ring-pull-up', name: 'Ring Pull-Up', category: 'strength', definitionId: 'ring-pull-up', ...exercise }],
  } as Parameters<typeof buildTrackerModel>[0]);
  return groups[0].exercises[0];
}

const ringPullUp = (over: Partial<ExerciseDefinition> = {}): ExerciseDefinition => ({
  id: 'ring-pull-up', canonicalName: 'Ring Pull-Up', aliases: [], category: 'strength',
  muscleGroups: [], equipment: [], isUnilateral: false, ...over,
});

describe('inputFields', () => {
  it('offers only what the prescription names by default', () => {
    expect(inputFields(tracked({ sets: 3, reps: '8' }), ringPullUp())).toEqual(['actualReps']);
  });

  it('adds the dimensions the definition is always logged in', () => {
    const def = ringPullUp({ logFields: ['weight'] });
    expect(inputFields(tracked({ sets: 3, reps: '8' }), def)).toEqual(['actualWeight', 'actualReps']);
  });

  it('adds a dimension picked this sitting before the definition write lands', () => {
    expect(inputFields(tracked({ sets: 3, reps: '8' }), ringPullUp(), ['actualWeight']))
      .toEqual(['actualWeight', 'actualReps']);
  });

  it('keeps an ad-hoc entry (no definition) working with a sitting-only addition', () => {
    expect(inputFields(tracked({ sets: 3, reps: '8', definitionId: undefined }), undefined, ['actualDuration']))
      .toEqual(['actualReps', 'actualDuration']);
  });

  it('never lets a log field displace the reps fallback or reorder columns', () => {
    const def = ringPullUp({ logFields: ['duration', 'weight'] });
    expect(inputFields(tracked({ sets: 2 }), def)).toEqual(['actualWeight', 'actualDuration']);
  });

  it('leaves a climbing pitch on its single grade input', () => {
    const def = ringPullUp({ category: 'climbing', logFields: ['reps'] });
    expect(inputFields(tracked({ category: 'climbing', grade: '5.11a' }), def)).toEqual(['actualWeight']);
  });
});

describe('buildTrackerModel — session notes', () => {
  it('hydrates a note by section and plan entry id, and only there', () => {
    const groups = buildTrackerModel(
      {
        id: 'evt', title: 'Pull day', date: '2026-10-10', type: 'weights',
        warmup: [{ id: 'ring-pull-up', name: 'Ring Pull-Up', category: 'strength', reps: '5' }],
        exercises: [{ id: 'ring-pull-up', name: 'Ring Pull-Up', category: 'strength', reps: '8' }],
      } as Parameters<typeof buildTrackerModel>[0],
      [], [], new Map(), new Map(),
      [{ event_id: 'evt', event_date: '2026-10-10', section: 'exercise', exercise_id: 'ring-pull-up', note: 'blue band' }],
    );
    expect(groups.find(g => g.section === 'warmup')!.exercises[0].sessionNote).toBe('');
    expect(groups.find(g => g.section === 'exercise')!.exercises[0].sessionNote).toBe('blue band');
  });
});
