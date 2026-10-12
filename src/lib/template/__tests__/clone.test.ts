import { describe, it, expect } from 'vitest';
import { cloneEventRow, collectDefinitionIds, rebaseSeries } from '../clone';
import { expandRecurrence, parseRRule } from '../../recurrence';
import type { WorkoutEventRow } from '../../db/types';

function makeRow(overrides: Partial<WorkoutEventRow> = {}): WorkoutEventRow {
  return {
    id: 'evt-1',
    type: 'weights',
    title: 'Upper Body',
    subtitle: null,
    date: '2026-07-13',
    start_time: '06:00',
    end_time: '07:00',
    estimated_duration: 60,
    description: '',
    warmup: [],
    exercises: [],
    cooldown: [],
    difficulty: 3,
    location: null,
    cover_image_url: null,
    tags: [],
    equipment: [],
    is_recurring: true,
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
    recurring_frequency: null,
    recurring_days: null,
    recurring_end_date: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('collectDefinitionIds', () => {
  it('gathers ids across warmup, exercises, and cooldown, deduplicated', () => {
    const rows = [
      makeRow({
        warmup: [{ definitionId: 'cat-cow' }, { name: 'no def' }],
        exercises: [{ definitionId: 'pistol-squat' }, { definitionId: 'cat-cow' }],
        cooldown: [{ definitionId: 'pigeon-pose' }],
      }),
      makeRow({ id: 'evt-2', exercises: [{ definitionId: 'pistol-squat' }] }),
    ];
    expect(collectDefinitionIds(rows).sort()).toEqual(['cat-cow', 'pigeon-pose', 'pistol-squat']);
  });

  it('ignores missing, empty, and non-string definitionId values', () => {
    const rows = [
      makeRow({
        exercises: [{ definitionId: '' }, { definitionId: 42 }, { definitionId: null }, {}, null],
      }),
    ];
    expect(collectDefinitionIds(rows)).toEqual([]);
  });

  it('tolerates non-array section payloads', () => {
    const rows = [makeRow({ warmup: null as unknown as unknown[], exercises: undefined as unknown as unknown[] })];
    expect(collectDefinitionIds(rows)).toEqual([]);
  });
});

describe('cloneEventRow', () => {
  it('re-identifies the row and drops DB-owned timestamps', () => {
    const source = makeRow({ user_id: 'shane-uid' });
    const clone = cloneEventRow(source, 'tpl-abc', 'new-user', '2026-10-14')!;

    expect(clone.id).toBe('tpl-abc');
    expect(clone.user_id).toBe('new-user');
    expect('created_at' in clone).toBe(false);
    expect('updated_at' in clone).toBe(false);
    // Plan content survives untouched.
    expect(clone.title).toBe('Upper Body');
    expect(clone.start_time).toBe('06:00');
    expect(clone.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261110');
    expect(clone.date).toBe('2026-10-19');
    expect(clone.is_recurring).toBe(true);
  });

  it('does not mutate the source row', () => {
    const source = makeRow();
    cloneEventRow(source, 'tpl-x', 'u2', '2026-10-14');
    expect(source.id).toBe('evt-1');
    expect(source.created_at).toBe('2026-01-01T00:00:00Z');
    expect(source.date).toBe('2026-07-13');
  });

  it('skips a row with no rule the engine supports', () => {
    const source = makeRow({ recurrence_rule: null, recurring_frequency: 'custom' });
    expect(cloneEventRow(source, 'tpl-x', 'u2', '2026-10-14')).toBeNull();
  });
});

// Clone on Wed 2026-10-14: the block runs through Tue 2026-11-10.
describe('rebaseSeries', () => {
  const START = '2026-10-14';
  const END = '2026-11-10';

  it.each([
    ['MO', '2026-07-06', '2026-10-19'],
    ['TU', '2026-07-07', '2026-10-20'],
    ['TH', '2026-07-09', '2026-10-15'],
    ['FR', '2026-07-10', '2026-10-16'],
  ])('anchors a %s series on its first weekday in the block', (day, date, anchor) => {
    const rebased = rebaseSeries(makeRow({ date, recurrence_rule: `FREQ=WEEKLY;BYDAY=${day};UNTIL=20260927` }), START);
    expect(rebased).toEqual({
      date: anchor,
      recurrence_rule: `FREQ=WEEKLY;BYDAY=${day};UNTIL=20261110`,
      recurring_end_date: END,
    });
  });

  it('lands every weekday exactly 4 times, all inside the block', () => {
    const rebased = rebaseSeries(makeRow({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' }), START)!;
    const dates = [rebased.date, ...expandRecurrence(parseRRule(rebased.recurrence_rule), rebased.date, new Set())];
    expect(dates).toHaveLength(12);
    expect(dates.every(d => d >= START && d <= END)).toBe(true);
  });

  it('converts a legacy daily row and caps its far-off end date', () => {
    const rebased = rebaseSeries(makeRow({
      date: '2026-06-22',
      recurrence_rule: null,
      recurring_frequency: 'daily',
      recurring_end_date: '2027-05-31',
    }), START);
    expect(rebased).toEqual({ date: START, recurrence_rule: 'FREQ=DAILY;UNTIL=20261110', recurring_end_date: END });
  });

  it('drops COUNT in favor of the block end', () => {
    const rebased = rebaseSeries(makeRow({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=40' }), START);
    expect(rebased?.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261110');
  });

  it('keeps a weekly series without BYDAY on its source weekday', () => {
    // 2026-07-13 is a Monday.
    expect(rebaseSeries(makeRow({ recurrence_rule: 'FREQ=WEEKLY' }), START)?.date).toBe('2026-10-19');
  });

  it('returns null for a monthly day that never falls in the block', () => {
    expect(rebaseSeries(makeRow({ recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=12' }), START)).toBeNull();
  });

  it('returns null for an unparseable rule', () => {
    expect(rebaseSeries(makeRow({ recurrence_rule: 'FREQ=YEARLY' }), START)).toBeNull();
  });
});
