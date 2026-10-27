import { describe, it, expect } from 'vitest';
import { applyExerciseOrder, exerciseOrderOf, moveTrackedExercise, parseExerciseOrder } from '../order';
import type { TrackedExercise, TrackedSectionGroup } from '../plan';
import type { TrackedSection } from '../../db/types';

const tracked = (section: TrackedSection, id: string): TrackedExercise => ({
  section, exercise: { id, name: id, category: 'strength' }, isCardio: false, sets: [], cardio: null,
  substitutedFrom: null, sessionNote: '',
});
const group = (section: TrackedSection, ids: string[]): TrackedSectionGroup => ({
  section, label: section, exercises: ids.map(id => tracked(section, id)),
});
const ids = (groups: TrackedSectionGroup[], section: TrackedSection) =>
  groups.find(g => g.section === section)!.exercises.map(t => t.exercise.id);

describe('parseExerciseOrder', () => {
  it('accepts a section → distinct ids map', () => {
    expect(parseExerciseOrder({ exercise: ['b', 'a'], warmup: [] })).toEqual({ exercise: ['b', 'a'], warmup: [] });
  });

  it('refuses anything else whole', () => {
    for (const bad of [null, 'x', ['a'], { exercises: ['a'] }, { exercise: 'a' }, { exercise: ['a', 'a'] },
      { exercise: [1] }, { exercise: [''] }, { exercise: ['x'.repeat(201)] },
      { exercise: Array.from({ length: 501 }, (_, i) => `e${i}`) }]) {
      expect(parseExerciseOrder(bad), JSON.stringify(bad).slice(0, 40)).toBeNull();
    }
  });
});

describe('applyExerciseOrder', () => {
  const groups = [group('warmup', ['w1', 'w2']), group('exercise', ['squat', 'bench', 'row', 'curl'])];

  it('puts the named ids first, in the saved order, and the rest after in plan order', () => {
    const out = applyExerciseOrder(groups, { exercise: ['curl', 'squat'] });
    expect(ids(out, 'exercise')).toEqual(['curl', 'squat', 'bench', 'row']);
    expect(out[0], 'a section the order leaves out is untouched').toBe(groups[0]);
  });

  it('ignores ids that are no longer in the workout', () => {
    expect(ids(applyExerciseOrder(groups, { exercise: ['gone', 'row'] }), 'exercise'))
      .toEqual(['row', 'squat', 'bench', 'curl']);
  });

  it('returns the groups as they are with no order, or an order that changes nothing', () => {
    expect(applyExerciseOrder(groups, null)).toBe(groups);
    expect(applyExerciseOrder(groups, { exercise: ['squat', 'bench'] })[1]).toBe(groups[1]);
  });

  it('round-trips what exerciseOrderOf saves', () => {
    const moved = moveTrackedExercise(groups, 'exercise', 3, 0);
    const reloaded = applyExerciseOrder(groups, parseExerciseOrder(exerciseOrderOf(moved)));
    expect(ids(reloaded, 'exercise')).toEqual(['curl', 'squat', 'bench', 'row']);
    expect(ids(reloaded, 'warmup')).toEqual(['w1', 'w2']);
  });
});

describe('moveTrackedExercise', () => {
  const groups = [group('warmup', ['w1', 'w2']), group('exercise', ['a', 'b', 'c'])];

  it('moves within the named section only', () => {
    const out = moveTrackedExercise(groups, 'exercise', 0, 2);
    expect(ids(out, 'exercise')).toEqual(['b', 'c', 'a']);
    expect(out[0]).toBe(groups[0]);
  });

  it('leaves a no-op or out-of-range move alone', () => {
    expect(moveTrackedExercise(groups, 'exercise', 1, 1)[1]).toBe(groups[1]);
    expect(moveTrackedExercise(groups, 'exercise', 0, 3)[1]).toBe(groups[1]);
  });
});
