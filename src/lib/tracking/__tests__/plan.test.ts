import { describe, it, expect } from 'vitest';
import {
  resolvePlannedSets,
  buildTrackerModel,
  buildLastPerformance,
  buildQuickCompleteLogs,
  collectUntouchedPlanned,
  plannedCardioMinutes,
  setExerciseNames,
  setToRow,
  cardioToRow,
  makeExtraSet,
} from '../plan';
import type { Exercise, WorkoutEvent } from '../../../types/workout';
import type { CardioLogRow, SetLogRow } from '../../db/types';

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
      is_autofilled: false,
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

describe('setExerciseNames', () => {
  it('collects non-cardio names across sections, deduped', () => {
    const event = makeEvent({ cooldown: [stretch] }); // same stretch as warmup
    expect(setExerciseNames(event)).toEqual(['Doorway Pec Stretch', 'Bench Press']);
  });
});

describe('buildLastPerformance', () => {
  const historyRow = (over: Partial<SetLogRow>): SetLogRow => ({
    event_id: 'w1-mon-weights__2026-06-26', event_date: '2026-06-26', section: 'exercise',
    exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 1,
    planned_weight: '185lb', planned_reps: '5', planned_duration: null,
    actual_weight: '185', actual_reps: '5', actual_duration: null,
    is_autofilled: false,
    ...over,
  });

  it('keeps only the most recent date per exercise name, regardless of row order', () => {
    const map = buildLastPerformance([
      historyRow({ event_date: '2026-06-19', actual_weight: '175' }),
      historyRow({ event_date: '2026-06-26', actual_weight: '185' }),
      historyRow({ event_date: '2026-06-26', set_number: 2, actual_reps: '4' }),
      historyRow({ event_date: '2026-06-19', set_number: 3, actual_weight: '175' }),
    ]);
    const bench = map.get('Bench Press')!;
    expect(bench.date).toBe('2026-06-26');
    expect(bench.sets.get(1)).toMatchObject({ weight: '185', reps: '5' });
    expect(bench.sets.get(2)).toMatchObject({ reps: '4' });
    expect(bench.sets.has(3)).toBe(false); // older session's set never bleeds in
  });

  it('ignores autofilled zero-fills and rows with no actuals', () => {
    const map = buildLastPerformance([
      historyRow({ event_date: '2026-06-28', is_autofilled: true }),
      historyRow({ event_date: '2026-06-27', actual_weight: null, actual_reps: null, actual_duration: null }),
      historyRow({ event_date: '2026-06-20' }),
    ]);
    expect(map.get('Bench Press')!.date).toBe('2026-06-20');
  });

  it('returns an empty map for no history', () => {
    expect(buildLastPerformance([]).size).toBe(0);
  });
});

describe('plannedCardioMinutes', () => {
  it('parses plain, ranged, approximate, and hour durations', () => {
    expect(plannedCardioMinutes('45 min')).toBe(45);
    expect(plannedCardioMinutes('30–40 min')).toBe(30); // range logs its floor
    expect(plannedCardioMinutes('~2 min')).toBe(2);
    expect(plannedCardioMinutes('1 hr')).toBe(60);
    expect(plannedCardioMinutes('90s')).toBe(1.5);
  });

  it('returns null for missing or unparseable values', () => {
    expect(plannedCardioMinutes(undefined)).toBeNull();
    expect(plannedCardioMinutes('easy spin')).toBeNull();
  });
});

describe('buildQuickCompleteLogs', () => {
  it('logs every planned set at its targets, flagged autofilled', () => {
    const { setLogs } = buildQuickCompleteLogs(makeEvent());
    // 1 warmup stretch set + 3 bench sets; cardio is separate
    expect(setLogs).toHaveLength(4);
    expect(setLogs.every(r => r.is_autofilled)).toBe(true);

    const bench = setLogs.filter(r => r.exercise_id === 'ub-1');
    expect(bench.map(r => r.set_number)).toEqual([1, 2, 3]);
    expect(bench[0]).toMatchObject({
      event_id: 'w1-mon-weights__2026-07-06',
      event_date: '2026-07-06',
      section: 'exercise',
      planned_weight: '185lb', actual_weight: '185lb',
      planned_reps: '5', actual_reps: '5',
      planned_duration: null, actual_duration: null,
    });

    const stretchRow = setLogs.find(r => r.exercise_id === 'ub-cd-1');
    expect(stretchRow).toMatchObject({
      section: 'warmup',
      planned_duration: '60s', actual_duration: '60s',
      actual_weight: null, actual_reps: null,
    });
  });

  it('honors authored plannedSets (ramps) over legacy synthesis', () => {
    const ramp: Exercise = {
      ...strength,
      plannedSets: [
        { setNumber: 1, targetWeight: '135lb', targetReps: '5' },
        { setNumber: 2, targetWeight: '185lb', targetReps: '3' },
      ],
    };
    const { setLogs } = buildQuickCompleteLogs(makeEvent({ warmup: [], exercises: [ramp] }));
    expect(setLogs.map(r => r.actual_weight)).toEqual(['135lb', '185lb']);
  });

  it('logs cardio at its planned duration with no invented metrics', () => {
    const { cardioLogs } = buildQuickCompleteLogs(makeEvent());
    expect(cardioLogs).toHaveLength(1);
    expect(cardioLogs[0]).toMatchObject({
      exercise_id: 'run-1',
      duration_minutes: 45,
      distance: null,
      elevation_gain: null,
      avg_heart_rate: null,
      is_autofilled: true,
    });
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
