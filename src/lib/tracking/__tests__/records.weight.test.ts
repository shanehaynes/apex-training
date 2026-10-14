import { describe, it, expect } from 'vitest';
import {
  bestHistoricalOneRM,
  bestHistoricalReps,
  classifySet,
  computeSessionPRs,
  describeRecord,
  describeRecordForPeople,
  estimateOneRepMax,
} from '../records';
import { DEFAULT_WEIGHT_CONTEXT, LB_PER_KG, type WeightContext } from '../weight';
import { buildTrackerModel } from '../plan';
import type { Exercise, WorkoutEvent } from '../../../types/workout';
import type { SetLogRow } from '../../db/types';

// classifySet and the PR pipeline read weights through parseWeight: a bare
// number means the profile's unit, a suffix wins, "BW±N" resolves against
// the profile's body weight, and every number out is a pound float.

const KG: WeightContext = { unit: 'kg', bodyWeightLb: null };
const BW: WeightContext = { unit: 'lb', bodyWeightLb: 180 };

const bench: Exercise = { id: 'ub-1', name: 'Bench Press', category: 'strength', sets: 2, reps: '5', weight: '185lb' };

function makeEvent(exercises: Exercise[]): WorkoutEvent {
  return {
    id: 'w1__2026-07-06', type: 'weights', title: 'Upper Body', date: '2026-07-06', estimatedDuration: 60,
    description: '', exercises, difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
  };
}

function row(overrides: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'w0__2026-06-01', event_date: '2026-06-01', section: 'exercise', exercise_id: 'ub-1',
    exercise_name: 'Bench Press', set_number: 1, planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: '185', actual_reps: '5', actual_duration: null, is_autofilled: false, ...overrides,
  };
}

function groupsWith(exercise: Exercise, actuals: Array<{ weight?: string; reps?: string }>) {
  const groups = buildTrackerModel(makeEvent([exercise]));
  const tracked = groups[0].exercises[0];
  tracked.sets = tracked.sets.map((s, i) =>
    actuals[i] ? { ...s, actualWeight: actuals[i].weight ?? '', actualReps: actuals[i].reps ?? '', actualDuration: '' } : s,
  );
  return groups;
}

describe('classifySet with a WeightContext', () => {
  it('reads a bare number in the profile unit and a suffix in its own, as pound floats', () => {
    expect(classifySet('80', '5', null, KG)).toEqual({ kind: 'oneRM', weight: 80 * LB_PER_KG, reps: 5, oneRM: estimateOneRepMax(80 * LB_PER_KG, 5), load: 'absolute' });
    expect(classifySet('62.5 kg', '5', null)).toMatchObject({ kind: 'oneRM', weight: 62.5 * LB_PER_KG, load: 'absolute' });
    expect(classifySet('185 lb', '5', null, KG)).toMatchObject({ kind: 'oneRM', weight: 185, load: 'absolute' });
    expect(classifySet('185', '5', null)).toMatchObject({ kind: 'oneRM', weight: 185, load: 'absolute' });
  });

  it('resolves BW forms against the body weight and tags them bodyweight; without one they stay reps-only', () => {
    expect(classifySet('BW', '10', null, BW)).toMatchObject({ kind: 'oneRM', weight: 180, reps: 10, load: 'bodyweight' });
    expect(classifySet('BW+25', '5', null, BW)).toMatchObject({ kind: 'oneRM', weight: 205, load: 'bodyweight' });
    expect(classifySet('bw-10kg', '5', null, BW)).toMatchObject({ kind: 'oneRM', weight: 180 - 10 * LB_PER_KG, load: 'bodyweight' });
    expect(classifySet('BW', '10', null, DEFAULT_WEIGHT_CONTEXT)).toEqual({ kind: 'reps', reps: 10 });
    expect(classifySet('BW+25', '10', null, KG)).toEqual({ kind: 'reps', reps: 10 });
  });

  it('keeps the zero gate and the fall-through for text the grammar rejects', () => {
    expect(classifySet('0', '10', null, KG)).toEqual({ kind: 'reps', reps: 10 });
    expect(classifySet('100kg x 5', '5', '60s', KG)).toEqual({ kind: 'duration', seconds: 60 });
    expect(classifySet('heavy', '8', null, BW)).toEqual({ kind: 'reps', reps: 8 });
  });
});

describe('PR detection with a WeightContext', () => {
  it('compares kg and lb history on the pound float, not the typed number', () => {
    // 90 kg × 5 (198.4 lb) beats 185 lb × 5 but not 200 lb × 5.
    const history = [row({ actual_weight: '200 lb' }), row({ actual_weight: '185 lb', event_date: '2026-05-01' })];
    expect(bestHistoricalOneRM(history, KG).get('Bench Press')?.weight).toBe(200);
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '90', reps: '5' }]), history, [], KG)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '92', reps: '5' }]), history, [], KG)).toMatchObject([
      { kind: 'oneRM', weight: 92 * LB_PER_KG, reps: 5 },
    ]);
    // The old parser read "90" as 90 lb and would never have seen a PR.
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '92', reps: '5' }]), history)).toHaveLength(0);
  });

  it('lets a bodyweight set earn a 1RM PR, and moves BW rows out of the reps lineage', () => {
    const history = [row({ actual_weight: 'BW', actual_reps: '10' })];
    expect(bestHistoricalReps(history).get('Bench Press')?.value).toBe(10);
    expect(bestHistoricalReps(history, BW).has('Bench Press')).toBe(false);
    expect(bestHistoricalOneRM(history, BW).get('Bench Press')).toMatchObject({ weight: 180, reps: 10 });
    const prs = computeSessionPRs(groupsWith(bench, [{ weight: 'BW+25', reps: '10' }]), history, [], BW);
    expect(prs).toMatchObject([{ kind: 'oneRM', weight: 205, reps: 10, previousOneRM: estimateOneRepMax(180, 10) }]);
  });
});

describe('record descriptions', () => {
  const pr = { kind: 'oneRM' as const, exerciseName: 'Bench Press', estimatedOneRM: 216.07, weight: 185, reps: 5, previousOneRM: 206, previousDate: '2026-06-12' };

  it('keeps the machine string in pounds, byte-identical for lb inputs, rounded for a kg conversion', () => {
    expect(describeRecord(pr)).toBe('est. 1RM 216 (185 × 5), up from 206 on Jun 12');
    expect(describeRecord({ ...pr, weight: 62.5 })).toBe('est. 1RM 216 (62.5 × 5), up from 206 on Jun 12');
    expect(describeRecord({ ...pr, weight: 62.5 * LB_PER_KG })).toBe('est. 1RM 216 (138 × 5), up from 206 on Jun 12');
  });

  it('shows people the numbers in their unit', () => {
    expect(describeRecordForPeople(pr)).toBe('est. best single lift 216 (185 × 5), up from 206 on Jun 12');
    expect(describeRecordForPeople(pr, 'kg')).toBe('est. best single lift 98 (83.9 × 5), up from 93 on Jun 12');
  });
});
