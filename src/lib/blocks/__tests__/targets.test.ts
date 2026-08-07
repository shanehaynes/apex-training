import { describe, expect, it } from 'vitest';
import { parseWeeklyTargets, targetUnit, targetValue, TargetValidationError } from '../targets';
import { blockFieldsToRow, blockToRow, rowToBlock, rowToObjective } from '../mapping';
import { validateBlock, BlockValidationError } from '../validate';
import type { TrainingBlock } from '../../../types/blocks';
import type { ObjectiveRow, TrainingBlockRow } from '../../db/types';

describe('parseWeeklyTargets', () => {
  it('accepts scalars and unit-carrying quantities', () => {
    expect(
      parseWeeklyTargets({
        cardioMinutes: 420,
        strengthSessions: 2,
        vert: { value: 8000, unit: 'ft' },
        distance: { value: 20, unit: 'mi' },
      }),
    ).toEqual({
      cardioMinutes: 420,
      strengthSessions: 2,
      vert: { value: 8000, unit: 'ft' },
      distance: { value: 20, unit: 'mi' },
    });
  });

  it('treats null/undefined as unset rather than zero', () => {
    expect(parseWeeklyTargets({ cardioMinutes: null, vert: undefined })).toEqual({});
    expect(parseWeeklyTargets(null)).toEqual({});
  });

  // Silently dropping an unknown key would show the target as unmet forever.
  it('rejects unknown keys loudly', () => {
    expect(() => parseWeeklyTargets({ cardioMins: 300 })).toThrow(TargetValidationError);
    expect(() => parseWeeklyTargets({ cardioMins: 300 })).toThrow(/Unknown weekly target/);
  });

  it('rejects non-finite, non-numeric, and negative values', () => {
    expect(() => parseWeeklyTargets({ cardioMinutes: NaN })).toThrow(TargetValidationError);
    expect(() => parseWeeklyTargets({ cardioMinutes: Infinity })).toThrow(TargetValidationError);
    expect(() => parseWeeklyTargets({ cardioMinutes: '300' })).toThrow(TargetValidationError);
    expect(() => parseWeeklyTargets({ cardioMinutes: -1 })).toThrow(/must not be negative/);
  });

  it('rejects unrecognised and missing units', () => {
    expect(() => parseWeeklyTargets({ vert: { value: 100, unit: 'yards' } })).toThrow(/unit must be one of/);
    expect(() => parseWeeklyTargets({ vert: { value: 100 } })).toThrow(TargetValidationError);
    expect(() => parseWeeklyTargets({ distance: { value: 5, unit: 'ft' } })).toThrow(/unit must be one of/);
  });

  it('rejects extra fields inside a quantity', () => {
    expect(() => parseWeeklyTargets({ vert: { value: 100, unit: 'ft', note: 'x' } })).toThrow(/unknown field/);
  });

  it('rejects arrays and non-objects', () => {
    expect(() => parseWeeklyTargets([1, 2])).toThrow(TargetValidationError);
    expect(() => parseWeeklyTargets({ vert: [1] })).toThrow(TargetValidationError);
  });
});

describe('targetValue / targetUnit', () => {
  it('reads the numeric side of both scalar and quantity targets', () => {
    const targets = parseWeeklyTargets({ cardioMinutes: 300, vert: { value: 8000, unit: 'ft' } });
    expect(targetValue(targets, 'cardioMinutes')).toBe(300);
    expect(targetValue(targets, 'vert')).toBe(8000);
    expect(targetValue(targets, 'distance')).toBeUndefined();
    expect(targetUnit(targets, 'vert')).toBe('ft');
    expect(targetUnit(targets, 'cardioMinutes')).toBe('min');
  });
});

describe('validateBlock', () => {
  const base: Omit<TrainingBlock, 'id'> = {
    name: 'Base',
    intent: '',
    startDate: '2026-03-02',
    endDateExclusive: '2026-04-27',
    weeklyTargets: {},
  };

  it('accepts a Monday-aligned block', () => {
    expect(() => validateBlock(base)).not.toThrow();
  });

  it('requires both ends on a Monday', () => {
    expect(() => validateBlock({ ...base, startDate: '2026-03-03' })).toThrow(/must be a Monday/);
    expect(() => validateBlock({ ...base, endDateExclusive: '2026-04-26' })).toThrow(/must be a Monday/);
  });

  it('requires a name and a positive range', () => {
    expect(() => validateBlock({ ...base, name: '  ' })).toThrow(/needs a name/);
    expect(() => validateBlock({ ...base, endDateExclusive: '2026-03-02' })).toThrow(BlockValidationError);
    expect(() => validateBlock({ ...base, endDateExclusive: '2026-02-23' })).toThrow(/must end after it starts/);
  });

  it('caps block length at 52 weeks', () => {
    expect(() => validateBlock({ ...base, endDateExclusive: '2027-03-08' })).toThrow(/cannot be longer than 52 weeks/);
  });

  it('rejects malformed dates', () => {
    expect(() => validateBlock({ ...base, startDate: '03/02/2026' })).toThrow(/YYYY-MM-DD/);
  });

  it('validates the nested targets bag', () => {
    expect(() => validateBlock({ ...base, weeklyTargets: { cardioMinutes: -5 } as never })).toThrow();
  });
});

describe('row ↔ domain mapping', () => {
  const row: TrainingBlockRow = {
    id: 'blk-1',
    objective_id: 'obj-1',
    name: 'Fall Aerobic Foundation',
    intent: 'Build the base',
    phase: 'base',
    start_date: '2026-03-02',
    end_date_exclusive: '2026-04-27',
    weekly_targets: { cardioMinutes: 420, vert: { value: 8000, unit: 'ft' } },
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
  };

  it('round-trips', () => {
    const block = rowToBlock(row);
    expect(block).toEqual({
      id: 'blk-1',
      objectiveId: 'obj-1',
      name: 'Fall Aerobic Foundation',
      intent: 'Build the base',
      phase: 'base',
      startDate: '2026-03-02',
      endDateExclusive: '2026-04-27',
      weeklyTargets: { cardioMinutes: 420, vert: { value: 8000, unit: 'ft' } },
    });

    const { id: _id, ...rest } = block;
    expect(blockToRow(rest)).toEqual({
      objective_id: 'obj-1',
      name: 'Fall Aerobic Foundation',
      intent: 'Build the base',
      phase: 'base',
      start_date: '2026-03-02',
      end_date_exclusive: '2026-04-27',
      weekly_targets: { cardioMinutes: 420, vert: { value: 8000, unit: 'ft' } },
    });
  });

  it('maps nulls to undefined, not to empty strings', () => {
    const block = rowToBlock({ ...row, objective_id: null, phase: null });
    expect(block.objectiveId).toBeUndefined();
    expect(block.phase).toBeUndefined();
  });

  // A hand-edited JSONB blob must not take down the whole calendar.
  it('degrades a malformed targets bag to no targets', () => {
    expect(rowToBlock({ ...row, weekly_targets: { bogus: 1 } }).weeklyTargets).toEqual({});
  });

  it('emits only the fields present, for PATCH bodies', () => {
    expect(blockFieldsToRow({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(blockFieldsToRow({})).toEqual({});
    expect(blockFieldsToRow({ objectiveId: undefined })).toEqual({});
  });

  it('maps objective rows', () => {
    const objectiveRow: ObjectiveRow = {
      id: 'obj-1',
      name: 'Liberty Ridge',
      target_date: '2027-06-15',
      discipline: 'alpine',
      notes: '',
      required_capabilities: [],
      status: 'active',
      created_at: '2026-03-01T00:00:00Z',
      updated_at: '2026-03-01T00:00:00Z',
    };
    expect(rowToObjective(objectiveRow)).toEqual({
      id: 'obj-1',
      name: 'Liberty Ridge',
      targetDate: '2027-06-15',
      discipline: 'alpine',
      notes: '',
      status: 'active',
    });
  });
});
