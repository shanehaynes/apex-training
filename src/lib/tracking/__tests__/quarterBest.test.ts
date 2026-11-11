import { describe, it, expect } from 'vitest';
import type { SetLogRow } from '../../db/types';
import { attachQuarterBests, bestSetsThisQuarter, quarterOf, quarterStartOf, type QuarterBest } from '../records';
import { quarterBestDescription, quarterBestFields, quarterBestHeading, quarterBestSummary } from '../quarterBest';
import { buildTrackerModel } from '../plan';
import { weightContextFromProfile } from '../weight';

// The tracker's quarterly best (docs/specs/tracker-quarter-pr): the best set
// of each strength exercise this calendar quarter, before the session's date.

function row(overrides: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'old__2026-10-14',
    event_date: '2026-10-14',
    section: 'exercise',
    exercise_id: 'bench',
    exercise_name: 'Bench Press',
    set_number: 1,
    planned_weight: null,
    planned_reps: null,
    planned_duration: null,
    actual_weight: '185 lb',
    actual_reps: '5',
    actual_duration: null,
    is_autofilled: false,
    ...overrides,
  };
}

const TODAY = '2026-11-11';

describe('calendar quarters', () => {
  it('starts each quarter on the first of Jan, Apr, Jul and Oct', () => {
    expect(quarterStartOf('2026-01-01')).toBe('2026-01-01');
    expect(quarterStartOf('2026-03-31')).toBe('2026-01-01');
    expect(quarterStartOf('2026-04-01')).toBe('2026-04-01');
    expect(quarterStartOf('2026-09-30')).toBe('2026-07-01');
    expect(quarterStartOf('2026-11-11')).toBe('2026-10-01');
    expect(quarterStartOf('2026-12-31')).toBe('2026-10-01');
    expect([quarterOf('2026-02-10'), quarterOf('2026-05-10'), quarterOf('2026-08-10'), quarterOf('2026-11-10')]).toEqual([1, 2, 3, 4]);
  });
});

describe('bestSetsThisQuarter (R1, R2)', () => {
  it('takes the heaviest estimated 1RM this quarter, as logged', () => {
    const best = bestSetsThisQuarter([
      row({ event_date: '2026-11-04', actual_weight: '185 lb', actual_reps: '5' }), // 216
      row({ event_date: '2026-10-21', actual_weight: '205 lb', actual_reps: '2' }), // 218.7
      row({ event_date: '2026-10-07', actual_weight: '175 lb', actual_reps: '8' }), // 221.7
    ], TODAY);
    expect(best.get('Bench Press')).toEqual({ weight: '175 lb', reps: '8', duration: '', date: '2026-10-07', quarter: 4 });
  });

  it('reads only this quarter, and only before the session date', () => {
    const best = bestSetsThisQuarter([
      row({ event_date: '2026-11-11', actual_weight: '300 lb' }), // today: not before
      row({ event_date: '2026-11-20', actual_weight: '300 lb' }), // later
      row({ event_date: '2026-09-30', actual_weight: '300 lb' }), // last quarter
      row({ event_date: '2026-10-01', actual_weight: '135 lb' }), // first day counts
    ], TODAY);
    expect(best.get('Bench Press')?.weight).toBe('135 lb');
    expect(bestSetsThisQuarter([row({ event_date: '2026-09-30' })], TODAY).size).toBe(0);
  });

  it('skips warm-ups, autofills and climbing pitches', () => {
    const best = bestSetsThisQuarter([
      row({ actual_weight: '315 lb', is_warmup: true }),
      row({ actual_weight: '315 lb', is_autofilled: true }),
      row({ actual_weight: '315 lb', ascent_style: 'redpoint' }),
      row({ actual_weight: '95 lb' }),
    ], TODAY);
    expect(best.get('Bench Press')?.weight).toBe('95 lb');
  });

  it('ranks a weighted set over an unweighted one, and a hold over a bare count', () => {
    const best = bestSetsThisQuarter([
      row({ exercise_name: 'Pull-Up', actual_weight: null, actual_reps: '20' }),
      row({ exercise_name: 'Pull-Up', actual_weight: '25 lb', actual_reps: '3' }),
      row({ exercise_name: 'Plank', actual_weight: null, actual_reps: '1', actual_duration: '' }),
      row({ exercise_name: 'Plank', actual_weight: null, actual_reps: null, actual_duration: '1:30' }),
    ], TODAY);
    expect(best.get('Pull-Up')).toMatchObject({ weight: '25 lb', reps: '3' });
    expect(best.get('Plank')).toMatchObject({ weight: '', reps: '', duration: '1:30' });
  });

  it('keeps the first of two equal sets, the newest in the tracker history order', () => {
    const best = bestSetsThisQuarter([
      row({ event_date: '2026-11-04' }),
      row({ event_date: '2026-10-14' }),
    ], TODAY);
    expect(best.get('Bench Press')?.date).toBe('2026-11-04');
  });

  it('ignores a row with nothing it can rank', () => {
    expect(bestSetsThisQuarter([row({ actual_weight: '185 lb', actual_reps: null })], TODAY).size).toBe(0);
  });
});

describe('attachQuarterBests (R1, R5)', () => {
  const event = {
    id: 'evt', title: 'Push', date: TODAY, type: 'weights',
    exercises: [
      { id: 'bench', name: 'Bench Press', category: 'strength', sets: 3, reps: '5', weight: '185' },
      { id: 'hip', name: 'Hip Flow', category: 'mobility', sets: 1, duration: '60s' },
      { id: 'squat', name: 'Back Squat', category: 'strength', sets: 3, reps: '5' },
    ],
  } as Parameters<typeof buildTrackerModel>[0];

  it('sets the best on strength exercises, null with none and on every other kind', () => {
    const groups = attachQuarterBests(buildTrackerModel(event), [
      row({}),
      row({ exercise_name: 'Hip Flow', actual_weight: null, actual_reps: null, actual_duration: '90s' }),
    ], TODAY);
    const [bench, hip, squat] = groups[0].exercises;
    expect(bench.quarterBest).toMatchObject({ weight: '185 lb', reps: '5', quarter: 4 });
    expect(hip.quarterBest).toBeNull();
    expect(squat.quarterBest).toBeNull();
  });
});

describe('how the tracker reads a quarterly best (R3, R4)', () => {
  const lb = weightContextFromProfile({ weight_unit: 'lb', body_weight_lb: null });
  const best = (o: Partial<QuarterBest>): QuarterBest => ({ weight: '', reps: '', duration: '', date: '2026-10-14', quarter: 4, ...o });

  it('lists only the fields the set was logged with, weight then reps then time', () => {
    expect(quarterBestFields(best({ weight: '185', reps: '5' }), lb)).toEqual(['185 lb', '5 reps']);
    expect(quarterBestFields(best({ reps: '1' }), lb)).toEqual(['1 rep']);
    expect(quarterBestFields(best({ reps: '8 each leg' }), lb)).toEqual(['8 each leg']);
    expect(quarterBestFields(best({ duration: '90' }), null)).toEqual(['1:30']);
    expect(quarterBestFields(best({ weight: '24 kg', reps: '10', duration: '45s' }), lb)).toEqual(['24 kg', '10 reps', '45s']);
  });

  it('leaves a bare weight bare when the profile unit is unknown', () => {
    expect(quarterBestFields(best({ weight: '185', reps: '5' }), null)).toEqual(['185', '5 reps']);
  });

  it('sums the set up on one line, and names the quarter and day for a screen reader', () => {
    expect(quarterBestSummary(best({ weight: '185', reps: '5' }), lb)).toBe('185 lb × 5');
    expect(quarterBestSummary(best({ reps: '12' }), lb)).toBe('12 reps');
    expect(quarterBestSummary(best({ duration: '1:30' }), lb)).toBe('1:30');
    expect(quarterBestHeading(best({}))).toBe('Q4 PR');
    expect(quarterBestDescription(best({ weight: '185 lb', reps: '5' }), lb)).toBe('Best set this quarter (Q4), logged Oct 14: 185 lb × 5');
  });
});
