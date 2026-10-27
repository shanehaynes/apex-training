import { describe, it, expect } from 'vitest';
import { buildBootstrap } from '../_lib/trackerSession';
import type { WorkoutSessionRow } from '../../src/lib/db/types';
import type { WorkoutEvent } from '../../src/types/workout';

type Admin = Parameters<typeof buildBootstrap>[0];

// A mid-workout reorder is saved on the session (workout_sessions.exercise_order)
// and applied by the bootstrap, so a reload and the iPhone app — which renders
// groups exactly as the bootstrap hands them over — show the athlete's order.

/** A fake whose every read comes back empty: no saved sets, notes or history. */
function emptyAdmin(): Admin {
  return {
    from() {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'range', 'not', 'is', 'gte', 'lte', 'eq', 'lt', 'in']) builder[m] = () => builder;
      builder.maybeSingle = async () => ({ data: null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return builder;
    },
  } as unknown as Admin;
}

const EVENT = {
  id: 'evt-1', date: '2026-08-20', title: 'Legs', type: 'weights', estimatedDuration: 45, description: '',
  difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
  exercises: ['squat', 'rdl', 'lunge', 'calf'].map(id => ({ id, name: id, category: 'strength', sets: 1, reps: '5' })),
} as unknown as WorkoutEvent;

const session = (exercise_order: unknown) =>
  ({ started_at: '2026-08-20T09:30:00.000Z', finished_at: null, exercise_order }) as WorkoutSessionRow;

const order = async (exercise_order: unknown) => {
  const boot = await buildBootstrap(emptyAdmin(), 'u1', session(exercise_order), EVENT);
  return boot.groups.find(g => g.section === 'exercise')!.exercises.map(t => t.exercise.id);
};

describe('bootstrap applies the session exercise order', () => {
  it('puts the saved ids first, in the saved order, and the rest after in plan order', async () => {
    expect(await order({ exercise: ['calf', 'squat'] })).toEqual(['calf', 'squat', 'rdl', 'lunge']);
  });

  it('keeps plan order with no saved order, or one that is not a valid order', async () => {
    expect(await order(null)).toEqual(['squat', 'rdl', 'lunge', 'calf']);
    expect(await order('garbage')).toEqual(['squat', 'rdl', 'lunge', 'calf']);
    expect(await order({ exercises: ['calf'] })).toEqual(['squat', 'rdl', 'lunge', 'calf']);
  });
});
