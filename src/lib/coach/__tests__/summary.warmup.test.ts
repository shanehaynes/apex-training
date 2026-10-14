import { describe, it, expect } from 'vitest';
import { buildSessionRecap } from '../summary';
import { buildTrackerModel } from '../../tracking/plan';
import type { SetLogRow } from '../../db/types';
import type { WorkoutEvent } from '../../../types/workout';

// The recap the summary model narrates counts working sets only: a warm-up
// is neither a set done nor a set skipped (isPerformedSet).

const EVENT = {
  id: 'evt-1', type: 'weights', title: 'Upper Body', date: '2026-08-06',
  exercises: [{ id: 'bench', name: 'Bench Press', category: 'strength', sets: 3, reps: '5' }],
} as unknown as WorkoutEvent;

function row(setNumber: number, weight: string, isWarmup: boolean): SetLogRow {
  return {
    event_id: 'evt-1', event_date: '2026-08-06', section: 'exercise', exercise_id: 'bench', exercise_name: 'Bench Press',
    set_number: setNumber, planned_weight: null, planned_reps: '5', planned_duration: null,
    actual_weight: weight, actual_reps: '5', actual_duration: null, is_autofilled: false, is_warmup: isWarmup,
  } as SetLogRow;
}

describe('buildSessionRecap — warm-up sets', () => {
  it('leaves a warm-up out of the sets done, and does not call it skipped', () => {
    const groups = buildTrackerModel(EVENT, [row(1, '60', true), row(2, '100', false), row(3, '105', false)], []);
    const recap = buildSessionRecap(EVENT, groups, null, []);
    expect(recap).toContain('- Bench Press: 100 × 5; 105 × 5\n');
    expect(recap).not.toContain('60 × 5');
    expect(recap).not.toContain('skipped');
  });

  it('an exercise of warm-ups only reads as no sets logged', () => {
    const groups = buildTrackerModel(
      { ...EVENT, exercises: [{ ...EVENT.exercises[0], sets: 1 }] } as WorkoutEvent,
      [row(1, '60', true)], [],
    );
    expect(buildSessionRecap(EVENT, groups, null, [])).toContain('- Bench Press: no sets logged\n');
  });
});
