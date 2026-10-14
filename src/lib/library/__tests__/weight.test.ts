import { describe, it, expect } from 'vitest';
import { buildExerciseStats } from '../stats';
import type { SetLogRow } from '../../db/types';
import { LB_PER_KG } from '../../tracking/weight';

// Library stats read weights through the profile and show them in the
// athlete's unit; a machine reader can ask for pounds.

function setRow(overrides: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'e1', event_date: '2026-07-01', section: 'exercise', exercise_id: 'x', exercise_name: 'Bench Press',
    set_number: 1, planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: null, actual_reps: null, actual_duration: null, is_autofilled: false, ...overrides,
  };
}

const rows = [
  setRow({ event_date: '2026-06-01', actual_weight: '80', actual_reps: '5' }),       // bare → kg under a kg profile
  setRow({ event_date: '2026-06-15', actual_weight: '185 lb', actual_reps: '5' }),   // 83.9 kg
  setRow({ event_date: '2026-06-22', actual_weight: 'BW+20', actual_reps: '5', set_number: 2 }), // 180 lb + 20 kg = 224.1 lb
];
const kg = { unit: 'kg' as const, bodyWeightLb: 180 };

describe('buildExerciseStats with a WeightContext', () => {
  it('shows sets, trend and PR in the profile unit', () => {
    const stats = buildExerciseStats(rows, [], { ctx: kg });
    expect(stats.sessions.map(s => s.sets)).toEqual([['101.6 × 5'], ['83.9 × 5'], ['80 × 5']]);
    expect(stats.trend.map(p => Math.round(p.value))).toEqual([93, 98, 119]);
    expect(stats.pr).toEqual({ display: '119', date: '2026-06-22' });
  });

  it('keeps pounds for a machine reader, and reads the default context as before', () => {
    const lb = buildExerciseStats(rows, [], { ctx: kg, displayUnit: 'lb' });
    expect(lb.sessions.map(s => s.sets)).toEqual([['224.1 × 5'], ['185 × 5'], ['176.4 × 5']]);
    expect(lb.pr?.display).toBe(String(Math.round((180 + 20 * LB_PER_KG) * (1 + 5 / 30))));
    const plain = buildExerciseStats(rows, []);
    expect(plain.sessions.map(s => s.sets)).toEqual([['5 reps'], ['185 × 5'], ['80 × 5']]);
    expect(plain.pr?.display).toBe(String(Math.round(185 * (1 + 5 / 30))));
    expect(80 * LB_PER_KG).toBeGreaterThan(176); // the kg reading above is the converted bare 80
  });
});
