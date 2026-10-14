import { describe, it, expect } from 'vitest';
import { hasPercentTargets, parsePercent, resolvePercentTargets, resolvePercentWeight } from '../percent';
import { buildTrackerModel, setToRow } from '../plan';
import { classifySet, computeSessionPRs } from '../records';
import { computeStrengthStats } from '../../review/stats';
import { DEFAULT_WEIGHT_CONTEXT, LB_PER_KG, parseWeight, type WeightContext } from '../weight';
import type { Exercise, WorkoutEvent } from '../../../types/workout';
import type { SetLogRow } from '../../db/types';
import type { StatsPeriod } from '../../review/types';

// "80%" as a planned weight is 80% of the lift's best estimated 1RM, rounded
// to the plate step in the profile's unit, resolved at bootstrap. With no
// history it stays text; unresolved, it is never a weight anywhere.

const LB = DEFAULT_WEIGHT_CONTEXT;
const KG: WeightContext = { unit: 'kg', bodyWeightLb: null };

describe('parsePercent — the grammar', () => {
  it.each([
    ['80%', 80], [' 80 % ', 80], ['80 %', 80], ['1%', 1], ['150%', 150], ['72.5%', 72.5], ['72,5%', 72.5],
  ])('%j is %d', (text, percent) => {
    expect(parsePercent(text)).toBe(percent);
  });

  it.each([
    '80', '0%', '0.5%', '151%', '150.5%', '%80', '-80%', '+80%', '~80%', '80%%', '80% 1RM', '80% x 5', '80 kg',
    '1e2%', '.5%', '80.%', '', '   ', '%',
  ])('%j is not a percentage', text => {
    expect(parsePercent(text)).toBeNull();
  });

  it('null and undefined are not percentages', () => {
    expect(parsePercent(null)).toBeNull();
    expect(parsePercent(undefined)).toBeNull();
  });
});

describe('resolvePercentWeight — rounding per unit', () => {
  it('pounds round to the nearest 2.5 lb', () => {
    expect(resolvePercentWeight('80%', 231.25, LB)).toEqual({ lb: 185, display: '185' });
    // 230 × 0.8 = 184 → 185; 233.33 × 0.8 = 186.67 → 187.5; 230 × 0.7 = 161 → 160.
    expect(resolvePercentWeight('80%', 230, LB)).toEqual({ lb: 185, display: '185' });
    expect(resolvePercentWeight('80%', 200 * (1 + 5 / 30), LB)).toEqual({ lb: 187.5, display: '187.5' });
    expect(resolvePercentWeight('70%', 230, LB)).toEqual({ lb: 160, display: '160' });
    expect(resolvePercentWeight('72.5%', 200, LB)).toEqual({ lb: 145, display: '145' });
  });

  it('kilograms round to the nearest 1 kg and print in kg', () => {
    // 100 kg × 0.8 = 80 kg; 103 kg × 0.8 = 82.4 → 82 kg; 103 kg × 0.85 = 87.55 → 88 kg.
    const r80 = resolvePercentWeight('80%', 100 * LB_PER_KG, KG)!;
    expect(r80.display).toBe('80');
    expect(r80.lb).toBeCloseTo(80 * LB_PER_KG, 6);
    expect(resolvePercentWeight('80%', 103 * LB_PER_KG, KG)!.display).toBe('82');
    expect(resolvePercentWeight('85%', 103 * LB_PER_KG, KG)!.display).toBe('88');
  });

  it('the same 1RM rounds by the unit it is read in', () => {
    // 231.25 lb × 0.8 = 185 lb = 83.91 kg → 84 kg.
    expect(resolvePercentWeight('80%', 231.25, LB)!.display).toBe('185');
    expect(resolvePercentWeight('80%', 231.25, KG)!.display).toBe('84');
  });

  it('a load that rounds to nothing is not a target', () => {
    expect(resolvePercentWeight('1%', 100, LB)).toBeNull();
    expect(resolvePercentWeight('1%', 200, LB)).toEqual({ lb: 2.5, display: '2.5' });
  });

  it('no history — no 1RM — resolves nothing', () => {
    expect(resolvePercentWeight('80%', null, LB)).toBeNull();
    expect(resolvePercentWeight('80%', undefined, LB)).toBeNull();
    expect(resolvePercentWeight('80%', 0, LB)).toBeNull();
    expect(resolvePercentWeight('80%', Number.NaN, LB)).toBeNull();
  });

  it('text that is not a percentage resolves nothing, even with a 1RM', () => {
    expect(resolvePercentWeight('185', 231.25, LB)).toBeNull();
    expect(resolvePercentWeight('80% 1RM', 231.25, LB)).toBeNull();
    expect(resolvePercentWeight(undefined, 231.25, LB)).toBeNull();
  });
});

// ─── The tracker model ────────────────────────────────────────────────────────

function makeEvent(exercises: Exercise[]): WorkoutEvent {
  return {
    id: 'w1__2026-07-06', type: 'weights', title: 'Strength', date: '2026-07-06', estimatedDuration: 60,
    description: '', exercises, difficulty: 3, tags: [], isCompleted: false, isRecurring: false,
  };
}

function row(overrides: Partial<SetLogRow>): SetLogRow {
  return {
    event_id: 'w0__2026-06-01', event_date: '2026-06-01', section: 'exercise', exercise_id: 'x',
    exercise_name: 'Bench Press', set_number: 1, planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: '230', actual_reps: '1', actual_duration: null, is_autofilled: false, ...overrides,
  };
}

const EXERCISES: Exercise[] = [
  { id: 'b', name: 'Bench Press', category: 'strength', sets: 2, reps: '5', weight: '80%' },
  {
    id: 's', name: 'Back Squat', category: 'strength',
    plannedSets: [{ setNumber: 1, targetWeight: '70%', targetReps: '5' }, { setNumber: 2, targetWeight: '185', targetReps: '5' }],
  },
  { id: 'd', name: 'Deadlift', category: 'strength', sets: 1, reps: '3', weight: '80%' },
  { id: 'c', name: 'Board', category: 'climbing', grade: '80%' },
  { id: 'r', name: 'Row Erg', category: 'cardio', duration: '10 min' },
];

const HISTORY: SetLogRow[] = [
  row({ exercise_name: 'Bench Press', actual_weight: '230', actual_reps: '1' }),
  // A heavier warm-up and an autofilled row are not performances: no 1RM from them.
  row({ exercise_name: 'Bench Press', set_number: 2, actual_weight: '400', actual_reps: '1', is_warmup: true }),
  row({ exercise_name: 'Bench Press', set_number: 3, actual_weight: '400', actual_reps: '1', is_autofilled: true }),
  row({ exercise_name: 'Back Squat', actual_weight: '300', actual_reps: '1' }),
  row({ exercise_name: 'Board', actual_weight: '500', actual_reps: '1' }),
];

const setsOf = (groups: ReturnType<typeof buildTrackerModel>, name: string) =>
  groups.flatMap(g => g.exercises).find(t => t.exercise.name === name)!.sets;

describe('resolvePercentTargets — the bootstrap step', () => {
  const model = buildTrackerModel(makeEvent(EXERCISES));

  it('resolves uniform and per-set percentage targets against the lift’s best 1RM', () => {
    const groups = resolvePercentTargets(model, HISTORY, LB);
    expect(setsOf(groups, 'Bench Press').map(s => s.resolvedPlannedWeight)).toEqual(['185', '185']);
    // 300 × 0.7 = 210; set 2 is a plain weight and stays as written.
    expect(setsOf(groups, 'Back Squat').map(s => s.resolvedPlannedWeight)).toEqual(['210', undefined]);
    expect(setsOf(groups, 'Back Squat')[1]).not.toHaveProperty('resolvedPlannedWeight');
  });

  it('no history leaves the field absent, so the raw text shows', () => {
    const groups = resolvePercentTargets(model, HISTORY, LB);
    const [deadlift] = setsOf(groups, 'Deadlift');
    expect(deadlift).not.toHaveProperty('resolvedPlannedWeight');
    expect(deadlift.planned.targetWeight).toBe('80%');
  });

  it('a pitch never resolves — its weight column is a grade', () => {
    const groups = resolvePercentTargets(model, HISTORY, LB);
    expect(setsOf(groups, 'Board')[0]).not.toHaveProperty('resolvedPlannedWeight');
  });

  it('reads history under the profile’s unit', () => {
    const kgHistory = [row({ exercise_name: 'Bench Press', actual_weight: '100', actual_reps: '1' })];
    expect(setsOf(resolvePercentTargets(model, kgHistory, KG), 'Bench Press')[0].resolvedPlannedWeight).toBe('80');
    // The same bare "100" is 100 lb to a pounds lifter: 80 lb.
    expect(setsOf(resolvePercentTargets(model, kgHistory, LB), 'Bench Press')[0].resolvedPlannedWeight).toBe('80');
    const lbHistory = [row({ exercise_name: 'Bench Press', actual_weight: '100 lb', actual_reps: '1' })];
    // 100 lb = 45.36 kg × 0.8 = 36.3 → 36 kg.
    expect(setsOf(resolvePercentTargets(model, lbHistory, KG), 'Bench Press')[0].resolvedPlannedWeight).toBe('36');
  });

  it('leaves a model with no percentage untouched, and does not mutate its input', () => {
    const plain = buildTrackerModel(makeEvent([{ id: 'b', name: 'Bench Press', category: 'strength', sets: 1, reps: '5', weight: '185' }]));
    expect(hasPercentTargets(plain)).toBe(false);
    expect(resolvePercentTargets(plain, HISTORY, LB)).toBe(plain);
    expect(hasPercentTargets(model)).toBe(true);
    resolvePercentTargets(model, HISTORY, LB);
    expect(setsOf(model, 'Bench Press')[0]).not.toHaveProperty('resolvedPlannedWeight');
  });

  it('a climbing-only "80%" grade does not count as a percentage target', () => {
    const climb = buildTrackerModel(makeEvent([{ id: 'c', name: 'Board', category: 'climbing', grade: '80%' }]));
    expect(hasPercentTargets(climb)).toBe(false);
  });
});

describe('an unresolved percentage is never a lift', () => {
  it('parseWeight and classifySet read "80%" as no weight', () => {
    expect(parseWeight('80%', LB)).toBeNull();
    expect(classifySet('80%', '5', null, LB)).toEqual({ kind: 'reps', reps: 5 });
  });

  it('adds nothing to tonnage', () => {
    const period: StatsPeriod = {
      startDate: '2026-07-01', endDateExclusive: '2026-08-01', periodType: 'block', label: 'Jul 2026', weeksInPeriod: 4,
    };
    const rows = [row({ event_date: '2026-07-06', actual_weight: '80%', actual_reps: '5' })];
    expect(computeStrengthStats(rows, period, LB).tonnage).toBe(0);
  });

  it('the resolved number is display only: never saved, never a record', () => {
    const groups = resolvePercentTargets(buildTrackerModel(makeEvent([EXERCISES[0]])), HISTORY, LB);
    const [tracked] = groups[0].exercises;
    const saved = setToRow('w1__2026-07-06', '2026-07-06', tracked, { ...tracked.sets[0], actualReps: '5' });
    expect(saved.planned_weight).toBe('80%');
    expect(saved.actual_weight).toBeNull();
    expect(JSON.stringify(saved)).not.toContain('185');
    // Reps logged against a resolved target, no weight typed: no 1RM record.
    const logged = groups.map(g => ({
      ...g, exercises: g.exercises.map(t => ({ ...t, sets: t.sets.map(s => ({ ...s, actualReps: '5', isLogged: true })) })),
    }));
    expect(computeSessionPRs(logged, HISTORY, [], LB).filter(pr => pr.kind === 'oneRM')).toEqual([]);
  });
});
