import { describe, expect, it } from 'vitest';
import { getISODay, parseISO } from 'date-fns';
import {
  CycleSpecError,
  DEFAULT_CYCLE_SPEC,
  MAX_CYCLE_BLOCKS,
  cycleBlockCount,
  cycleTotalWeeks,
  generateCycle,
  overlapsExisting,
  scaleTargets,
} from '../cadence';
import { blockWeeks } from '../period';
import type { CycleSpec } from '../cadence';
import type { TrainingBlock, WeeklyTargets } from '../../../types/blocks';

// 2026-03-02 is a Monday.
const spec = (over: Partial<CycleSpec> = {}): CycleSpec => ({
  ...DEFAULT_CYCLE_SPEC,
  startDate: '2026-03-02',
  namePrefix: 'Spring',
  ...over,
});

describe('generateCycle', () => {
  it('alternates build and recovery for the 3-on/1-off default', () => {
    const blocks = generateCycle(spec());

    expect(blocks).toHaveLength(8);
    expect(blocks.map(b => b.phase)).toEqual([
      'build', 'recovery', 'build', 'recovery',
      'build', 'recovery', 'build', 'recovery',
    ]);
    expect(blocks.map(b => blockWeeks(b))).toEqual([3, 1, 3, 1, 3, 1, 3, 1]);
    expect(blocks[0].name).toBe('Spring · Build 1');
    expect(blocks[1].name).toBe('Spring · Recovery 1');
    expect(blocks[7].name).toBe('Spring · Recovery 4');
  });

  it('lays the blocks down contiguously from the start Monday', () => {
    const blocks = generateCycle(spec());

    expect(blocks[0].startDate).toBe('2026-03-02');
    expect(blocks[0].endDateExclusive).toBe('2026-03-23');   // +3 weeks
    expect(blocks[1].startDate).toBe('2026-03-23');
    expect(blocks[1].endDateExclusive).toBe('2026-03-30');   // +1 week
    expect(blocks[7].endDateExclusive).toBe('2026-06-22');   // +16 weeks total

    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].startDate).toBe(blocks[i - 1].endDateExclusive);
    }
  });

  it('puts every boundary on a Monday', () => {
    for (const block of generateCycle(spec({ weeksOn: 2, weeksOff: 1, cycles: 3 }))) {
      expect(getISODay(parseISO(block.startDate))).toBe(1);
      expect(getISODay(parseISO(block.endDateExclusive))).toBe(1);
    }
  });

  it('snaps a mid-week start back to its Monday', () => {
    // 2026-03-05 is the Thursday of the week beginning 2026-03-02.
    expect(generateCycle(spec({ startDate: '2026-03-05' }))[0].startDate).toBe('2026-03-02');
  });

  it('never overlaps itself', () => {
    const blocks = generateCycle(spec({ weeksOn: 4, weeksOff: 2, cycles: 3 }));
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = blocks[i], b = blocks[j];
        expect(a.startDate < b.endDateExclusive && b.startDate < a.endDateExclusive).toBe(false);
      }
    }
  });

  it('emits build blocks only when weeksOff is 0', () => {
    const blocks = generateCycle(spec({ weeksOff: 0, cycles: 3 }));

    expect(blocks).toHaveLength(3);
    expect(blocks.every(b => b.phase === 'build')).toBe(true);
    expect(blocks.map(b => b.name)).toEqual(['Spring · Build 1', 'Spring · Build 2', 'Spring · Build 3']);
  });

  it('carries intent and objective onto every block', () => {
    const blocks = generateCycle(spec({ intent: 'Aerobic base', objectiveId: 'obj-1', cycles: 2 }));
    expect(blocks.every(b => b.intent === 'Aerobic base' && b.objectiveId === 'obj-1')).toBe(true);
  });

  it('omits objectiveId when it is blank', () => {
    expect(generateCycle(spec({ objectiveId: '', cycles: 1 }))[0].objectiveId).toBeUndefined();
  });

  it('gives recovery blocks scaled targets and build blocks the full ones', () => {
    const weeklyTargets: WeeklyTargets = {
      cardioMinutes: 300,
      strengthSessions: 3,
      vert: { value: 5000, unit: 'ft' },
    };
    const [build, recovery] = generateCycle(spec({ weeklyTargets, cycles: 1 }));

    expect(build.weeklyTargets).toEqual(weeklyTargets);
    expect(recovery.weeklyTargets).toEqual({
      cardioMinutes: 150,
      strengthSessions: 2,           // 1.5 rounds to 2
      vert: { value: 2500, unit: 'ft' },
    });
  });

  it('rejects a spec that would run a block past the 52-week cap', () => {
    // validateBlock is the guard: a 53-week build block cannot be stored.
    expect(() => generateCycle(spec({ weeksOn: 53, weeksOff: 0, cycles: 1 }))).toThrow();
  });

  it('rejects malformed specs with a readable message', () => {
    expect(() => generateCycle(spec({ namePrefix: '  ' }))).toThrow(CycleSpecError);
    expect(() => generateCycle(spec({ weeksOn: 0 }))).toThrow(CycleSpecError);
    expect(() => generateCycle(spec({ weeksOn: 1.5 }))).toThrow(CycleSpecError);
    expect(() => generateCycle(spec({ weeksOff: -1 }))).toThrow(CycleSpecError);
    expect(() => generateCycle(spec({ cycles: 0 }))).toThrow(CycleSpecError);
  });

  it('refuses to emit more than the batch cap allows', () => {
    expect(() => generateCycle(spec({ cycles: MAX_CYCLE_BLOCKS / 2 + 1 }))).toThrow(CycleSpecError);
  });
});

describe('cycleTotalWeeks / cycleBlockCount', () => {
  it('matches what generateCycle produces', () => {
    const s = spec({ weeksOn: 3, weeksOff: 1, cycles: 4 });
    const blocks = generateCycle(s);

    expect(cycleTotalWeeks(s)).toBe(16);
    expect(cycleBlockCount(s)).toBe(blocks.length);
    expect(blocks.reduce((sum, b) => sum + blockWeeks(b), 0)).toBe(cycleTotalWeeks(s));
  });

  it('counts one block per cycle when there is no off week', () => {
    expect(cycleBlockCount({ weeksOff: 0, cycles: 5 })).toBe(5);
  });
});

describe('scaleTargets', () => {
  it('preserves units and rounds magnitudes', () => {
    expect(scaleTargets({ distance: { value: 25, unit: 'km' } }, 0.5))
      .toEqual({ distance: { value: 13, unit: 'km' } });
    expect(scaleTargets({ vert: { value: 3000, unit: 'm' } }, 0.4))
      .toEqual({ vert: { value: 1200, unit: 'm' } });
  });

  it('leaves longSessionMinutes alone — it is a threshold, not a volume', () => {
    expect(scaleTargets({ longSessionMinutes: 240 }, 0.5)).toEqual({ longSessionMinutes: 240 });
  });

  it('passes through an empty bag', () => {
    expect(scaleTargets({}, 0.5)).toEqual({});
  });

  it('never goes negative', () => {
    expect(scaleTargets({ cardioMinutes: 300 }, 0)).toEqual({ cardioMinutes: 0 });
  });

  it('rejects a nonsense factor', () => {
    expect(() => scaleTargets({ cardioMinutes: 300 }, -1)).toThrow(CycleSpecError);
    expect(() => scaleTargets({ cardioMinutes: 300 }, Number.NaN)).toThrow(CycleSpecError);
  });
});

describe('overlapsExisting', () => {
  const existing: TrainingBlock = {
    id: 'blk-1',
    name: 'Winter Base',
    intent: '',
    startDate: '2026-03-30',
    endDateExclusive: '2026-04-27',
    weeklyTargets: {},
  };

  it('names the first colliding block', () => {
    const hit = overlapsExisting(generateCycle(spec()), [existing]);
    expect(hit?.name).toBe('Winter Base');
  });

  it('returns null when the cycle lands clear of everything', () => {
    expect(overlapsExisting(generateCycle(spec({ cycles: 1, weeksOn: 3, weeksOff: 0 })), [existing])).toBeNull();
  });

  it('treats abutting ranges as clear — the ends are half-open', () => {
    const abutting = [{ startDate: '2026-03-02', endDateExclusive: '2026-03-30' }];
    expect(overlapsExisting(abutting, [existing])).toBeNull();
  });

  it('returns null against an empty calendar', () => {
    expect(overlapsExisting(generateCycle(spec()), [])).toBeNull();
  });
});
