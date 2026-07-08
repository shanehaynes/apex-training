import { describe, it, expect } from 'vitest';
import { buildExerciseStats, formatTrendValue, lastPerformedByCanonical } from '../stats';
import type { CardioLogRow, SetLogRow } from '../../db/types';

function setRow(overrides: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'e1',
    event_date: '2026-07-01',
    section: 'exercise',
    exercise_id: 'x',
    exercise_name: 'Weighted Dip',
    set_number: 1,
    planned_weight: null,
    planned_reps: null,
    planned_duration: null,
    actual_weight: null,
    actual_reps: null,
    actual_duration: null,
    is_autofilled: false,
    ...overrides,
  };
}

function cardioRow(overrides: Partial<CardioLogRow>): CardioLogRow {
  return {
    event_id: 'e1',
    event_date: '2026-07-01',
    section: 'exercise',
    exercise_id: 'x',
    exercise_name: 'Trail Run',
    duration_minutes: null,
    distance: null,
    elevation_gain: null,
    avg_heart_rate: null,
    is_autofilled: false,
    ...overrides,
  };
}

describe('buildExerciseStats — weighted exercise', () => {
  const rows = [
    setRow({ event_date: '2026-06-01', actual_weight: '180', actual_reps: '5' }),   // 1RM 210
    setRow({ event_date: '2026-06-01', actual_weight: '180', actual_reps: '3', set_number: 2 }), // 198
    setRow({ event_date: '2026-06-15', actual_weight: '190', actual_reps: '5' }),   // 221.7 — PR
    setRow({ event_date: '2026-06-22', actual_weight: '185', actual_reps: '5' }),   // 215.8
    setRow({ event_date: '2026-06-29', actual_weight: '200', actual_reps: '1', is_autofilled: true }), // skipped
  ];

  it('picks the oneRM kind, builds a per-session trend, and finds the PR', () => {
    const stats = buildExerciseStats(rows, []);
    expect(stats.kind).toBe('oneRM');
    expect(stats.trend.map(p => p.date)).toEqual(['2026-06-01', '2026-06-15', '2026-06-22']);
    expect(stats.trend[0].value).toBeCloseTo(210);       // best of the two June 1 sets
    expect(stats.pr?.display).toBe('222');
    expect(stats.pr?.date).toBe('2026-06-15');
    expect(stats.totalSessions).toBe(3);                 // autofilled row is not a session
  });

  it('lists recent sessions newest first with readable sets', () => {
    const stats = buildExerciseStats(rows, []);
    expect(stats.sessions[0]).toEqual({ date: '2026-06-22', sets: ['185 × 5'] });
    expect(stats.sessions[2]).toEqual({ date: '2026-06-01', sets: ['180 × 5', '180 × 3'] });
  });
});

describe('buildExerciseStats — duration exercise', () => {
  it('tracks longest hold when there is no weight', () => {
    const stats = buildExerciseStats([
      setRow({ event_date: '2026-06-01', actual_duration: '45s' }),
      setRow({ event_date: '2026-06-08', actual_duration: '1:10' }),
    ], []);
    expect(stats.kind).toBe('duration');
    expect(stats.pr?.display).toBe('1:10');
    expect(formatTrendValue('duration', stats.trend[0].value)).toBe('45s');
  });
});

describe('buildExerciseStats — cardio', () => {
  it('tracks distance in the dominant unit and ignores other-unit rows', () => {
    const stats = buildExerciseStats([], [
      cardioRow({ event_date: '2026-06-01', distance: '3.1 mi', duration_minutes: 30 }),
      cardioRow({ event_date: '2026-06-10', distance: '5 mi', elevation_gain: '800 ft' }),
      cardioRow({ event_date: '2026-06-12', distance: '8 km' }), // minority unit — excluded from trend
    ]);
    expect(stats.kind).toBe('distance');
    expect(stats.kindLabel).toBe('mi');
    expect(stats.trend.map(p => p.value)).toEqual([3.1, 5]);
    expect(stats.pr?.display).toBe('5 mi');
    expect(stats.totalSessions).toBe(3);
  });
});

describe('buildExerciseStats — empty', () => {
  it('returns the empty shape when only autofilled rows exist', () => {
    const stats = buildExerciseStats([setRow({ is_autofilled: true, actual_weight: '100', actual_reps: '5' })], []);
    expect(stats.kind).toBeNull();
    expect(stats.pr).toBeNull();
    expect(stats.totalSessions).toBe(0);
  });
});

describe('lastPerformedByCanonical', () => {
  it('unifies spellings and keeps the newest date', () => {
    const toCanonical = new Map([
      ['hammer curl', 'Hammer Curl'],
      ['hammer curls', 'Hammer Curl'],
    ]);
    const out = lastPerformedByCanonical([
      { exercise_name: 'Hammer Curls', event_date: '2026-06-01' },
      { exercise_name: 'Hammer Curl', event_date: '2026-06-20' },
      { exercise_name: 'Unknown Movement', event_date: '2026-05-01' },
    ], toCanonical);
    expect(out.get('Hammer Curl')).toBe('2026-06-20');
    expect(out.get('Unknown Movement')).toBe('2026-05-01');
  });
});
