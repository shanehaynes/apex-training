import { describe, it, expect } from 'vitest';
import {
  buildTrackerModel,
  collectUntouchedPlanned,
  makeExtraSet,
  normalizeRpeText,
  parseRpe,
  setToRow,
} from '../plan';
import { computeSessionPRs } from '../records';
import type { Exercise, WorkoutEvent } from '../../../types/workout';
import type { SetLogRow } from '../../db/types';

// Per-set metadata (phase55): RPE and the warm-up flag ride the tracked set
// through hydration and back out through setToRow, and a warm-up set is not
// a performance anywhere the camelCase model is read.

const bench: Exercise = { id: 'ub-1', name: 'Bench Press', category: 'strength', sets: 2, reps: '5', weight: '185lb' };

function makeEvent(): WorkoutEvent {
  return {
    id: 'w1__2026-07-06', type: 'weights', title: 'Upper Body', date: '2026-07-06',
    estimatedDuration: 60, description: '', exercises: [bench],
    difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
  };
}

function savedRow(over: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'w1__2026-07-06', event_date: '2026-07-06', section: 'exercise',
    exercise_id: 'ub-1', exercise_name: 'Bench Press', set_number: 1,
    planned_weight: '185lb', planned_reps: '5', planned_duration: null,
    actual_weight: '185', actual_reps: '5', actual_duration: null,
    is_autofilled: false,
    ...over,
  };
}

describe('parseRpe', () => {
  it('accepts 1–10 and snaps to half steps', () => {
    expect(parseRpe('8')).toBe(8);
    expect(parseRpe(' 7.5 ')).toBe(7.5);
    expect(parseRpe('7.3')).toBe(7.5);
    expect(parseRpe('7.2')).toBe(7);
    expect(parseRpe('10')).toBe(10);
    expect(parseRpe('1')).toBe(1);
  });

  it('is null for blank, letters and anything outside the scale', () => {
    expect(parseRpe('')).toBeNull();
    expect(parseRpe('   ')).toBeNull();
    expect(parseRpe('hard')).toBeNull();
    expect(parseRpe('0')).toBeNull();
    expect(parseRpe('11')).toBeNull();
    expect(parseRpe('-3')).toBeNull();
    expect(parseRpe(null)).toBeNull();
    expect(parseRpe(undefined)).toBeNull();
  });

  it('normalizes the field text to what the row would save', () => {
    expect(normalizeRpeText('7.3')).toBe('7.5');
    expect(normalizeRpeText('11')).toBe('');
    expect(normalizeRpeText('')).toBe('');
  });
});

describe('tracked set model — rpe and isWarmup', () => {
  it('starts every set unrated and not a warm-up, extras included', () => {
    const [group] = buildTrackerModel(makeEvent());
    for (const set of group.exercises[0].sets) expect(set).toMatchObject({ rpe: '', isWarmup: false });
    expect(makeExtraSet(5)).toMatchObject({ rpe: '', isWarmup: false });
  });

  it('hydrates both from saved rows, planned and extra', () => {
    const [group] = buildTrackerModel(makeEvent(), [
      savedRow({ set_number: 1, rpe: 7.5, is_warmup: true }),
      savedRow({ set_number: 2 }),
      savedRow({ set_number: 3, rpe: 9, is_warmup: false }),
    ]);
    const sets = group.exercises[0].sets;
    expect(sets[0]).toMatchObject({ rpe: '7.5', isWarmup: true, isLogged: true });
    // A row from before the columns (both absent) reads as unrated, working.
    expect(sets[1]).toMatchObject({ rpe: '', isWarmup: false });
    expect(sets[2]).toMatchObject({ rpe: '9', isWarmup: false, isExtra: true });
  });

  it('setToRow carries the flag and the parsed RPE, null when unparseable', () => {
    const [group] = buildTrackerModel(makeEvent());
    const tracked = group.exercises[0];
    const set = { ...tracked.sets[0], actualWeight: '185', actualReps: '5' };
    expect(setToRow('e', '2026-07-06', tracked, { ...set, rpe: '8', isWarmup: true }))
      .toMatchObject({ rpe: 8, is_warmup: true, is_autofilled: false });
    expect(setToRow('e', '2026-07-06', tracked, { ...set, rpe: '', isWarmup: false }))
      .toMatchObject({ rpe: null, is_warmup: false });
    expect(setToRow('e', '2026-07-06', tracked, { ...set, rpe: '12', isWarmup: false }).rpe).toBeNull();
  });

  it('a zero-fill at finish is never a warm-up, whatever the row was toggled to', () => {
    const groups = buildTrackerModel(makeEvent());
    groups[0].exercises[0].sets[0].isWarmup = true;
    groups[0].exercises[0].sets[0].rpe = '8';
    const rows = collectUntouchedPlanned('e', '2026-07-06', groups);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.is_autofilled && r.is_warmup === false && r.rpe === null)).toBe(true);
  });
});

describe('a warm-up set is not a performance', () => {
  const history = [savedRow({ event_id: 'old__2026-06-29', event_date: '2026-06-29', actual_weight: '185', actual_reps: '5' })];

  it('earns no PR, and earns it again once it is a working set', () => {
    const groups = buildTrackerModel(makeEvent(), [
      savedRow({ set_number: 1, actual_weight: '225', actual_reps: '5', is_warmup: true }),
    ]);
    expect(computeSessionPRs(groups, history, [])).toEqual([]);

    groups[0].exercises[0].sets[0].isWarmup = false;
    expect(computeSessionPRs(groups, history, []).map(pr => pr.kind)).toEqual(['oneRM']);
  });
});
