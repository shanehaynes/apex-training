import { describe, it, expect } from 'vitest';
import { computePhysiology, describePhysiology, type PhysiologyInputs, type SetLogInput } from '../index';
import { LB_PER_KG } from '../../tracking/weight';

// Tonnage reads weights through the profile's context and stays in pounds
// (the coach reads machine facts, R1.6).

const TODAY = '2026-09-25';
function set(over: Partial<SetLogInput> & { eventDate: string }): SetLogInput {
  return { actualWeight: null, actualReps: null, actualDuration: null, isAutofilled: false, ...over };
}
function inputs(over: Partial<PhysiologyInputs> = {}): PhysiologyInputs {
  return { today: TODAY, activities: [], cardioLogs: [], setLogs: [], thresholdHr: null, maxHr: null, ...over };
}

describe('tonnage with a WeightContext', () => {
  const setLogs = [
    set({ eventDate: '2026-09-22', actualWeight: '100', actualReps: '5' }),     // bare → the profile unit
    set({ eventDate: '2026-09-22', actualWeight: '62.5 kg', actualReps: '8' }), // suffix wins
    set({ eventDate: '2026-09-22', actualWeight: 'BW+25', actualReps: '10' }),  // needs a body weight; the 25 reads in the profile unit
  ];

  it('converts kg rows and bodyweight loads to pounds, and leaves the default reading alone', () => {
    const kg = computePhysiology(inputs({ setLogs, weight: { unit: 'kg', bodyWeightLb: 180 } }));
    expect(kg.tonnageByWeek?.at(-1)).toEqual({ weekStart: '2026-09-21', tonnageLb: Math.round(100 * LB_PER_KG * 5 + 62.5 * LB_PER_KG * 8 + (180 + 25 * LB_PER_KG) * 10) });
    expect(describePhysiology(kg)).toContain(`this week: ${(kg.tonnageByWeek!.at(-1)!.tonnageLb!).toLocaleString('en-US')} lb`);
    const lb = computePhysiology(inputs({ setLogs }));
    expect(lb.tonnageByWeek?.at(-1)).toEqual({ weekStart: '2026-09-21', tonnageLb: Math.round(100 * 5 + 62.5 * LB_PER_KG * 8) });
  });
});
