import { describe, it, expect } from 'vitest';
import {
  resolvePlannedSets,
  buildTrackerModel,
  buildLastPerformance,
  buildLastCardio,
  buildQuickCompleteLogs,
  collectUntouchedPlanned,
  hasLoggedData,
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

  it('gives a climbing pitch one set with the grade as its target', () => {
    const pitch: Exercise = { id: 'pitch', name: 'Sport', category: 'climbing', climbStyle: 'sport', grade: '5.11a' };
    expect(resolvePlannedSets(pitch)).toEqual([{ setNumber: 1, targetWeight: '5.11a' }]);
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

  it('relabels sections for outdoor climbing events', () => {
    const pitch: Exercise = { id: 'p1', name: 'Trad', category: 'climbing', climbStyle: 'trad', grade: '5.9' };
    const approach: Exercise = { id: 'appr', name: 'Approach Hike', category: 'cardio', duration: '40 min' };
    const groups = buildTrackerModel(makeEvent({
      type: 'outdoor-climbing', warmup: [approach], exercises: [pitch], cooldown: [approach],
    }));
    expect(groups.map(g => g.label)).toEqual(['Approach', 'Pitches', 'Descent']);
    expect(groups[0].exercises[0].isCardio).toBe(true);
    expect(groups[1].exercises[0].sets).toHaveLength(1);
    expect(groups[1].exercises[0].sets[0].planned.targetWeight).toBe('5.9');
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

describe('buildTrackerModel — swapped (substituted) exercises', () => {
  // Ring dips were planned and logged; the lifter actually did single-arm DB
  // press and relabelled the rows afterwards.
  const swappedRow = (overrides: Partial<SetLogRow> = {}): SetLogRow => ({
    event_id: 'e', event_date: '2026-07-06', section: 'exercise',
    exercise_id: 'ub-1', exercise_name: 'Single-Arm Dumbbell Press',
    definition_id: 'def-db-press', set_number: 1,
    planned_weight: '185lb', planned_reps: '5', planned_duration: null,
    actual_weight: '45', actual_reps: '8 each arm', actual_duration: null,
    is_autofilled: false,
    ...overrides,
  });

  it('renders the logged movement, remembering what it replaced', () => {
    const groups = buildTrackerModel(makeEvent(), [swappedRow()]);
    const swapped = groups[1].exercises[0];
    expect(swapped.exercise.name).toBe('Single-Arm Dumbbell Press');
    expect(swapped.exercise.definitionId).toBe('def-db-press');
    expect(swapped.substitutedFrom).toBe('Bench Press');
    // The entry id never moves — every log row keys on it.
    expect(swapped.exercise.id).toBe('ub-1');
    expect(swapped.sets[0]).toMatchObject({ actualWeight: '45', actualReps: '8 each arm', isLogged: true });
  });

  it('leaves the planned targets on the sets — the plan is what was prescribed', () => {
    const groups = buildTrackerModel(makeEvent(), [swappedRow()]);
    expect(groups[1].exercises[0].sets[0].planned).toMatchObject({ targetWeight: '185lb', targetReps: '5' });
  });

  it('takes ghosts from the swapped-in movement, not the planned one', () => {
    const last = buildLastPerformance([{
      event_id: 'old__2026-06-26', event_date: '2026-06-26', section: 'exercise',
      exercise_id: 'whatever', exercise_name: 'Single-Arm Dumbbell Press', set_number: 2,
      planned_weight: null, planned_reps: null, planned_duration: null,
      actual_weight: '40', actual_reps: '10 each arm', actual_duration: null,
      is_autofilled: false,
    }]);
    const groups = buildTrackerModel(makeEvent(), [swappedRow()], [], last);
    expect(groups[1].exercises[0].sets[1].shadow).toMatchObject({ weight: '40', reps: '10 each arm' });
  });

  it('swaps cardio logs too', () => {
    const groups = buildTrackerModel(makeEvent(), [], [{
      event_id: 'e', event_date: '2026-07-06', section: 'exercise',
      exercise_id: 'run-1', exercise_name: 'Assault Bike', definition_id: 'def-bike',
      duration_minutes: 30, distance: null, elevation_gain: null, avg_heart_rate: null,
      is_autofilled: false,
    }]);
    const bike = groups[1].exercises[1];
    expect(bike.exercise.name).toBe('Assault Bike');
    expect(bike.substitutedFrom).toBe('Zone 2 Run');
    expect(bike.cardio).toMatchObject({ durationMinutes: '30', isLogged: true });
  });

  it('reads a library rename as the plan catching up, not as a swap', () => {
    // Same definition, different name: the plan entry resolved to the new
    // canonical name while the row still carries the old one.
    const renamed = makeEvent({
      exercises: [{ ...strength, name: 'Barbell Bench Press', definitionId: 'def-bench' }],
    });
    const groups = buildTrackerModel(renamed, [swappedRow({
      exercise_name: 'Bench Press', definition_id: 'def-bench',
    })]);
    expect(groups[1].exercises[0].substitutedFrom).toBeNull();
    expect(groups[1].exercises[0].exercise.name).toBe('Barbell Bench Press');
  });

  it('ignores rows written before definition ids were stamped', () => {
    const groups = buildTrackerModel(makeEvent(), [swappedRow({
      exercise_name: 'Bench Press', definition_id: null,
    })]);
    expect(groups[1].exercises[0].substitutedFrom).toBeNull();
  });
});

describe('hasLoggedData', () => {
  const trackedFrom = (event = makeEvent(), sets: SetLogRow[] = [], cardio: CardioLogRow[] = []) =>
    buildTrackerModel(event, sets, cardio)[1].exercises;

  it('is false for an untouched plan', () => {
    expect(hasLoggedData(trackedFrom()[0])).toBe(false);
    expect(hasLoggedData(trackedFrom()[1])).toBe(false);
  });

  it('is true once a set or a cardio metric carries a value', () => {
    const withSet = trackedFrom(makeEvent(), [{
      event_id: 'e', event_date: '2026-07-06', section: 'exercise',
      exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 1,
      planned_weight: null, planned_reps: null, planned_duration: null,
      actual_weight: '185', actual_reps: '5', actual_duration: null,
      is_autofilled: false,
    }]);
    expect(hasLoggedData(withSet[0])).toBe(true);

    const withCardio = trackedFrom(makeEvent(), [], [{
      event_id: 'e', event_date: '2026-07-06', section: 'exercise',
      exercise_id: 'run-1', exercise_name: 'Zone 2 Run',
      duration_minutes: 45, distance: null, elevation_gain: null, avg_heart_rate: null,
      is_autofilled: false,
    }]);
    expect(hasLoggedData(withCardio[1])).toBe(true);
  });

  it('counts values typed this sitting, before anything is saved', () => {
    const [bench] = trackedFrom();
    const edited = { ...bench, sets: bench.sets.map((s, i) => (i ? s : { ...s, actualReps: '5' })) };
    expect(hasLoggedData(edited)).toBe(true);
  });
});

describe('buildTrackerModel — shadow fill from last performance', () => {
  const lastBench = () => buildLastPerformance([
    {
      event_id: 'old__2026-06-26', event_date: '2026-06-26', section: 'exercise',
      exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 1,
      planned_weight: '185lb', planned_reps: '5', planned_duration: null,
      actual_weight: '200', actual_reps: '5', actual_duration: null,
      is_autofilled: false,
    },
    {
      event_id: 'old__2026-06-26', event_date: '2026-06-26', section: 'exercise',
      exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 2,
      planned_weight: '185lb', planned_reps: '5', planned_duration: null,
      actual_weight: '205', actual_reps: '4', actual_duration: null,
      is_autofilled: false,
    },
  ]);

  it('seeds set shadows from the last session, leaving actuals empty', () => {
    const groups = buildTrackerModel(makeEvent(), [], [], lastBench());
    const bench = groups[1].exercises[0];
    expect(bench.sets[0]).toMatchObject({
      actualWeight: '', actualReps: '', isLogged: false,
      shadow: { weight: '200', reps: '5' },
    });
    expect(bench.sets[1].shadow).toMatchObject({ weight: '205', reps: '4' });
  });

  it('falls back to the highest-numbered last set when the plan has more sets', () => {
    const groups = buildTrackerModel(makeEvent(), [], [], lastBench());
    const bench = groups[1].exercises[0]; // plan has 3 sets, last time had 2
    expect(bench.sets[2].shadow).toMatchObject({ weight: '205', reps: '4' });
  });

  it('shadows stretch durations (e.g. 1:30 in the deep squat)', () => {
    const last = buildLastPerformance([{
      event_id: 'old__2026-06-26', event_date: '2026-06-26', section: 'warmup',
      exercise_id: 'other-id', exercise_name: 'Doorway Pec Stretch', set_number: 1,
      planned_weight: null, planned_reps: null, planned_duration: '60s',
      actual_weight: null, actual_reps: null, actual_duration: '1:30',
      is_autofilled: false,
    }]);
    const groups = buildTrackerModel(makeEvent(), [], [], last);
    expect(groups[0].exercises[0].sets[0]).toMatchObject({ actualDuration: '', shadow: { duration: '1:30' } });
  });

  it('saved rows win over shadow fill; no-history sets get no shadow', () => {
    const saved: SetLogRow[] = [{
      event_id: 'e', event_date: '2026-07-06', section: 'exercise',
      exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 1,
      planned_weight: '185lb', planned_reps: '5', planned_duration: null,
      actual_weight: '190', actual_reps: '5', actual_duration: null,
      is_autofilled: false,
    }];
    const groups = buildTrackerModel(makeEvent(), saved, [], lastBench());
    const bench = groups[1].exercises[0];
    expect(bench.sets[0]).toMatchObject({ actualWeight: '190', isLogged: true, shadow: null });
    // Stretch has no history at all → untouched
    expect(groups[0].exercises[0].sets[0]).toMatchObject({ actualDuration: '', shadow: null });
  });

  it('shadows cardio from last actuals, and saved cardio wins', () => {
    const lastCardio = buildLastCardio([{
      event_id: 'old__2026-06-26', event_date: '2026-06-26', section: 'exercise',
      exercise_id: 'run-9', exercise_name: 'Zone 2 Run',
      duration_minutes: 45, distance: '5 mi', elevation_gain: '800 ft', avg_heart_rate: 145,
      is_autofilled: false,
    }]);
    const groups = buildTrackerModel(makeEvent(), [], [], new Map(), lastCardio);
    expect(groups[1].exercises[1].cardio).toMatchObject({
      durationMinutes: '', distance: '', elevationGain: '', avgHeartRate: '',
      isLogged: false,
      shadow: { durationMinutes: '45', distance: '5 mi', elevationGain: '800 ft', avgHeartRate: '145' },
    });

    const savedCardio: CardioLogRow[] = [{
      event_id: 'e', event_date: '2026-07-06', section: 'exercise',
      exercise_id: 'run-1', exercise_name: 'Zone 2 Run',
      duration_minutes: 30, distance: null, elevation_gain: null, avg_heart_rate: null,
      is_autofilled: false,
    }];
    const withSaved = buildTrackerModel(makeEvent(), [], savedCardio, new Map(), lastCardio);
    expect(withSaved[1].exercises[1].cardio).toMatchObject({
      durationMinutes: '30', isLogged: true, shadow: null,
    });
  });
});

describe('buildLastCardio', () => {
  const row = (over: Partial<CardioLogRow>): CardioLogRow => ({
    event_id: 'old__2026-06-26', event_date: '2026-06-26', section: 'exercise',
    exercise_id: 'run-1', exercise_name: 'Zone 2 Run',
    duration_minutes: 45, distance: '5 mi', elevation_gain: '800 ft', avg_heart_rate: 145,
    is_autofilled: false,
    ...over,
  });

  it('keeps the most recent date per exercise name, regardless of row order', () => {
    const map = buildLastCardio([
      row({ event_date: '2026-06-19', distance: '4 mi' }),
      row({ event_date: '2026-06-26', distance: '5 mi' }),
    ]);
    expect(map.get('Zone 2 Run')).toMatchObject({ date: '2026-06-26', distance: '5 mi' });
  });

  it('ignores autofilled and all-empty rows', () => {
    const map = buildLastCardio([
      row({ event_date: '2026-06-28', is_autofilled: true }),
      row({ event_date: '2026-06-27', duration_minutes: null, distance: null, elevation_gain: null, avg_heart_rate: null }),
      row({ event_date: '2026-06-20' }),
    ]);
    expect(map.get('Zone 2 Run')!.date).toBe('2026-06-20');
    expect(buildLastCardio([]).size).toBe(0);
  });
});

describe('collectUntouchedPlanned', () => {
  it('zero-fills untouched shadow sets — a ghost never tapped is a skipped set', () => {
    const lastBench = buildLastPerformance([{
      event_id: 'old__2026-06-26', event_date: '2026-06-26', section: 'exercise',
      exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 1,
      planned_weight: '185lb', planned_reps: '5', planned_duration: null,
      actual_weight: '200', actual_reps: '5', actual_duration: null,
      is_autofilled: false,
    }]);
    const groups = buildTrackerModel(makeEvent(), [], [], lastBench);

    const rows = collectUntouchedPlanned('eid', '2026-07-06', groups);
    // All 3 shadowed bench sets plus the warmup stretch zero-fill; cardio never does.
    expect(rows.filter(r => r.exercise_id === 'ub-1')).toHaveLength(3);
    expect(rows.filter(r => r.exercise_id === 'ub-1')[0]).toMatchObject({
      actual_weight: '0', actual_reps: '0', is_autofilled: true,
    });
  });

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
    run.cardio = { durationMinutes: '42.5', distance: '', elevationGain: '900 ft', avgHeartRate: 'abc', isLogged: false, shadow: null };
    const row = cardioToRow('eid', '2026-07-06', run);
    expect(row).toMatchObject({
      duration_minutes: 42.5,
      distance: null,
      elevation_gain: '900 ft',
      avg_heart_rate: null,
    });
  });
});
