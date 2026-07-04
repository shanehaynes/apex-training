import { describe, it, expect } from 'vitest';
import {
  parseLeadingNumber,
  parseDurationSeconds,
  parseQuantity,
  estimateOneRepMax,
  bestHistoricalOneRM,
  computeSessionPRs,
  formatSeconds,
  describeRecord,
} from '../records';
import { buildTrackerModel } from '../plan';
import type { TrackedSectionGroup } from '../plan';
import type { Exercise, WorkoutEvent } from '../../../types/workout';
import type { CardioLogRow, SetLogRow } from '../../supabaseClient';

const bench: Exercise = {
  id: 'ub-1',
  name: 'Bench Press',
  category: 'strength',
  sets: 2,
  reps: '5',
  weight: '185lb',
};

const plank: Exercise = {
  id: 'ub-2',
  name: 'Plank',
  category: 'strength',
  sets: 2,
  duration: '60s',
};

const run: Exercise = {
  id: 'run-1',
  name: 'Zone 2 Run',
  category: 'cardio',
  duration: '45 min',
};

function makeEvent(exercises: Exercise[]): WorkoutEvent {
  return {
    id: 'w1__2026-07-06',
    type: 'weights',
    title: 'Upper Body',
    date: '2026-07-06',
    estimatedDuration: 60,
    description: '',
    exercises,
    difficulty: 3,
    tags: [],
    isCompleted: false,
    isRecurring: false,
  };
}

function historyRow(overrides: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'old__2026-06-01',
    event_date: '2026-06-01',
    section: 'exercise',
    exercise_id: 'ub-1',
    exercise_name: 'Bench Press',
    set_number: 1,
    planned_weight: null,
    planned_reps: null,
    planned_duration: null,
    actual_weight: '185',
    actual_reps: '5',
    actual_duration: null,
    is_autofilled: false,
    ...overrides,
  };
}

function cardioHistoryRow(overrides: Partial<CardioLogRow>): CardioLogRow {
  return {
    event_id: 'old__2026-06-01',
    event_date: '2026-06-01',
    section: 'exercise',
    exercise_id: 'run-1',
    exercise_name: 'Zone 2 Run',
    duration_minutes: 45,
    distance: '5 mi',
    elevation_gain: '800 ft',
    avg_heart_rate: 145,
    ...overrides,
  };
}

/** Groups with actuals entered on the given exercise's sets. */
function groupsWith(
  exercise: Exercise,
  actuals: { weight?: string; reps?: string; duration?: string }[],
): TrackedSectionGroup[] {
  const groups = buildTrackerModel(makeEvent([exercise]));
  const tracked = groups[0].exercises[0];
  tracked.sets = tracked.sets.map((s, i) =>
    actuals[i]
      ? {
          ...s,
          actualWeight: actuals[i].weight ?? '',
          actualReps: actuals[i].reps ?? '',
          actualDuration: actuals[i].duration ?? '',
        }
      : s,
  );
  return groups;
}

/** Groups for a cardio exercise with the given actuals. */
function cardioGroups(actuals: Partial<{ distance: string; elevationGain: string }>): TrackedSectionGroup[] {
  const groups = buildTrackerModel(makeEvent([run]));
  const tracked = groups[0].exercises[0];
  tracked.cardio = {
    durationMinutes: '',
    distance: actuals.distance ?? '',
    elevationGain: actuals.elevationGain ?? '',
    avgHeartRate: '',
    isLogged: true,
  };
  return groups;
}

describe('parseLeadingNumber', () => {
  it('parses plain and suffixed numbers', () => {
    expect(parseLeadingNumber('185')).toBe(185);
    expect(parseLeadingNumber('185lb')).toBe(185);
    expect(parseLeadingNumber('62.5 kg')).toBe(62.5);
  });

  it('returns null for empty or non-numeric values', () => {
    expect(parseLeadingNumber('')).toBeNull();
    expect(parseLeadingNumber(null)).toBeNull();
    expect(parseLeadingNumber('BW')).toBeNull();
    expect(parseLeadingNumber('~185')).toBeNull();
  });
});

describe('parseDurationSeconds', () => {
  it('normalizes time units to seconds', () => {
    expect(parseDurationSeconds('90s')).toBe(90);
    expect(parseDurationSeconds('2 min')).toBe(120);
    expect(parseDurationSeconds('1.5min')).toBe(90);
    expect(parseDurationSeconds('1 hr')).toBe(3600);
    expect(parseDurationSeconds('60')).toBe(60); // bare number = seconds
  });

  it('parses colon notation', () => {
    expect(parseDurationSeconds('1:30')).toBe(90);
    expect(parseDurationSeconds('1:05:00')).toBe(3900);
  });

  it('rejects unknown units and junk', () => {
    expect(parseDurationSeconds('60 laps')).toBeNull();
    expect(parseDurationSeconds('')).toBeNull();
    expect(parseDurationSeconds('fast')).toBeNull();
  });
});

describe('parseQuantity', () => {
  it('parses magnitude with normalized unit', () => {
    expect(parseQuantity('5 mi')).toEqual({ value: 5, unit: 'mi' });
    expect(parseQuantity('5.2 miles')).toEqual({ value: 5.2, unit: 'mi' });
    expect(parseQuantity('1,200 ft')).toEqual({ value: 1200, unit: 'ft' });
    expect(parseQuantity('8km')).toEqual({ value: 8, unit: 'km' });
    expect(parseQuantity('5.2')).toEqual({ value: 5.2, unit: '' });
  });

  it('rejects empty and non-numeric values', () => {
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity(null)).toBeNull();
    expect(parseQuantity('far')).toBeNull();
  });
});

describe('estimateOneRepMax', () => {
  it('applies the Epley formula, with a single rep as the 1RM itself', () => {
    expect(estimateOneRepMax(185, 1)).toBe(185);
    expect(estimateOneRepMax(180, 5)).toBe(210);
  });
});

describe('bestHistoricalOneRM', () => {
  it('keeps the best est-1RM per exercise name', () => {
    const best = bestHistoricalOneRM([
      historyRow({ actual_weight: '185', actual_reps: '5' }), // 1RM ≈ 215.8
      historyRow({ actual_weight: '200', actual_reps: '1', event_date: '2026-06-08' }), // 200
    ]);
    expect(best.get('Bench Press')?.weight).toBe(185);
    expect(best.get('Bench Press')?.date).toBe('2026-06-01');
  });

  it('ignores autofilled and unparseable rows', () => {
    const best = bestHistoricalOneRM([
      historyRow({ actual_weight: '999', actual_reps: '10', is_autofilled: true }),
      historyRow({ actual_weight: 'BW', actual_reps: '10' }),
      historyRow({ actual_weight: '100', actual_reps: '0' }),
    ]);
    expect(best.size).toBe(0);
  });
});

describe('computeSessionPRs — estimated 1RM', () => {
  const history = [historyRow({ actual_weight: '185', actual_reps: '5' })]; // 1RM ≈ 215.8

  it('detects a PR when this session beats the prior best', () => {
    const prs = computeSessionPRs(groupsWith(bench, [{ weight: '190lb', reps: '5' }]), history);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      kind: 'oneRM',
      exerciseName: 'Bench Press',
      weight: 190,
      reps: 5,
      previousDate: '2026-06-01',
    });
  });

  it('counts a rep PR at a lower weight when the est-1RM is higher', () => {
    // 175 × 8 → est 1RM ≈ 221.7, beats 185 × 5 ≈ 215.8
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '175', reps: '8' }]), history)).toHaveLength(1);
  });

  it('reports nothing when the prior best is not beaten', () => {
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '185', reps: '5' }]), history)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '150', reps: '5' }]), history)).toHaveLength(0);
  });

  it('reports nothing for an exercise with no prior history', () => {
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '190', reps: '5' }]), [])).toHaveLength(0);
  });

  it('ignores empty and unparseable actuals in the current session', () => {
    expect(computeSessionPRs(groupsWith(bench, []), history)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(bench, [{ weight: 'heavy', reps: '5' }]), history)).toHaveLength(0);
  });
});

describe('computeSessionPRs — duration (no weight metric)', () => {
  const plankHistory = [
    historyRow({ exercise_id: 'ub-2', exercise_name: 'Plank', actual_weight: null, actual_reps: null, actual_duration: '60s' }),
  ];

  it('detects a longer hold as a PR, across unit notations', () => {
    const prs = computeSessionPRs(groupsWith(plank, [{ duration: '1:30' }]), plankHistory);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ kind: 'duration', exerciseName: 'Plank', seconds: 90, previousSeconds: 60 });
  });

  it('reports nothing when the hold is not longer', () => {
    expect(computeSessionPRs(groupsWith(plank, [{ duration: '45s' }]), plankHistory)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(plank, [{ duration: '60s' }]), plankHistory)).toHaveLength(0);
  });

  it('never gives a weighted set a duration PR', () => {
    // Weight parses → the row is a 1RM candidate; its duration is ignored.
    const prs = computeSessionPRs(
      groupsWith(bench, [{ weight: '100', reps: '5', duration: '5 min' }]),
      plankHistory,
    );
    expect(prs).toHaveLength(0);
  });
});

describe('computeSessionPRs — rep count (rep-only)', () => {
  const pushups: Exercise = { id: 'ub-3', name: 'Push-Ups', category: 'strength', sets: 2, reps: 'AMRAP' };
  const pushupHistory = [
    historyRow({ exercise_id: 'ub-3', exercise_name: 'Push-Ups', actual_weight: null, actual_reps: '25', actual_duration: null }),
  ];

  it('detects a rep-count PR for rep-only exercises', () => {
    const prs = computeSessionPRs(groupsWith(pushups, [{ reps: '30' }]), pushupHistory);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ kind: 'reps', exerciseName: 'Push-Ups', reps: 30, previousReps: 25 });
  });

  it('reports nothing when the rep count is not beaten', () => {
    expect(computeSessionPRs(groupsWith(pushups, [{ reps: '25' }]), pushupHistory)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(pushups, [{ reps: '20' }]), pushupHistory)).toHaveLength(0);
  });

  it('never gives weighted or duration sets a rep-count PR', () => {
    // Weight present → 1RM territory; duration present → duration territory.
    expect(computeSessionPRs(groupsWith(pushups, [{ weight: '25', reps: '30' }]), pushupHistory)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(pushups, [{ reps: '30', duration: '60s' }]), pushupHistory)).toHaveLength(0);
  });

  it('reports nothing without prior rep-only history', () => {
    expect(computeSessionPRs(groupsWith(pushups, [{ reps: '30' }]), [])).toHaveLength(0);
  });
});

describe('computeSessionPRs — cardio distance & elevation', () => {
  const history = [cardioHistoryRow({})]; // 5 mi, 800 ft

  it('detects distance and elevation PRs together', () => {
    const prs = computeSessionPRs(cardioGroups({ distance: '5.5 mi', elevationGain: '1,000 ft' }), [], history);
    expect(prs).toHaveLength(2);
    expect(prs.find(p => p.kind === 'distance')).toMatchObject({ exerciseName: 'Zone 2 Run', value: 5.5, unit: 'mi', previousValue: 5 });
    expect(prs.find(p => p.kind === 'elevation')).toMatchObject({ value: 1000, unit: 'ft', previousValue: 800 });
  });

  it('reports nothing when prior bests are not beaten', () => {
    expect(computeSessionPRs(cardioGroups({ distance: '4 mi', elevationGain: '800 ft' }), [], history)).toHaveLength(0);
  });

  it('never compares across units', () => {
    // 8 km is farther than 5 mi in reality, but there is no 'km' history to beat.
    expect(computeSessionPRs(cardioGroups({ distance: '8 km' }), [], history)).toHaveLength(0);
  });

  it('reports nothing without prior cardio history', () => {
    expect(computeSessionPRs(cardioGroups({ distance: '5.5 mi' }), [], [])).toHaveLength(0);
  });
});

describe('display helpers', () => {
  it('formats seconds compactly', () => {
    expect(formatSeconds(45)).toBe('45s');
    expect(formatSeconds(90)).toBe('1:30');
    expect(formatSeconds(3900)).toBe('1:05:00');
  });

  it('describes each record kind', () => {
    expect(describeRecord({
      kind: 'oneRM', exerciseName: 'Bench Press', estimatedOneRM: 216.6, weight: 190, reps: 5,
      previousOneRM: 215.8, previousDate: '2026-06-01',
    })).toBe('est. 1RM 217 (190 × 5), up from 216 on Jun 1');
    expect(describeRecord({
      kind: 'duration', exerciseName: 'Plank', seconds: 90, previousSeconds: 60, previousDate: '2026-06-01',
    })).toBe('1:30, up from 1:00 on Jun 1');
    expect(describeRecord({
      kind: 'reps', exerciseName: 'Push-Ups', reps: 30, previousReps: 25, previousDate: '2026-06-01',
    })).toBe('30 reps, up from 25 on Jun 1');
    expect(describeRecord({
      kind: 'elevation', exerciseName: 'Run', value: 1000, unit: 'ft', previousValue: 800, previousDate: '2026-06-01',
    })).toBe('1000 ft elevation, up from 800 ft on Jun 1');
  });
});
