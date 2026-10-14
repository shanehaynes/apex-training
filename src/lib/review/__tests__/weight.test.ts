import { describe, it, expect } from 'vitest';
import type { SetLogRow } from '../../db/types';
import { buildReviewPeriod, computePeriodPRs, computeReviewStats, computeStrengthStats, computeYearlyStats } from '../stats';
import { formatTonnage, formatWeight } from '../formats';
import { buildMonthlyRecap } from '../recap';
import { renderReviewEmail } from '../email';
import type { ReviewInputs } from '../types';
import { LB_PER_KG, type WeightContext } from '../../tracking/weight';

// Review numbers are pounds whatever the athlete types; the labels follow
// the unit the stats were computed under.

const MONTH = buildReviewPeriod('month', 2026, 6); // May 18 – Jun 14
const KG: WeightContext = { unit: 'kg', bodyWeightLb: 80 * LB_PER_KG };
const BW: WeightContext = { unit: 'lb', bodyWeightLb: 180 };

let n = 0;
function makeSet(date: string, name: string, weight: string | null, reps: string | null): SetLogRow {
  n += 1;
  return {
    event_id: `evt-${date}`, event_date: date, section: 'exercise', exercise_id: name.toLowerCase(), exercise_name: name,
    set_number: n, planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: weight, actual_reps: reps, actual_duration: null, is_autofilled: false,
  };
}

function inputs(setLogs: SetLogRow[], weight?: WeightContext): ReviewInputs {
  return { period: MONTH, completions: [], sessions: [], setLogs, cardioLogs: [], weight };
}

describe('computeStrengthStats with a WeightContext', () => {
  const logs = [
    makeSet('2026-05-20', 'Bench Press', '100', '5'),      // bare: kg under KG → 220.46 lb
    makeSet('2026-05-20', 'Bench Press', '185 lb', '5'),   // suffix wins
    makeSet('2026-05-21', 'Squat', '84 kg', '5'),          // suffix wins
    makeSet('2026-05-22', 'Dip', 'BW+25', '8'),            // body weight 80 kg + 25 kg, read in kg
  ];

  it('sums tonnage in pounds across mixed units and bodyweight loads', () => {
    const kg = computeStrengthStats(logs, MONTH, KG);
    const expected = 100 * LB_PER_KG * 5 + 185 * 5 + 84 * LB_PER_KG * 5 + (80 + 25) * LB_PER_KG * 8;
    expect(kg.tonnage).toBe(Math.round(expected));
    expect(kg.unit).toBe('kg');
    // Under the default context the same rows read as pounds: the bare 100 is
    // 100 lb and the BW row (no body weight) is reps-only.
    const lb = computeStrengthStats(logs, MONTH);
    expect(lb.tonnage).toBe(Math.round(100 * 5 + 185 * 5 + 84 * LB_PER_KG * 5));
    expect(lb.unit).toBe('lb');
    expect(lb.totalReps).toBe(5 + 5 + 5 + 8);
  });

  it('counts a bodyweight set in tonnage but never as the heaviest set (R1.1)', () => {
    const stats = computeStrengthStats([makeSet('2026-05-20', 'Dip', 'BW+50', '5'), makeSet('2026-05-20', 'Bench Press', '185', '5')], MONTH, BW);
    expect(stats.tonnage).toBe(230 * 5 + 185 * 5);
    expect(stats.heaviestSet).toMatchObject({ weight: 185, exerciseName: 'Bench Press' });
    const only = computeStrengthStats([makeSet('2026-05-20', 'Dip', 'BW+50', '5')], MONTH, BW);
    expect(only.tonnage).toBe(230 * 5);
    expect(only.heaviestSet).toBeNull();
  });

  it('threads the context from the inputs through the period and yearly rollups', () => {
    const period = inputs(logs, KG);
    const stats = computeReviewStats(period);
    expect(stats.strength.unit).toBe('kg');
    expect(stats.strength.tonnage).toBe(computeStrengthStats(logs, MONTH, KG).tonnage);
    const yearly = computeYearlyStats({ ...period, period: buildReviewPeriod('year', 2026) });
    expect(yearly.months.find(m => m.monthIndex === 6)?.tonnage).toBe(stats.strength.tonnage);
    // Period PRs read the same way: "100" bare is a kg lift that beats 200 lb.
    const prs = computePeriodPRs([makeSet('2026-04-01', 'Bench Press', '200 lb', '5'), makeSet('2026-05-20', 'Bench Press', '100', '5')], [], MONTH, KG);
    expect(prs).toMatchObject([{ kind: 'oneRM', weight: 100 * LB_PER_KG }]);
    expect(computePeriodPRs([makeSet('2026-04-01', 'Bench Press', '200 lb', '5'), makeSet('2026-05-20', 'Bench Press', '100', '5')], [], MONTH)).toHaveLength(0);
  });
});

describe('weight labels', () => {
  it('formatWeight converts pounds to the unit at display only', () => {
    expect(formatWeight(1250)).toBe('1,250 lb');
    expect(formatWeight(1250, 'lb')).toBe('1,250 lb');
    expect(formatWeight(1250, 'kg')).toBe('567 kg');
    expect(formatWeight(100 * LB_PER_KG, 'kg')).toBe('100 kg');
    // A stored tonnage is rounded to the pound; its kg reading is whole too.
    expect(formatTonnage(1102, 'kg')).toBe('500 kg');
    expect(formatTonnage(1102)).toBe('1,102 lb');
  });

  it('recap and email read the unit off the stats and keep the stored numbers in pounds', () => {
    const stats = computeReviewStats(inputs([makeSet('2026-05-20', 'Bench Press', '100', '5')], KG));
    expect(stats.strength.tonnage).toBe(Math.round(100 * LB_PER_KG * 5));
    const recap = buildMonthlyRecap(stats, 'Shane');
    expect(recap).toContain('Total weight moved: 500 kg (sum of weight × reps)');
    expect(recap).toContain('Heaviest set: 100 kg × 5 — Bench Press');
    const { html, text } = renderReviewEmail(stats, null, 'Shane');
    for (const body of [html, text]) {
      expect(body).toContain('500 kg');
      expect(body).not.toContain(' lb');
    }
    // Stats stored before the unit existed read as pounds.
    const legacy = { ...stats, strength: { ...stats.strength, unit: undefined } };
    expect(buildMonthlyRecap(legacy, 'Shane')).toContain('Total weight moved: 1,102 lb');
  });
});
