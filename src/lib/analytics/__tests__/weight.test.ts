import { describe, it, expect } from 'vitest';
import { computeTile, type TileResult } from '../engine';
import { specProblem } from '../spec';
import { applyChartDraftUpdate, describeChartDraft, draftFromSpec, emptyChartDraft, specFromDraft } from '../draft';
import { makeCtx, makeInputs, makeSet, makeSpec } from './helpers';
import { LB_PER_KG } from '../../tracking/weight';

// Weight-kind series: computed in pounds from the profile's reading of each
// row, shown in the tile's pick or else the profile's unit.

function dataOf(result: TileResult) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.problem}`);
  return result.data;
}

const setLogs = [
  makeSet('2026-09-08', 'Bench Press', '100', '5'),     // bare: 100 kg under a kg profile
  makeSet('2026-09-08', 'Bench Press', '185 lb', '5'),  // suffix wins
  makeSet('2026-09-15', 'Dip', 'BW+25', '8'),           // body weight 180 lb + 25 kg under a kg profile
];
const kgProfile = { unit: 'kg' as const, bodyWeightLb: 180 };
const tonnageLb = 100 * LB_PER_KG * 5 + 185 * 5 + (180 + 25 * LB_PER_KG) * 8;

describe('computeTile — weight units', () => {
  it('reads rows through the profile context and shows weight series in the profile unit', () => {
    const data = dataOf(computeTile(makeSpec({ measure: 'tonnage' }), makeInputs({ setLogs, weight: kgProfile }), makeCtx()));
    expect(data.series[0].unit).toBe('kg');
    expect(data.series[0].points[0]).toBeCloseTo(tonnageLb / LB_PER_KG, 6);
    // Without a context the same rows read as pounds and BW stays unweighted.
    const lb = dataOf(computeTile(makeSpec({ measure: 'tonnage' }), makeInputs({ setLogs }), makeCtx()));
    expect(lb.series[0].unit).toBe('lb');
    expect(lb.series[0].points[0]).toBeCloseTo(100 * 5 + 185 * 5, 6);
  });

  it('lets the tile pick its own unit, converting the pound numbers at render', () => {
    const inLb = dataOf(computeTile(makeSpec({ measure: 'tonnage' }, { weightUnit: 'lb' }), makeInputs({ setLogs, weight: kgProfile }), makeCtx()));
    expect(inLb.series[0].unit).toBe('lb');
    expect(inLb.series[0].points[0]).toBeCloseTo(tonnageLb, 6);
    const oneRm = dataOf(computeTile(makeSpec({ measure: 'est-1rm', filters: { exerciseNames: ['bench press'] } }, { weightUnit: 'kg' }), makeInputs({ setLogs }), makeCtx()));
    expect(oneRm.series[0].unit).toBe('kg');
    expect(oneRm.series[0].points[0]).toBeCloseTo((185 * (1 + 5 / 30)) / LB_PER_KG, 6);
  });

  it('validates weightUnit like displayUnit', () => {
    expect(specProblem(makeSpec({ measure: 'tonnage' }, { weightUnit: 'kg' }))).toBeNull();
    expect(specProblem(makeSpec({ measure: 'tonnage' }, { weightUnit: 'st' as never }))).toContain('weightUnit must be one of lb, kg');
  });
});

describe('chart draft — weight unit', () => {
  it('round-trips through the spec and reads the coach tool field', () => {
    const draft = { ...emptyChartDraft(), title: 'Lifting', weightUnit: 'kg' as const };
    draft.series[0].measure = 'tonnage';
    const built = specFromDraft(draft);
    if ('error' in built) throw new Error(built.error);
    expect(built.spec.weightUnit).toBe('kg');
    expect(draftFromSpec(built.spec).weightUnit).toBe('kg');
    expect(describeChartDraft(draft)).toContain('Weight unit: kg');

    const updated = applyChartDraftUpdate(draft, { weight_unit: 'lb' });
    if ('error' in updated) throw new Error(updated.error);
    expect(updated.draft.weightUnit).toBe('lb');
    expect(updated.summary).toContain('weight unit');
    const cleared = applyChartDraftUpdate(draft, { weight_unit: null });
    if ('error' in cleared) throw new Error(cleared.error);
    expect(cleared.draft.weightUnit).toBe('');
    const spec = specFromDraft(cleared.draft);
    expect('spec' in spec && spec.spec.weightUnit).toBeUndefined();
    expect(applyChartDraftUpdate(draft, { weight_unit: 'stone' })).toEqual({ error: expect.stringContaining('weight_unit must be one of lb, kg') });
  });
});
