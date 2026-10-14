import { describe, it, expect } from 'vitest';
import { computePhysiology, type PhysiologyInputs, type SetLogInput } from '../index';

// Tonnage is working sets only: a warm-up set adds nothing (isPerformedSet),
// the same rule as the review's tonnage and the workout summary's volume.

const TODAY = '2026-09-25';
function set(over: Partial<SetLogInput>): SetLogInput {
  return { eventDate: '2026-09-22', actualWeight: null, actualReps: null, actualDuration: null, isAutofilled: false, ...over };
}
function inputs(setLogs: SetLogInput[]): PhysiologyInputs {
  return { today: TODAY, activities: [], cardioLogs: [], setLogs, thresholdHr: null, maxHr: null };
}

describe('tonnage — warm-up sets', () => {
  it('counts the working sets and not the warm-up', () => {
    const result = computePhysiology(inputs([
      set({ actualWeight: '95', actualReps: '5', isWarmup: true }),
      set({ actualWeight: '185', actualReps: '5' }),
      set({ actualWeight: '185', actualReps: '5', isWarmup: false }),
    ]));
    expect(result.tonnageByWeek?.at(-1)).toEqual({ weekStart: '2026-09-21', tonnageLb: 1850 });
  });

  it('a week of warm-ups only has no tonnage', () => {
    expect(computePhysiology(inputs([set({ actualWeight: '95', actualReps: '5', isWarmup: true })])).tonnageByWeek).toBeUndefined();
  });
});
