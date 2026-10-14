import { describe, expect, it } from 'vitest';
import { parseISO } from 'date-fns';
import { computeBlockProgress, type BlockProgressInputs } from '../progress';
import type { SetLogRow } from '../../db/types';
import { LB_PER_KG } from '../../tracking/weight';

// Block progress hands the athlete's weight context to the review stats, so
// a block's PRs and tonnage read a bare kg number the way the review does.

let n = 0;
function set(date: string, weight: string): SetLogRow {
  n += 1;
  return {
    event_id: `e-${date}`, event_date: date, section: 'exercise', exercise_id: 'bench', exercise_name: 'Bench Press',
    set_number: n, planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: weight, actual_reps: '5', actual_duration: null, is_autofilled: false,
  };
}

function run(over: Partial<BlockProgressInputs>) {
  return computeBlockProgress(
    {
      block: { id: 'blk-1', name: 'Strength', intent: '', startDate: '2026-03-02', endDateExclusive: '2026-04-27', weeklyTargets: {} },
      completions: [], sessions: [], cardioLogs: [], plannedEvents: [],
      setLogs: [set('2026-02-20', '200 lb'), set('2026-03-10', '100')], // before the block, then a bare 100 inside it
      period: { startDate: '', endDateExclusive: '', periodType: 'block', label: '', weeksInPeriod: 0 },
      ...over,
    },
    parseISO('2026-03-30'),
  );
}

describe('computeBlockProgress with a WeightContext', () => {
  it('reads a bare number in the profile unit for the block PRs and tonnage', () => {
    const kg = run({ weight: { unit: 'kg', bodyWeightLb: null } });
    expect(kg.prs).toMatchObject([{ kind: 'oneRM', exerciseName: 'Bench Press', weight: 100 * LB_PER_KG }]);
    expect(kg.toDate.stats.strength).toMatchObject({ tonnage: Math.round(100 * LB_PER_KG * 5), displayUnit: 'kg' });
    // Without a context the bare 100 is 100 lb: no PR over 200 lb.
    const lb = run({});
    expect(lb.prs).toEqual([]);
    expect(lb.toDate.stats.strength).toMatchObject({ tonnage: 500, displayUnit: 'lb' });
  });
});
