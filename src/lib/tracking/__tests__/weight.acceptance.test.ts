// Acceptance tests for weight parsing (parseWeight, R1.x) and the unit-aware
// set classification built on it (classifySet / bestHistoricalOneRM /
// computeSessionPRs), written from the spec alone against an implementation
// this file never saw. On the contract stub every parser case fails with
// "not implemented: parseWeight"; classification cases fail by that error or
// by assertion, because today's classifySet reads parseLeadingNumber and
// knows nothing of units, body weight or `load`.
// Seven readings the spec left open were ruled by the coordinator and are
// pinned here as ordinary cases (thousands comma, number lexicon, BW+0, a
// non-positive bodyweight result, the record weight, a trailing period after
// a unit, bodyWeightLb always in lb). Amendments A3 (more unit spellings)
// and A4 (how describeRecord prints a converted weight) are at the end.
// Cases whose name starts with `REGRESSION:` also pass on the stub and are
// kept because the spec names the behaviour as one the change must not alter.
// Cases whose name starts with `AMBIGUOUS:` assume something the spec does
// not say.
import { describe, it, expect } from 'vitest';
import { DEFAULT_WEIGHT_CONTEXT, LB_PER_KG, parseWeight } from '../weight';
import type { WeightContext } from '../weight';
import {
  bestHistoricalOneRM,
  classifySet,
  computeSessionPRs,
  describeRecord,
  describeRecordForPeople,
  estimateOneRepMax,
} from '../records';
import { buildTrackerModel } from '../plan';
import type { TrackedSectionGroup } from '../plan';
import type { Exercise, WorkoutEvent } from '../../../types/workout';
import type { SetLogRow } from '../../db/types';

/** The spec's conversion factor, used for every expected value here so the
 *  arithmetic never depends on the implementation's export (which a case
 *  below pins to this number). */
const SPEC_LB_PER_KG = 2.20462;

const LB: WeightContext = { unit: 'lb', bodyWeightLb: null };
const KG: WeightContext = { unit: 'kg', bodyWeightLb: null };
const LB_BW: WeightContext = { unit: 'lb', bodyWeightLb: 180 };
const KG_BW: WeightContext = { unit: 'kg', bodyWeightLb: 180 };

const bench: Exercise = {
  id: 'ub-1',
  name: 'Bench Press',
  category: 'strength',
  sets: 3,
  reps: '5',
  weight: '185lb',
};

const dips: Exercise = {
  id: 'ub-4',
  name: 'Weighted Dips',
  category: 'strength',
  sets: 3,
  reps: '8',
  weight: 'BW+25',
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

/** The mixed-unit lineage from the spec: 60 kg × 5 (est 154.32) and 135 lb × 5 (est 157.5). */
const mixedHistory = [
  historyRow({ actual_weight: '60 kg', actual_reps: '5', event_date: '2026-06-01' }),
  historyRow({ actual_weight: '135 lb', actual_reps: '5', event_date: '2026-06-08' }),
];

const epley = (lb: number, reps: number) => estimateOneRepMax(lb, reps);

// ─── parseWeight: grammar (R1.4) ─────────────────────────────────────────────

describe('parseWeight — accepted forms', () => {
  it('a bare number is absolute in the context unit', () => {
    expect(parseWeight('185', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('62.5', LB)).toEqual({ lb: 62.5, kind: 'absolute' });
    const kg = parseWeight('100', KG);
    expect(kg).toMatchObject({ kind: 'absolute' });
    expect(kg?.lb).toBeCloseTo(220.462, 5);
  });

  it('a suffixed number is absolute in the suffix unit, both spellings of each', () => {
    expect(parseWeight('185lb', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185lbs', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('100kg', LB)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('100kgs', LB)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('100kg', LB)?.kind).toBe('absolute');
  });

  it('a suffix wins over the context unit in both directions', () => {
    expect(parseWeight('100 lb', KG)).toEqual({ lb: 100, kind: 'absolute' });
    expect(parseWeight('100 lbs', KG)).toEqual({ lb: 100, kind: 'absolute' });
    expect(parseWeight('100 kg', LB)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('100 kg', KG)?.lb).toBeCloseTo(220.462, 5);
  });

  it('space between number and suffix changes nothing', () => {
    expect(parseWeight('100 kg', LB)).toEqual(parseWeight('100kg', LB));
    expect(parseWeight('185 lb', LB)).toEqual(parseWeight('185lb', LB));
    expect(parseWeight('185 lbs', LB)).toEqual({ lb: 185, kind: 'absolute' });
  });

  it('is case-insensitive in suffixes', () => {
    expect(parseWeight('185LB', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185 Lbs', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('100KG', LB)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('100Kg', LB)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('100KGS', LB)?.lb).toBeCloseTo(220.462, 5);
  });

  it('tolerates leading and trailing whitespace', () => {
    expect(parseWeight('  185', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185  ', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight(' 185 lb ', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('\t185\n', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('  100 kg  ', LB)?.lb).toBeCloseTo(220.462, 5);
  });

  it('accepts a comma as the decimal separator', () => {
    expect(parseWeight('62,5', LB)).toEqual({ lb: 62.5, kind: 'absolute' });
    expect(parseWeight('62,5 lb', LB)).toEqual({ lb: 62.5, kind: 'absolute' });
    expect(parseWeight('62,5 kg', LB)?.lb).toBeCloseTo(137.78875, 5);
    expect(parseWeight('62,5 kg', LB)).toEqual(parseWeight('62.5 kg', LB));
  });

  it('a comma followed by exactly three digits and nothing more is a thousands separator', () => {
    expect(parseWeight('1,200', LB)).toEqual({ lb: 1200, kind: 'absolute' });
    expect(parseWeight('12,345', LB)).toEqual({ lb: 12345, kind: 'absolute' });
    expect(parseWeight('1,200 lb', LB)).toEqual({ lb: 1200, kind: 'absolute' });
    expect(parseWeight('1,200', KG)?.lb).toBeCloseTo(1200 * SPEC_LB_PER_KG, 5);
    expect(parseWeight('1,200 kg', LB)?.lb).toBeCloseTo(1200 * SPEC_LB_PER_KG, 5);
    // Any other digit count after the comma is a decimal.
    expect(parseWeight('1,20', LB)).toEqual({ lb: 1.2, kind: 'absolute' });
    expect(parseWeight('1,2', LB)).toEqual({ lb: 1.2, kind: 'absolute' });
    expect(parseWeight('1,2000', LB)).toEqual({ lb: 1.2, kind: 'absolute' });
    expect(parseWeight('62,5', LB)).toEqual({ lb: 62.5, kind: 'absolute' });
  });

  it('accepts an optional trailing period after a unit', () => {
    expect(parseWeight('185 lbs.', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185 lb.', KG)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185lbs.', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185 LBS.', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('100 kg.', LB)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('100kg.', LB)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('100 kgs.', LB)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('185 lbs. ', LB)).toEqual({ lb: 185, kind: 'absolute' });
    // "after a unit" — the load suffix of a bodyweight form is a unit too.
    expect(parseWeight('BW+25 lbs.', LB_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    // Only one, only after a unit, and nothing after it.
    expect(parseWeight('185 lbs..', LB)).toBeNull();
    expect(parseWeight('185 lbs. kg', LB)).toBeNull();
    expect(parseWeight('185 .lbs', LB)).toBeNull();
    expect(parseWeight('185.', LB)).toBeNull();
    expect(parseWeight('BW.', LB_BW)).toBeNull();
  });
});

describe('parseWeight — rejected forms', () => {
  const rejects = ['5.10a', 'V5', '100kg x 5', '80%', 'heavy', '-10', '+10', ''];

  it.each(rejects)('rejects %j', (text) => {
    expect(parseWeight(text, LB)).toBeNull();
    expect(parseWeight(text, KG_BW)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(parseWeight(null, LB)).toBeNull();
    expect(parseWeight(undefined, LB)).toBeNull();
    expect(parseWeight(null, KG_BW)).toBeNull();
  });

  it('rejects whitespace-only text', () => {
    expect(parseWeight('   ', LB)).toBeNull();
    expect(parseWeight('\t', LB)).toBeNull();
  });

  it('is whole-string: anything beyond one number and one suffix is null', () => {
    expect(parseWeight('185 5', LB)).toBeNull();
    expect(parseWeight('185lb5', LB)).toBeNull();
    expect(parseWeight('185 lb kg', LB)).toBeNull();
    expect(parseWeight('lb 185', LB)).toBeNull();
    expect(parseWeight('185l', LB)).toBeNull();
    expect(parseWeight('100 k', LB)).toBeNull();
    expect(parseWeight('kg', LB)).toBeNull();
    expect(parseWeight('lb', LB)).toBeNull();
    expect(parseWeight('~185', LB)).toBeNull();
    expect(parseWeight('185-190', LB)).toBeNull();
    expect(parseWeight('1.2.3', LB)).toBeNull();
    expect(parseWeight('1,2,3', LB)).toBeNull();
  });

  it('rejects words that Number() would accept', () => {
    expect(parseWeight('Infinity', LB)).toBeNull();
    expect(parseWeight('NaN', LB)).toBeNull();
    expect(parseWeight('0x10', LB)).toBeNull();
  });

  it('rejects exponent notation and a bare decimal separator', () => {
    // "a number" is digits with an optional fraction, like every other
    // tracker parser.
    expect(parseWeight('1e3', LB)).toBeNull();
    expect(parseWeight('.5', LB)).toBeNull();
    expect(parseWeight('185.', LB)).toBeNull();
  });
});

// ─── parseWeight: bodyweight forms (R1.2, R1.4) ──────────────────────────────

describe('parseWeight — bodyweight forms with a body weight', () => {
  it('bare BW is the body weight itself, case-insensitive, whitespace tolerated', () => {
    expect(parseWeight('BW', LB_BW)).toEqual({ lb: 180, kind: 'bodyweight' });
    expect(parseWeight('bw', LB_BW)).toEqual({ lb: 180, kind: 'bodyweight' });
    expect(parseWeight('Bw', LB_BW)).toEqual({ lb: 180, kind: 'bodyweight' });
    expect(parseWeight('  BW  ', LB_BW)).toEqual({ lb: 180, kind: 'bodyweight' });
  });

  it('BW is the stored body weight in lb regardless of the context unit', () => {
    expect(parseWeight('BW', KG_BW)).toEqual({ lb: 180, kind: 'bodyweight' });
  });

  it('BW±load adds or subtracts the load in the context unit', () => {
    expect(parseWeight('BW+25', LB_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    expect(parseWeight('BW-10', LB_BW)).toEqual({ lb: 170, kind: 'bodyweight' });
    const plusKg = parseWeight('BW+25', KG_BW);
    expect(plusKg).toMatchObject({ kind: 'bodyweight' });
    expect(plusKg?.lb).toBeCloseTo(180 + 25 * SPEC_LB_PER_KG, 5); // 235.1155
    const minusKg = parseWeight('BW-10', KG_BW);
    expect(minusKg?.lb).toBeCloseTo(180 - 10 * SPEC_LB_PER_KG, 5); // 157.9538
  });

  it('a suffix on the load wins over the context unit', () => {
    const kgUnderLb = parseWeight('BW+25kg', LB_BW);
    expect(kgUnderLb).toMatchObject({ kind: 'bodyweight' });
    expect(kgUnderLb?.lb).toBeCloseTo(235.1155, 5);
    expect(parseWeight('BW+25lb', KG_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    expect(parseWeight('BW+25 lbs', KG_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    expect(parseWeight('BW-10kgs', LB_BW)?.lb).toBeCloseTo(157.9538, 5);
  });

  it('tolerates spaces around the sign and before the suffix, and any case', () => {
    expect(parseWeight('bw + 25 lbs', LB_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    expect(parseWeight('BW +25', LB_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    expect(parseWeight('BW+ 25', LB_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    expect(parseWeight('bw - 10', LB_BW)).toEqual({ lb: 170, kind: 'bodyweight' });
    expect(parseWeight('BW+25KG', LB_BW)?.lb).toBeCloseTo(235.1155, 5);
    expect(parseWeight(' bw+25 ', LB_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
  });

  it('accepts a decimal load with dot or comma', () => {
    expect(parseWeight('BW+2.5', LB_BW)).toEqual({ lb: 182.5, kind: 'bodyweight' });
    expect(parseWeight('BW+2,5', LB_BW)).toEqual({ lb: 182.5, kind: 'bodyweight' });
    expect(parseWeight('BW+2,5kg', LB_BW)?.lb).toBeCloseTo(180 + 2.5 * SPEC_LB_PER_KG, 5);
  });

  it('rejects malformed BW forms', () => {
    expect(parseWeight('BW25', LB_BW)).toBeNull();
    expect(parseWeight('BW+', LB_BW)).toBeNull();
    expect(parseWeight('+BW', LB_BW)).toBeNull();
    expect(parseWeight('BW+25+5', LB_BW)).toBeNull();
    expect(parseWeight('BW+25 x 8', LB_BW)).toBeNull();
    expect(parseWeight('BW*2', LB_BW)).toBeNull();
    expect(parseWeight('BWT', LB_BW)).toBeNull();
    expect(parseWeight('BW+25%', LB_BW)).toBeNull();
    expect(parseWeight('BW+-25', LB_BW)).toBeNull();
  });

  it('BW+0 is the body weight, still tagged bodyweight', () => {
    expect(parseWeight('BW+0', LB_BW)).toEqual({ lb: 180, kind: 'bodyweight' });
    expect(parseWeight('BW-0', LB_BW)).toEqual({ lb: 180, kind: 'bodyweight' });
  });

  it('a bodyweight form whose resolved weight is not positive is null', () => {
    expect(parseWeight('BW-200', LB_BW)).toBeNull();
    expect(parseWeight('BW-180', LB_BW)).toBeNull();
    expect(parseWeight('BW-179', LB_BW)).toEqual({ lb: 1, kind: 'bodyweight' });
    expect(parseWeight('BW-82kg', LB_BW)).toBeNull(); // 82 kg = 180.78 lb
    expect(parseWeight('BW-81kg', LB_BW)?.lb).toBeCloseTo(180 - 81 * SPEC_LB_PER_KG, 5);
    expect(parseWeight('bw - 200 lbs', KG_BW)).toBeNull();
  });
});

describe('parseWeight — bodyweight forms without a usable body weight (R1.2)', () => {
  const noBody: [string, WeightContext][] = [
    ['null', { unit: 'lb', bodyWeightLb: null }],
    ['zero', { unit: 'lb', bodyWeightLb: 0 }],
    ['negative', { unit: 'lb', bodyWeightLb: -180 }],
    ['NaN', { unit: 'lb', bodyWeightLb: Number.NaN }],
    ['Infinity', { unit: 'lb', bodyWeightLb: Number.POSITIVE_INFINITY }],
    ['the default context', DEFAULT_WEIGHT_CONTEXT],
  ];

  it.each(noBody)('every BW form is null when bodyWeightLb is %s', (_label, ctx) => {
    expect(parseWeight('BW', ctx)).toBeNull();
    expect(parseWeight('BW+25', ctx)).toBeNull();
    expect(parseWeight('BW-10', ctx)).toBeNull();
    expect(parseWeight('BW+25kg', ctx)).toBeNull();
    expect(parseWeight('bw + 25 lbs', ctx)).toBeNull();
  });

  it.each(noBody)('absolute weights still parse when bodyWeightLb is %s', (_label, ctx) => {
    expect(parseWeight('185', ctx)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('100 kg', ctx)?.lb).toBeCloseTo(220.462, 5);
  });
});

// ─── parseWeight: zero, precision, defaults (R1.5, R1.7, R1.3) ───────────────

describe('parseWeight — zero (R1.5)', () => {
  it('"0" parses as an absolute zero, not null', () => {
    expect(parseWeight('0', LB)).toEqual({ lb: 0, kind: 'absolute' });
    expect(parseWeight('0', KG)).toEqual({ lb: 0, kind: 'absolute' });
    expect(parseWeight('0 kg', LB)).toEqual({ lb: 0, kind: 'absolute' });
    expect(parseWeight('0.0', LB)).toEqual({ lb: 0, kind: 'absolute' });
    expect(parseWeight('0 lbs', LB)).toEqual({ lb: 0, kind: 'absolute' });
  });
});

describe('parseWeight — kg precision (R1.7)', () => {
  it('exports the conversion factor the spec names', () => {
    expect(LB_PER_KG).toBe(2.20462);
  });

  it('converts kg × 2.20462 and keeps the float', () => {
    expect(parseWeight('62.5 kg', LB)?.lb).toBeCloseTo(137.78875, 5);
    expect(parseWeight('1 kg', LB)?.lb).toBeCloseTo(2.20462, 5);
    expect(parseWeight('1kg', LB)?.lb).toBe(SPEC_LB_PER_KG);
    expect(parseWeight('100', KG)?.lb).toBeCloseTo(220.462, 5);
  });

  it('never rounds: a tiny load keeps its decimals', () => {
    // 0.001 kg = 0.00220462 lb; rounding to two or three places would zero it.
    expect(parseWeight('0.001 kg', LB)?.lb).toBeCloseTo(0.00220462, 8);
    expect(parseWeight('0.001 kg', LB)?.lb).toBeGreaterThan(0);
    const lb = parseWeight('62.5 kg', LB)?.lb;
    expect(lb).not.toBe(137.79);
    expect(lb).not.toBe(137.8);
    expect(lb).not.toBe(138);
  });

  it('parses identical text to identical numbers, with or without a space', () => {
    expect(parseWeight('100 kg', LB)?.lb).toBe(parseWeight('100kg', LB)?.lb);
    expect(parseWeight('62.5 kg', LB)?.lb).toBe(parseWeight('62.5kg', LB)?.lb);
    expect(parseWeight('62.5 kg', LB)?.lb).toBe(parseWeight('62.5 KG', KG)?.lb);
  });
});

describe('parseWeight — context unit default (R1.3)', () => {
  it('a bare number follows ctx.unit', () => {
    expect(parseWeight('100', LB)).toEqual({ lb: 100, kind: 'absolute' });
    expect(parseWeight('100', KG)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('100', KG)?.kind).toBe('absolute');
    expect(parseWeight('62.5', KG)?.lb).toBeCloseTo(137.78875, 5);
  });

  it('DEFAULT_WEIGHT_CONTEXT is lb with no body weight', () => {
    expect(parseWeight('100', DEFAULT_WEIGHT_CONTEXT)).toEqual({ lb: 100, kind: 'absolute' });
    expect(parseWeight('100 kg', DEFAULT_WEIGHT_CONTEXT)?.lb).toBeCloseTo(220.462, 5);
    expect(parseWeight('BW', DEFAULT_WEIGHT_CONTEXT)).toBeNull();
    expect(parseWeight('BW+25', DEFAULT_WEIGHT_CONTEXT)).toBeNull();
  });

  it('does not mutate the context it is given', () => {
    const ctx: WeightContext = { unit: 'kg', bodyWeightLb: 180 };
    parseWeight('100', ctx);
    parseWeight('BW+25', ctx);
    expect(ctx).toEqual({ unit: 'kg', bodyWeightLb: 180 });
  });
});

// ─── classifySet with a context ───────────────────────────────────────────────

describe('classifySet — unit-aware weights', () => {
  it('a bare number is in the context unit, and the result carries load: absolute', () => {
    expect(classifySet('100', '5', null, LB)).toEqual({
      kind: 'oneRM', weight: 100, reps: 5, oneRM: epley(100, 5), load: 'absolute',
    });
    const kg = classifySet('100', '5', null, KG);
    expect(kg).toMatchObject({ kind: 'oneRM', reps: 5, load: 'absolute' });
    expect(kg?.kind === 'oneRM' && kg.weight).toBeCloseTo(220.462, 5);
    expect(kg?.kind === 'oneRM' && kg.oneRM).toBeCloseTo(epley(220.462, 5), 5);
  });

  it('a kg suffix converts to lb before Epley, under either context unit', () => {
    for (const ctx of [LB, KG]) {
      const set = classifySet('62.5 kg', '5', null, ctx);
      expect(set).toMatchObject({ kind: 'oneRM', reps: 5, load: 'absolute' });
      expect(set?.kind === 'oneRM' && set.weight).toBeCloseTo(137.78875, 5);
      expect(set?.kind === 'oneRM' && set.oneRM).toBeCloseTo(epley(137.78875, 5), 5);
    }
  });

  it('omitting ctx is the same as passing DEFAULT_WEIGHT_CONTEXT', () => {
    expect(classifySet('100 kg', '5', null)).toEqual(classifySet('100 kg', '5', null, DEFAULT_WEIGHT_CONTEXT));
    expect(classifySet('100', '5', null)).toEqual(classifySet('100', '5', null, DEFAULT_WEIGHT_CONTEXT));
    expect(classifySet('BW', '8', null)).toEqual(classifySet('BW', '8', null, DEFAULT_WEIGHT_CONTEXT));
    expect(classifySet('100', '5', null)).toEqual({
      kind: 'oneRM', weight: 100, reps: 5, oneRM: epley(100, 5), load: 'absolute',
    });
    const kg = classifySet('100 kg', '5', null);
    expect(kg?.kind === 'oneRM' && kg.weight).toBeCloseTo(220.462, 5);
  });

  it('a bodyweight row earns oneRM like any other, tagged load: bodyweight (R1.1)', () => {
    expect(classifySet('BW+25', '8', null, LB_BW)).toEqual({
      kind: 'oneRM', weight: 205, reps: 8, oneRM: epley(205, 8), load: 'bodyweight',
    });
    expect(classifySet('BW', '12', null, LB_BW)).toEqual({
      kind: 'oneRM', weight: 180, reps: 12, oneRM: epley(180, 12), load: 'bodyweight',
    });
    expect(classifySet('bw - 10', '1', null, LB_BW)).toEqual({
      kind: 'oneRM', weight: 170, reps: 1, oneRM: 170, load: 'bodyweight',
    });
    const kgLoad = classifySet('BW+25', '8', null, KG_BW);
    expect(kgLoad).toMatchObject({ kind: 'oneRM', reps: 8, load: 'bodyweight' });
    expect(kgLoad?.kind === 'oneRM' && kgLoad.weight).toBeCloseTo(235.1155, 5);
  });

  it('a bodyweight row with no body weight in the context is not a oneRM candidate', () => {
    // Without a body weight "BW" cannot resolve, so the row falls through to
    // its reps or duration exactly as it does today.
    expect(classifySet('BW+25', '8', null, LB)).toEqual({ kind: 'reps', reps: 8 });
    expect(classifySet('BW', null, '60s', LB)).toEqual({ kind: 'duration', seconds: 60 });
    expect(classifySet('BW+25', '8', null, { unit: 'lb', bodyWeightLb: 0 })).toEqual({ kind: 'reps', reps: 8 });
    // And with one, the same row is a oneRM.
    expect(classifySet('BW+25', '8', null, LB_BW)?.kind).toBe('oneRM');
  });

  it('REGRESSION: a zero weight is never oneRM and falls through (R1.5)', () => {
    expect(classifySet('0', '5', null, LB)).toEqual({ kind: 'reps', reps: 5 });
    expect(classifySet('0', '5', null, KG)).toEqual({ kind: 'reps', reps: 5 });
    expect(classifySet('0 kg', '5', null, LB)).toEqual({ kind: 'reps', reps: 5 });
    expect(classifySet('0', null, '60s', LB)).toEqual({ kind: 'duration', seconds: 60 });
    expect(classifySet('0', '5', null)).toEqual({ kind: 'reps', reps: 5 });
    expect(classifySet('0', null, null, LB)).toBeNull();
  });

  it('a weight that parses with no usable reps is null, not a fall-through', () => {
    expect(classifySet('100 kg', null, '60s', LB)).toBeNull();
    expect(classifySet('100 kg', '0', null, LB)).toBeNull();
    expect(classifySet('BW+25', null, '60s', LB_BW)).toBeNull();
  });

  it('text the grammar rejects is treated as no weight and falls through', () => {
    // Today parseLeadingNumber reads 100 out of "100kg x 5" and 80 out of
    // "80%"; the parser rejects both, so the rule — weight × reps when the
    // weight parses, otherwise duration, otherwise reps — sends them on.
    expect(classifySet('100kg x 5', '5', null, LB)).toEqual({ kind: 'reps', reps: 5 });
    expect(classifySet('80%', '5', null, LB)).toEqual({ kind: 'reps', reps: 5 });
    expect(classifySet('5.10a', '5', null, LB)).toEqual({ kind: 'reps', reps: 5 });
    expect(classifySet('heavy', null, '60s', LB)).toEqual({ kind: 'duration', seconds: 60 });
  });

  it('a trailing period after the unit still parses, so the row is oneRM', () => {
    expect(classifySet('185 lbs.', '5', null, LB)).toEqual({
      kind: 'oneRM', weight: 185, reps: 5, oneRM: epley(185, 5), load: 'absolute',
    });
    const kg = classifySet('100 kg.', '5', null, LB);
    expect(kg).toMatchObject({ kind: 'oneRM', reps: 5, load: 'absolute' });
    expect(kg?.kind === 'oneRM' && kg.weight).toBeCloseTo(220.462, 5);
  });
});

// ─── bestHistoricalOneRM: one lineage across units ────────────────────────────

describe('bestHistoricalOneRM — mixed-unit history', () => {
  it('compares kg and lb rows of one exercise in lb and keeps the higher Epley value', () => {
    const best = bestHistoricalOneRM(mixedHistory, LB);
    expect(best.size).toBe(1);
    const record = best.get('Bench Press');
    expect(record?.weight).toBe(135);
    expect(record?.reps).toBe(5);
    expect(record?.oneRM).toBeCloseTo(157.5, 5);
    expect(record?.date).toBe('2026-06-08');
    // The kg row lost on its converted value, not by failing to parse: alone it is the best.
    const kgAlone = bestHistoricalOneRM([mixedHistory[0]], LB).get('Bench Press');
    expect(kgAlone?.weight).toBeCloseTo(132.2772, 4);
    expect(kgAlone?.oneRM).toBeCloseTo(154.3234, 4);
  });

  it('the kg row wins when its converted value is higher', () => {
    const best = bestHistoricalOneRM([
      historyRow({ actual_weight: '65 kg', actual_reps: '5', event_date: '2026-06-01' }), // 143.30 lb → 167.18
      historyRow({ actual_weight: '135 lb', actual_reps: '5', event_date: '2026-06-08' }), // 157.5
    ], LB);
    const record = best.get('Bench Press');
    expect(record?.weight).toBeCloseTo(65 * SPEC_LB_PER_KG, 5);
    expect(record?.oneRM).toBeCloseTo(epley(65 * SPEC_LB_PER_KG, 5), 5);
    expect(record?.date).toBe('2026-06-01');
  });

  it('suffixed rows are unit-fixed whatever the context; bare rows follow it', () => {
    // Under kg the suffixed rows are unchanged, so the 135 lb set still wins.
    expect(bestHistoricalOneRM(mixedHistory, KG).get('Bench Press')?.weight).toBe(135);
    // A bare "70" under kg is 70 kg = 154.32 lb → est 180.04, beating 157.5.
    const best = bestHistoricalOneRM([
      ...mixedHistory,
      historyRow({ actual_weight: '70', actual_reps: '5', event_date: '2026-06-15' }),
    ], KG);
    expect(best.get('Bench Press')?.weight).toBeCloseTo(70 * SPEC_LB_PER_KG, 5);
    expect(best.get('Bench Press')?.date).toBe('2026-06-15');
    // The same bare "70" under lb is 70 lb and loses.
    expect(bestHistoricalOneRM([
      ...mixedHistory,
      historyRow({ actual_weight: '70', actual_reps: '5', event_date: '2026-06-15' }),
    ], LB).get('Bench Press')?.weight).toBe(135);
  });

  it('omitting ctx is the same as passing DEFAULT_WEIGHT_CONTEXT', () => {
    expect(bestHistoricalOneRM(mixedHistory)).toEqual(bestHistoricalOneRM(mixedHistory, DEFAULT_WEIGHT_CONTEXT));
    expect(bestHistoricalOneRM(mixedHistory).get('Bench Press')?.weight).toBe(135);
    const kgOnly = [historyRow({ actual_weight: '60 kg', actual_reps: '5' })];
    expect(bestHistoricalOneRM(kgOnly).get('Bench Press')?.weight).toBeCloseTo(132.2772, 4);
  });

  it('bodyweight rows join the lineage when the context has a body weight', () => {
    const rows = [
      historyRow({ exercise_id: 'ub-4', exercise_name: 'Weighted Dips', actual_weight: 'BW+25', actual_reps: '8' }),
      historyRow({ exercise_id: 'ub-4', exercise_name: 'Weighted Dips', actual_weight: 'BW', actual_reps: '15', event_date: '2026-06-08' }),
    ];
    const best = bestHistoricalOneRM(rows, LB_BW).get('Weighted Dips');
    // 205 × 8 → 259.67 loses to 180 × 15 → 270: more reps at body weight wins.
    expect(best?.weight).toBe(180);
    expect(best?.reps).toBe(15);
    expect(best?.oneRM).toBeCloseTo(270, 5);
    expect(best?.date).toBe('2026-06-08');
    // Without a body weight neither row is a oneRM.
    expect(bestHistoricalOneRM(rows, LB).size).toBe(0);
    expect(bestHistoricalOneRM(rows).size).toBe(0);
  });
});

// ─── computeSessionPRs: PR detection across units ────────────────────────────

describe('computeSessionPRs — PRs across units', () => {
  it('reports a PR for 62 kg × 5 against the mixed history', () => {
    const prs = computeSessionPRs(groupsWith(bench, [{ weight: '62 kg', reps: '5' }]), mixedHistory, [], LB);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ kind: 'oneRM', exerciseName: 'Bench Press', reps: 5, previousDate: '2026-06-08' });
    const pr = prs[0];
    expect(pr.kind === 'oneRM' && pr.estimatedOneRM).toBeCloseTo(epley(62 * SPEC_LB_PER_KG, 5), 5);
    expect(pr.kind === 'oneRM' && pr.previousOneRM).toBeCloseTo(157.5, 5);
  });

  it('reports no PR for 61 kg × 5 against the mixed history', () => {
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '61 kg', reps: '5' }]), mixedHistory, [], LB)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '61kg', reps: '5' }]), mixedHistory, [], KG)).toHaveLength(0);
    // It is a near miss (156.90 vs 157.5), not an unparsed set: against 133 lb × 5 (155.17) it is a PR.
    const prs = computeSessionPRs(
      groupsWith(bench, [{ weight: '61 kg', reps: '5' }]),
      [historyRow({ actual_weight: '133 lb', actual_reps: '5' })],
      [],
      LB,
    );
    expect(prs).toHaveLength(1);
    expect(prs[0].kind === 'oneRM' && prs[0].estimatedOneRM).toBeCloseTo(epley(61 * SPEC_LB_PER_KG, 5), 5);
  });

  it('the record weight is the lb float classifySet produced', () => {
    const prs = computeSessionPRs(groupsWith(bench, [{ weight: '62 kg', reps: '5' }]), mixedHistory, [], LB);
    const pr = prs[0];
    expect(pr.kind === 'oneRM' && pr.weight).toBeCloseTo(62 * SPEC_LB_PER_KG, 5);
  });

  it('a bare number in the current session follows the context unit', () => {
    // 70 under kg = 154.32 lb → est 180.04, beats 157.5; 70 under lb loses.
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '70', reps: '5' }]), mixedHistory, [], KG)).toHaveLength(1);
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '70', reps: '5' }]), mixedHistory, [], LB)).toHaveLength(0);
    // 140 under lb beats 157.5 (163.33); under kg it is 308.6 lb and beats it too.
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '140', reps: '5' }]), mixedHistory, [], LB)).toHaveLength(1);
  });

  it('omitting ctx is the same as passing DEFAULT_WEIGHT_CONTEXT', () => {
    const groups = () => groupsWith(bench, [{ weight: '62 kg', reps: '5' }]);
    expect(computeSessionPRs(groups(), mixedHistory)).toEqual(computeSessionPRs(groups(), mixedHistory, [], DEFAULT_WEIGHT_CONTEXT));
    expect(computeSessionPRs(groups(), mixedHistory)).toHaveLength(1);
    expect(computeSessionPRs(groupsWith(bench, [{ weight: '61 kg', reps: '5' }]), mixedHistory)).toHaveLength(0);
  });

  it('a set re-entered with the same text never beats itself (R1.7)', () => {
    const sameText = (history: string, current: string, ctx: WeightContext = LB) =>
      computeSessionPRs(
        groupsWith(bench, [{ weight: current, reps: '5' }]),
        [historyRow({ actual_weight: history, actual_reps: '5' })],
        [],
        ctx,
      );
    expect(sameText('62.5 kg', '62.5 kg')).toHaveLength(0);
    expect(sameText('62.5kg', '62.5 kg')).toHaveLength(0);
    expect(sameText('62,5 kg', '62.5 kg')).toHaveLength(0);
    expect(sameText('62.5 KG', '62.5 kg')).toHaveLength(0);
    expect(sameText('62.5', '62.5 kg', KG)).toHaveLength(0);
    expect(sameText('62.5 kg', '62.5', KG)).toHaveLength(0);
    expect(sameText('137.78875', '62.5 kg')).toHaveLength(0);
    // The lineage exists — the no-PR result is a tie, not a missing history.
    expect(bestHistoricalOneRM([historyRow({ actual_weight: '62,5 kg', actual_reps: '5' })], LB).get('Bench Press')?.weight)
      .toBeCloseTo(137.78875, 5);
  });

  it('a bodyweight set earns a PR against bodyweight history, and the same text does not', () => {
    const history = [
      historyRow({ exercise_id: 'ub-4', exercise_name: 'Weighted Dips', actual_weight: 'BW+25', actual_reps: '8' }),
    ];
    const prs = computeSessionPRs(groupsWith(dips, [{ weight: 'BW+30', reps: '8' }]), history, [], LB_BW);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      kind: 'oneRM', exerciseName: 'Weighted Dips', weight: 210, reps: 8, previousDate: '2026-06-01',
    });
    expect(prs[0].kind === 'oneRM' && prs[0].previousOneRM).toBeCloseTo(epley(205, 8), 5);
    expect(computeSessionPRs(groupsWith(dips, [{ weight: 'BW+25', reps: '8' }]), history, [], LB_BW)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(dips, [{ weight: 'bw + 25 lbs', reps: '8' }]), history, [], LB_BW)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(dips, [{ weight: 'BW+20', reps: '8' }]), history, [], LB_BW)).toHaveLength(0);
  });

  it('a bodyweight set beats absolute history of the same exercise in lb', () => {
    // 205 lb × 8 → 259.67 beats 200 lb × 8 → 253.33.
    const history = [
      historyRow({ exercise_id: 'ub-4', exercise_name: 'Weighted Dips', actual_weight: '200', actual_reps: '8' }),
    ];
    const prs = computeSessionPRs(groupsWith(dips, [{ weight: 'BW+25', reps: '8' }]), history, [], LB_BW);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ kind: 'oneRM', weight: 205, reps: 8 });
    // 200 lb history beats BW+10 (190 × 8 → 240.67).
    expect(computeSessionPRs(groupsWith(dips, [{ weight: 'BW+10', reps: '8' }]), history, [], LB_BW)).toHaveLength(0);
  });

  it('a bodyweight set with no body weight in the context cannot earn a oneRM PR', () => {
    const history = [
      historyRow({ exercise_id: 'ub-4', exercise_name: 'Weighted Dips', actual_weight: '100', actual_reps: '8' }),
    ];
    // With a body weight the set wins outright; without one it is a rep-only
    // row, and rep-only rows never race oneRM history.
    expect(computeSessionPRs(groupsWith(dips, [{ weight: 'BW+25', reps: '8' }]), history, [], LB_BW)).toHaveLength(1);
    expect(computeSessionPRs(groupsWith(dips, [{ weight: 'BW+25', reps: '8' }]), history, [], LB)).toHaveLength(0);
    expect(computeSessionPRs(groupsWith(dips, [{ weight: 'BW+25', reps: '8' }]), history)).toHaveLength(0);
  });

  it('the best set of the session is the one compared, across units', () => {
    // 61 kg × 5 loses, 62 kg × 5 wins; one PR, from the 62 kg set.
    const prs = computeSessionPRs(
      groupsWith(bench, [{ weight: '61 kg', reps: '5' }, { weight: '62 kg', reps: '5' }, { weight: '130 lb', reps: '5' }]),
      mixedHistory,
      [],
      LB,
    );
    expect(prs).toHaveLength(1);
    expect(prs[0].kind === 'oneRM' && prs[0].estimatedOneRM).toBeCloseTo(epley(62 * SPEC_LB_PER_KG, 5), 5);
  });
});

// ─── A3: more unit spellings ──────────────────────────────────────────────────

describe('parseWeight — A3 unit spellings', () => {
  it('pound, pounds and # are lb', () => {
    expect(parseWeight('185#', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185 pounds', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185 pound', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185pounds', LB)).toEqual({ lb: 185, kind: 'absolute' });
    // A suffix wins over the context unit, as with lb/lbs.
    expect(parseWeight('185#', KG)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185 pounds', KG)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185 pound', KG)).toEqual({ lb: 185, kind: 'absolute' });
  });

  it('kilo, kilos, kilogram and kilograms are kg', () => {
    for (const text of ['80 kilo', '80 kilos', '80 kilogram', '80 kilograms', '80kilos', '80kilograms']) {
      const parsed = parseWeight(text, LB);
      expect(parsed, text).toMatchObject({ kind: 'absolute' });
      expect(parsed?.lb, text).toBeCloseTo(80 * SPEC_LB_PER_KG, 5); // 176.3696
    }
    expect(parseWeight('80 kilos', KG)?.lb).toBeCloseTo(176.3696, 5);
  });

  it('the new spellings are case-insensitive and take an optional trailing period', () => {
    expect(parseWeight('185 POUNDS', LB)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185 Pound.', KG)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185 pounds.', KG)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('185#.', KG)).toEqual({ lb: 185, kind: 'absolute' });
    expect(parseWeight('80 KILOS', LB)?.lb).toBeCloseTo(176.3696, 5);
    expect(parseWeight('80 Kilograms.', LB)?.lb).toBeCloseTo(176.3696, 5);
    expect(parseWeight('80 kilo.', LB)?.lb).toBeCloseTo(176.3696, 5);
    expect(parseWeight('  80 kilos.  ', LB)?.lb).toBeCloseTo(176.3696, 5);
  });

  it('the new spellings combine with decimals and the thousands comma', () => {
    expect(parseWeight('62,5 kilos', LB)?.lb).toBeCloseTo(137.78875, 5);
    expect(parseWeight('62.5 kilograms', LB)?.lb).toBeCloseTo(137.78875, 5);
    expect(parseWeight('1,200 pounds', KG)).toEqual({ lb: 1200, kind: 'absolute' });
    expect(parseWeight('135.5#', KG)).toEqual({ lb: 135.5, kind: 'absolute' });
  });

  it('AMBIGUOUS: a space before # is tolerated like the space before any other suffix', () => {
    // "100 kg" and "100kg" parse identically (R1.7); the amendment does not
    // single # out, so "185 #" is read the same as "185#".
    expect(parseWeight('185 #', KG)).toEqual({ lb: 185, kind: 'absolute' });
  });

  it('the new spellings work as the load suffix of a bodyweight form', () => {
    expect(parseWeight('BW+25 pounds', LB_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    expect(parseWeight('BW+25 pounds', KG_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    expect(parseWeight('BW+25#', KG_BW)).toEqual({ lb: 205, kind: 'bodyweight' });
    expect(parseWeight('bw - 10 POUND', KG_BW)).toEqual({ lb: 170, kind: 'bodyweight' });
    expect(parseWeight('BW+10 kilos', LB_BW)?.lb).toBeCloseTo(180 + 10 * SPEC_LB_PER_KG, 5); // 202.0462
    expect(parseWeight('BW+10 kilograms.', LB_BW)?.lb).toBeCloseTo(202.0462, 5);
    // R1.2 still applies: no body weight, no bodyweight form.
    expect(parseWeight('BW+25 pounds', LB)).toBeNull();
  });

  it('a new spelling earns oneRM in classifySet, in lb', () => {
    expect(classifySet('185#', '5', null, KG)).toEqual({
      kind: 'oneRM', weight: 185, reps: 5, oneRM: epley(185, 5), load: 'absolute',
    });
    const kilos = classifySet('80 kilos', '5', null, LB);
    expect(kilos).toMatchObject({ kind: 'oneRM', reps: 5, load: 'absolute' });
    expect(kilos?.kind === 'oneRM' && kilos.weight).toBeCloseTo(176.3696, 5);
    expect(classifySet('BW+25 pounds', '8', null, LB_BW)).toEqual({
      kind: 'oneRM', weight: 205, reps: 8, oneRM: epley(205, 8), load: 'bodyweight',
    });
  });

  it('every spelling of one load is one lineage: re-entering it never beats itself', () => {
    const prsFor = (history: string, current: string) =>
      computeSessionPRs(
        groupsWith(bench, [{ weight: current, reps: '5' }]),
        [historyRow({ actual_weight: history, actual_reps: '5' })],
        [],
        LB,
      );
    expect(prsFor('80 kg', '80 kilos')).toHaveLength(0);
    expect(prsFor('80 kilograms', '80kg')).toHaveLength(0);
    expect(prsFor('185 lbs', '185#')).toHaveLength(0);
    expect(prsFor('185 pounds', '185')).toHaveLength(0);
    // And the lineage exists: a heavier spelling-variant set is a PR, compared in lb.
    expect(prsFor('185 pounds', '190#')).toHaveLength(1);
    const kilos = prsFor('80 kilos', '81 kilograms');
    expect(kilos).toHaveLength(1);
    expect(kilos[0].kind === 'oneRM' && kilos[0].estimatedOneRM).toBeCloseTo(epley(81 * SPEC_LB_PER_KG, 5), 5);
    // 84 kilos = 185.19 lb beats 185 pounds; 83 kilos = 182.98 lb does not.
    expect(prsFor('185 pounds', '84 kilos')).toHaveLength(1);
    expect(prsFor('185 pounds', '83 kilos')).toHaveLength(0);
  });

  // These pass on an implementation that ignores A3 (they were null before
  // it) and fail on the stub by the thrown error. They guard against an A3
  // that widens the grammar past the listed spellings.
  const stillNull = [
    '135x5', '45/side', '25 each', '185 (paused)', '185lbs!', '185 lbz',
    '185 poundss', '185 kilogramss', '185 ##', '185 lb#', '185# lbs', '#185',
    '185 kilo grams', '185 pnds', '185 kgram', '185 p', '185 pounds!', '185 kilos x 5',
  ];
  it.each(stillNull)('still rejects %j', (text) => {
    expect(parseWeight(text, LB)).toBeNull();
    expect(parseWeight(text, KG_BW)).toBeNull();
  });

  it('still rejects malformed bodyweight forms with the new spellings', () => {
    expect(parseWeight('BW+25 poundz', LB_BW)).toBeNull();
    expect(parseWeight('BW+25 pounds each', LB_BW)).toBeNull();
    expect(parseWeight('BW pounds', LB_BW)).toBeNull();
    expect(parseWeight('BW#', LB_BW)).toBeNull();
  });
});

// ─── A4: describeRecord prints a converted weight to the whole pound ──────────

describe('describeRecord — A4 weight display', () => {
  /** The one PR a "<current> × 5" set earns over a "<prior> × 1" history on Sep 8. */
  const recordFor = (current: string, prior: string, ctx: WeightContext = LB) => {
    const prs = computeSessionPRs(
      groupsWith(bench, [{ weight: current, reps: '5' }]),
      [historyRow({ actual_weight: prior, actual_reps: '1', event_date: '2026-09-08' })],
      [],
      ctx,
    );
    expect(prs).toHaveLength(1);
    return prs[0];
  };

  it('a kg entry prints rounded to the whole pound', () => {
    // 62.5 kg = 137.78875 lb → "138"; est 1RM 160.75 → "161".
    expect(describeRecord(recordFor('62.5 kg', '150'))).toBe('est. 1RM 161 (138 × 5), up from 150 on Sep 8');
    // The same load as a bare number under a kg context.
    // The prior carries its unit: a bare "150" under kg would be 150 kg (R1.3).
    expect(describeRecord(recordFor('62.5', '150 lb', KG))).toBe('est. 1RM 161 (138 × 5), up from 150 on Sep 8');
  });

  it('the record keeps the float; only the printed weight is rounded', () => {
    const record = recordFor('62.5 kg', '150');
    expect(record.kind === 'oneRM' && record.weight).toBeCloseTo(137.78875, 5);
  });

  it('a bodyweight form whose lb has more than two decimals prints rounded', () => {
    // BW+2.5kg with 180 lb body weight = 185.51155 lb → "186"; est 216.43 → "216".
    expect(describeRecord(recordFor('BW+2.5kg', '200', LB_BW))).toBe('est. 1RM 216 (186 × 5), up from 200 on Sep 8');
  });

  it('an lb value typed with more than two decimals prints rounded too', () => {
    // The rule is on the lb value, not on how it was typed: 136.125 → "136".
    expect(describeRecord(recordFor('136.125', '150'))).toBe('est. 1RM 159 (136 × 5), up from 150 on Sep 8');
  });

  // The next case passes on today's code, which prints the parsed number
  // as-is; it pins A4's "exactly as an lb entry would have printed before",
  // and fails an implementation that rounds every weight or rounds to one place.
  it('REGRESSION: a weight with at most two decimals prints exactly as before', () => {
    expect(describeRecord(recordFor('136.25', '150'))).toBe('est. 1RM 159 (136.25 × 5), up from 150 on Sep 8');
    expect(describeRecord(recordFor('47.75', '40'))).toBe('est. 1RM 56 (47.75 × 5), up from 40 on Sep 8');
    expect(describeRecord(recordFor('102.25', '100'))).toBe('est. 1RM 119 (102.25 × 5), up from 100 on Sep 8');
    expect(describeRecord(recordFor('102.5', '100'))).toBe('est. 1RM 120 (102.5 × 5), up from 100 on Sep 8');
    expect(describeRecord(recordFor('185', '150'))).toBe('est. 1RM 216 (185 × 5), up from 150 on Sep 8');
  });

  it('AMBIGUOUS: describeRecordForPeople prints the weight by the same rule', () => {
    // A4 names describeRecord only; the people-facing line shows the same
    // "(weight × reps)" and is assumed to follow it.
    expect(describeRecordForPeople(recordFor('62.5 kg', '150')))
      .toBe('est. best single lift 161 (138 × 5), up from 150 on Sep 8');
    expect(describeRecordForPeople(recordFor('136.25', '150')))
      .toBe('est. best single lift 159 (136.25 × 5), up from 150 on Sep 8');
  });
});
