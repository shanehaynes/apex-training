import { describe, it, expect } from 'vitest';
import { cloneEventRow, collectDefinitionIds } from '../clone';
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
    const clone = cloneEventRow(source, 'tpl-abc', 'new-user');

    expect(clone.id).toBe('tpl-abc');
    expect(clone.user_id).toBe('new-user');
    expect('created_at' in clone).toBe(false);
    expect('updated_at' in clone).toBe(false);
    // Plan content survives untouched.
    expect(clone.title).toBe('Upper Body');
    expect(clone.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(clone.is_recurring).toBe(true);
  });

  it('does not mutate the source row', () => {
    const source = makeRow();
    cloneEventRow(source, 'tpl-x', 'u2');
    expect(source.id).toBe('evt-1');
    expect(source.created_at).toBe('2026-01-01T00:00:00Z');
  });
});
