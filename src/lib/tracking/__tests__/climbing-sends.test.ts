import { describe, it, expect } from 'vitest';
import {
  buildTrackerModel,
  collectUntouchedPlanned,
  loggedShapeOf,
  makeAddedExercise,
  parseAttempts,
  setToRow,
  type TrackedSectionGroup,
} from '../plan';
import { computeSendPRs, computeSessionPRs, describeRecord, describeRecordForPeople, isCleanSend, type SendRecord } from '../records';
import type { AscentStyle, Exercise, WorkoutEvent } from '../../../types/workout';
import type { SetLogRow } from '../../db/types';

// Climbing is logged like climbing: a pitch carries its ascent style and
// attempts through the tracker model and back out, a harder clean send than
// any before is a 'send' record, and a pitch never enters a weight record.

const sport: Exercise = { id: 'p1', name: 'Sport', category: 'climbing', climbStyle: 'sport', grade: '5.10a' };
const boulder: Exercise = { id: 'p2', name: 'Boulder', category: 'climbing', climbStyle: 'boulder', grade: 'V4' };

function climbEvent(exercises: Exercise[] = [sport, boulder]): WorkoutEvent {
  return {
    id: 'climb__2026-09-20', type: 'outdoor-climbing', title: 'Crag day', date: '2026-09-20',
    estimatedDuration: 240, description: '', exercises,
    difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
  };
}

function pitchRow(over: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'climb__2026-09-01', event_date: '2026-09-01', section: 'exercise',
    exercise_id: 'p1', exercise_name: 'Sport', set_number: 1,
    planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: '5.10a', actual_reps: null, actual_duration: null,
    is_autofilled: false, is_warmup: false, ascent_style: 'redpoint', attempts: null,
    ...over,
  };
}

/** The event's model with the first pitch logged as given. */
function logged(grade: string, style: AscentStyle | null, over: Partial<TrackedSectionGroup['exercises'][number]['sets'][number]> = {}) {
  const groups = buildTrackerModel(climbEvent());
  const [tracked] = groups[0].exercises;
  tracked.sets[0] = { ...tracked.sets[0], actualWeight: grade, ascentStyle: style, ...over };
  return groups;
}

describe('isCleanSend', () => {
  it('is any stated style except an attempt', () => {
    expect(isCleanSend('flash')).toBe(true);
    expect(isCleanSend('redpoint')).toBe(true);
    expect(isCleanSend('follow')).toBe(true);
    expect(isCleanSend('attempt')).toBe(false);
    expect(isCleanSend(null)).toBe(false);
    expect(isCleanSend(undefined)).toBe(false);
  });
});

describe('send records', () => {
  const history = [
    pitchRow({ actual_weight: '5.10b', ascent_style: 'redpoint', event_date: '2026-09-01' }),
    pitchRow({ actual_weight: '5.11c', ascent_style: 'attempt', event_date: '2026-09-05' }), // tried, not sent
    pitchRow({ actual_weight: '5.12a', ascent_style: null, event_date: '2026-09-06' }), // no style: says nothing
    pitchRow({ actual_weight: '5.11d', ascent_style: 'flash', is_autofilled: true, event_date: '2026-09-07' }),
    pitchRow({ actual_weight: '5.11d', ascent_style: 'flash', is_warmup: true, event_date: '2026-09-08' }),
  ];

  it('a clean send harder than the prior best is a record, with what it beat', () => {
    const prs = computeSendPRs(logged('5.11a', 'redpoint'), history);
    expect(prs).toEqual<SendRecord[]>([{
      kind: 'send', exerciseName: 'Sport', grade: '5.11a', discipline: 'sport', style: 'redpoint',
      previousGrade: '5.10b', previousDate: '2026-09-01',
    }]);
  });

  it('the same or an easier grade is not', () => {
    expect(computeSendPRs(logged('5.10b', 'flash'), history)).toEqual([]);
    expect(computeSendPRs(logged('5.9', 'flash'), history)).toEqual([]);
  });

  it('an attempt or an unstated style is never a send, however hard', () => {
    expect(computeSendPRs(logged('5.13a', 'attempt'), history)).toEqual([]);
    expect(computeSendPRs(logged('5.13a', null), history)).toEqual([]);
  });

  it('a warm-up pitch is not a performance', () => {
    expect(computeSendPRs(logged('5.13a', 'flash', { isWarmup: true }), history)).toEqual([]);
  });

  it('a first-ever send is not a record — nothing to beat', () => {
    expect(computeSendPRs(logged('5.11a', 'redpoint'), [])).toEqual([]);
    // Only attempts before: still nothing sent to beat.
    expect(computeSendPRs(logged('5.11a', 'redpoint'), [pitchRow({ ascent_style: 'attempt' })])).toEqual([]);
  });

  it('grades only race their own scale', () => {
    const iceMixed: Exercise = { id: 'p3', name: 'Ice/Mixed', category: 'climbing', climbStyle: 'ice-mixed' };
    const groups = buildTrackerModel(climbEvent([iceMixed]));
    groups[0].exercises[0].sets[0] = { ...groups[0].exercises[0].sets[0], actualWeight: 'WI4', ascentStyle: 'redpoint' };
    const prior = [pitchRow({ exercise_name: 'Ice/Mixed', actual_weight: 'M7', ascent_style: 'redpoint' })];
    // WI4 is not "easier than M7": the two never compare, and WI has no history.
    expect(computeSendPRs(groups, prior)).toEqual([]);
    const priorIce = [...prior, pitchRow({ exercise_name: 'Ice/Mixed', actual_weight: 'WI3+', ascent_style: 'follow' })];
    expect(computeSendPRs(groups, priorIce)).toMatchObject([{ grade: 'WI4', previousGrade: 'WI3+', discipline: 'ice-mixed' }]);
  });

  it('the hardest send of the session is the one reported', () => {
    const groups = buildTrackerModel(climbEvent());
    const [tracked] = groups[0].exercises;
    tracked.sets = [
      { ...tracked.sets[0], actualWeight: '5.11a', ascentStyle: 'redpoint' },
      { ...tracked.sets[0], setNumber: 2, isExtra: true, actualWeight: '5.11c', ascentStyle: 'flash' },
      { ...tracked.sets[0], setNumber: 3, isExtra: true, actualWeight: '5.12a', ascentStyle: 'attempt' },
    ];
    expect(computeSendPRs(groups, history)).toMatchObject([{ grade: '5.11c', style: 'flash' }]);
  });

  it('computeSessionPRs carries the send record with the others', () => {
    expect(computeSessionPRs(logged('5.11a', 'redpoint'), history)).toMatchObject([{ kind: 'send', grade: '5.11a' }]);
  });
});

describe('a pitch never enters a weight, duration or reps record', () => {
  it('even with reps typed and a grade that reads as a number', () => {
    // "5.9" parses as a weight; with reps beside it a lift would be a 1RM.
    const groups = logged('5.9', null, { actualReps: '3', actualDuration: '90' });
    const history = [pitchRow({ actual_weight: '5.8', actual_reps: '2', actual_duration: '60', ascent_style: null })];
    expect(computeSessionPRs(groups, history)).toEqual([]);
  });

  it('a prior row with pitch metadata never seeds a lift record under the same name', () => {
    const lift: Exercise = { id: 'l1', name: 'Sport', category: 'strength', sets: 1, reps: '5' };
    const groups = buildTrackerModel(climbEvent([lift]));
    groups[0].exercises[0].sets[0] = { ...groups[0].exercises[0].sets[0], actualWeight: '100', actualReps: '5' };
    const history = [pitchRow({ actual_weight: '90', actual_reps: '5', ascent_style: 'redpoint' })];
    expect(computeSessionPRs(groups, history)).toEqual([]);
  });
});

describe('describing a send', () => {
  const record: SendRecord = {
    kind: 'send', exerciseName: 'Sport', grade: '5.11a', discipline: 'sport', style: 'redpoint',
    previousGrade: '5.10b', previousDate: '2026-09-01',
  };
  it('reads as a climb, for machines and people alike', () => {
    expect(describeRecord(record)).toBe('Redpointed 5.11a, up from 5.10b on Sep 1');
    expect(describeRecordForPeople(record, 'kg')).toBe('Redpointed 5.11a, up from 5.10b on Sep 1');
  });
});

describe('pitch rows in the tracker model', () => {
  it('start with no style and no attempts', () => {
    const [group] = buildTrackerModel(climbEvent());
    expect(group.exercises[0].sets[0]).toMatchObject({ ascentStyle: null, attempts: '' });
  });

  it('hydrate style and attempts from saved rows and send them back unchanged, grade included', () => {
    const saved = pitchRow({ event_id: 'climb__2026-09-20', event_date: '2026-09-20', actual_weight: '5.10a', ascent_style: 'flash', attempts: 1 });
    const [group] = buildTrackerModel(climbEvent(), [saved]);
    const tracked = group.exercises[0];
    expect(tracked.sets[0]).toMatchObject({ actualWeight: '5.10a', ascentStyle: 'flash', attempts: '1', isLogged: true });
    expect(setToRow('climb__2026-09-20', '2026-09-20', tracked, { ...tracked.sets[0], attempts: '3' }))
      .toMatchObject({ actual_weight: '5.10a', ascent_style: 'flash', attempts: 3 });
  });

  it('only a pitch row carries the pitch columns', () => {
    const lift: Exercise = { id: 'l1', name: 'Bench Press', category: 'strength', sets: 1, reps: '5' };
    const [group] = buildTrackerModel(climbEvent([lift]));
    const row = setToRow('e', '2026-09-20', group.exercises[0], group.exercises[0].sets[0]);
    expect(row).not.toHaveProperty('ascent_style');
    expect(row).not.toHaveProperty('attempts');
  });

  it('a zero-filled pitch is no send', () => {
    const rows = collectUntouchedPlanned('e', '2026-09-20', buildTrackerModel(climbEvent()));
    expect(rows[0]).toMatchObject({ is_autofilled: true, ascent_style: null, attempts: null });
  });

  it('a pitch added mid-session comes back a pitch after a reload', () => {
    const added = makeAddedExercise('exercise', { id: 'def-lead', canonicalName: 'Lead', category: 'climbing' }, 'added-1');
    expect(added.exercise.category).toBe('climbing');
    const row = setToRow('climb__2026-09-20', '2026-09-20', added, { ...added.sets[0], actualWeight: '5.9' });
    expect(row).toMatchObject({ exercise_id: 'added-1', actual_weight: '5.9', ascent_style: null, attempts: null });

    // By its definition's category…
    const byDefinition = buildTrackerModel(climbEvent([]), [row], [], undefined, undefined, [], new Map([['def-lead', 'climbing']]));
    expect(byDefinition[0].exercises[0].exercise.category).toBe('climbing');
    // …or, with no definition known, by the metadata its rows carry.
    const byMetadata = buildTrackerModel(climbEvent([]), [{ ...row, definition_id: null, ascent_style: 'redpoint' }]);
    expect(byMetadata[0].exercises[0].exercise.category).toBe('climbing');
    // An added lift stays a lift.
    const lift = buildTrackerModel(climbEvent([]), [{ ...row, actual_weight: '100', ascent_style: undefined, attempts: undefined }]);
    expect(lift[0].exercises[0].exercise.category).toBe('strength');
  });
});

describe('parseAttempts', () => {
  it('is a whole number of at least one, else null', () => {
    expect(parseAttempts('3')).toBe(3);
    expect(parseAttempts(' 1 ')).toBe(1);
    expect(parseAttempts('0')).toBeNull();
    expect(parseAttempts('2.5')).toBeNull();
    expect(parseAttempts('')).toBeNull();
    expect(parseAttempts('many')).toBeNull();
  });
});

describe('loggedShapeOf', () => {
  it('splits cardio, pitches and every set-logged category', () => {
    expect(loggedShapeOf('cardio')).toBe('cardio');
    expect(loggedShapeOf('climbing')).toBe('climbing');
    for (const c of ['strength', 'stretch', 'mobility', 'skill']) expect(loggedShapeOf(c)).toBe('sets');
    expect(loggedShapeOf(null)).toBeNull();
  });
});
