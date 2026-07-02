import { describe, it, expect } from 'vitest';
import {
  resolvePlannedSets,
  buildTrackerModel,
  collectUntouchedPlanned,
  setToRow,
  cardioToRow,
  makeExtraSet,
} from '../plan';
import type { Exercise, WorkoutEvent } from '../../../types/workout';
import type { CardioLogRow, SetLogRow } from '../../supabaseClient';

const strength: Exercise = {
  id: 'ub-1',
  name: 'Bench Press',
  category: 'strength',
  sets: 3,
  reps: '5',
  weight: '185lb',
};

const stretch: Exercise = {
  id: 'ub-cd-1',
  name: 'Doorway Pec Stretch',
  category: 'stretch',
  duration: '60s',
};

const cardio: Exercise = {
  id: 'run-1',
  name: 'Zone 2 Run',
  category: 'cardio',
  duration: '45 min',
};

function makeEvent(overrides: Partial<WorkoutEvent> = {}): WorkoutEvent {
  return {
    id: 'w1-mon-weights__2026-07-06',
    type: 'weights',
    title: 'Upper Body',
    date: '2026-07-06',
    estimatedDuration: 60,
    description: '',
    warmup: [stretch],
    exercises: [strength, cardio],
    cooldown: [],
    difficulty: 3,
    tags: [],
    isCompleted: false,
    isRecurring: true,
    ...overrides,
  };
}

describe('resolvePlannedSets', () => {
  it('synthesizes uniform targets from legacy fields', () => {
    const planned = resolvePlannedSets(strength);
    expect(planned).toHaveLength(3);
    expect(planned[0]).toEqual({ setNumber: 1, targetWeight: '185lb', targetReps: '5', targetDuration: undefined });
    expect(planned[2].setNumber).toBe(3);
  });

  it('defaults to one set when sets is missing', () => {
    expect(resolvePlannedSets(stretch)).toHaveLength(1);
  });

  it('prefers authored plannedSets over synthesis (ramps)', () => {
    const ramp: Exercise = {
      ...strength,
      plannedSets: [
        { setNumber: 1, targetWeight: '135lb', targetReps: '5' },
        { setNumber: 2, targetWeight: '165lb', targetReps: '5' },
        { setNumber: 3, targetWeight: '185lb', targetReps: '3' },
      ],
    };
    const planned = resolvePlannedSets(ramp);
    expect(planned.map(p => p.targetWeight)).toEqual(['135lb', '165lb', '185lb']);
  });
});

describe('buildTrackerModel', () => {
  it('groups sections, omits empty ones, and splits cardio from set work', () => {
    const groups = buildTrackerModel(makeEvent());
    expect(groups.map(g => g.section)).toEqual(['warmup', 'exercise']); // empty cooldown dropped
    const main = groups[1];
    expect(main.exercises[0].isCardio).toBe(false);
    expect(main.exercises[0].sets).toHaveLength(3);
    expect(main.exercises[1].isCardio).toBe(true);
    expect(main.exercises[1].sets).toHaveLength(0);
    expect(main.exercises[1].cardio).not.toBeNull();
  });

  it('hydrates saved set logs including extra sets beyond the plan', () => {
    const saved: SetLogRow[] = [
      {
        event_id: 'e', event_date: '2026-07-06', section: 'exercise',
        exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 2,
        planned_weight: '185lb', planned_reps: '5', planned_duration: null,
        actual_weight: '185', actual_reps: '4', actual_duration: null,
        is_autofilled: false,
      },
      {
        event_id: 'e', event_date: '2026-07-06', section: 'exercise',
        exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 4,
        planned_weight: null, planned_reps: null, planned_duration: null,
        actual_weight: '135', actual_reps: '10', actual_duration: null,
        is_autofilled: false,
      },
    ];
    const groups = buildTrackerModel(makeEvent(), saved);
    const bench = groups[1].exercises[0];
    expect(bench.sets).toHaveLength(4);
    expect(bench.sets[1]).toMatchObject({ setNumber: 2, actualReps: '4', isLogged: true, isExtra: false });
    expect(bench.sets[3]).toMatchObject({ setNumber: 4, actualReps: '10', isLogged: true, isExtra: true });
    expect(bench.sets[0].isLogged).toBe(false);
  });

  it('hydrates saved cardio logs', () => {
    const saved: CardioLogRow[] = [{
      event_id: 'e', event_date: '2026-07-06', section: 'exercise',
      exercise_id: 'run-1', exercise_name: 'Zone 2 Run',
      duration_minutes: 45.5, distance: '5 mi', elevation_gain: null, avg_heart_rate: 142,
    }];
    const groups = buildTrackerModel(makeEvent(), [], saved);
    const run = groups[1].exercises[1];
    expect(run.cardio).toMatchObject({
      durationMinutes: '45.5', distance: '5 mi', elevationGain: '', avgHeartRate: '142', isLogged: true,
    });
  });
});

describe('collectUntouchedPlanned', () => {
  it('zero-fills only pristine planned sets, never extras or edited sets', () => {
    const groups = buildTrackerModel(makeEvent());
    const bench = groups[1].exercises[0];
    bench.sets[0].actualReps = '5'; // touched this sitting
    bench.sets.push(makeExtraSet(4)); // extra, untouched

    const rows = collectUntouchedPlanned('eid', '2026-07-06', groups);
    // bench sets 2+3 and the warmup stretch's single set
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.is_autofilled)).toBe(true);

    const benchRows = rows.filter(r => r.exercise_id === 'ub-1');
    expect(benchRows.map(r => r.set_number).sort()).toEqual([2, 3]);
    expect(benchRows[0]).toMatchObject({ actual_weight: '0', actual_reps: '0', actual_duration: null });

    const stretchRow = rows.find(r => r.exercise_id === 'ub-cd-1');
    expect(stretchRow).toMatchObject({ actual_duration: '0', actual_weight: null, actual_reps: null });
  });

  it('skips sets already persisted in a previous sitting', () => {
    const saved: SetLogRow[] = [{
      event_id: 'e', event_date: '2026-07-06', section: 'warmup',
      exercise_id: 'ub-cd-1', exercise_name: 'Doorway Pec Stretch', set_number: 1,
      planned_weight: null, planned_reps: null, planned_duration: '60s',
      actual_weight: null, actual_reps: null, actual_duration: '60s',
      is_autofilled: false,
    }];
    const groups = buildTrackerModel(makeEvent(), saved);
    const rows = collectUntouchedPlanned('eid', '2026-07-06', groups);
    expect(rows.some(r => r.exercise_id === 'ub-cd-1')).toBe(false);
  });
});

describe('row serialization', () => {
  it('setToRow snapshots planned targets and nulls empty actuals', () => {
    const groups = buildTrackerModel(makeEvent());
    const bench = groups[1].exercises[0];
    const set = { ...bench.sets[0], actualWeight: '185', actualReps: '' };
    const row = setToRow('eid', '2026-07-06', bench, set);
    expect(row).toMatchObject({
      event_id: 'eid',
      section: 'exercise',
      exercise_id: 'ub-1',
      exercise_name: 'Bench Press',
      set_number: 1,
      planned_weight: '185lb',
      planned_reps: '5',
      actual_weight: '185',
      actual_reps: null,
      is_autofilled: false,
    });
  });

  it('cardioToRow parses numerics and nulls blanks', () => {
    const groups = buildTrackerModel(makeEvent());
    const run = { ...groups[1].exercises[1] };
    run.cardio = { durationMinutes: '42.5', distance: '', elevationGain: '900 ft', avgHeartRate: 'abc', isLogged: false };
    const row = cardioToRow('eid', '2026-07-06', run);
    expect(row).toMatchObject({
      duration_minutes: 42.5,
      distance: null,
      elevation_gain: '900 ft',
      avg_heart_rate: null,
    });
  });
});
