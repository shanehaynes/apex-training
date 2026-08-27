import { describe, it, expect } from 'vitest';
import { matchTemplateByTitle, mintTemplateId, rowToTemplate, templateToRow } from '../templates';
import type { WorkoutTemplateRow } from '../../db/types';
import type { WorkoutTemplate } from '../../../types/workout';

const TEMPLATE: WorkoutTemplate = {
  id: 'wt-abc',
  title: 'MURPH',
  type: 'weights',
  scoringType: 'for-time',
  timeCapMinutes: undefined,
  estimatedDuration: 55,
  difficulty: 5,
  description: '1 mile run, 100 pull-ups, 200 push-ups, 300 squats, 1 mile run',
  warmup: [],
  exercises: [
    { id: 'ex-1', name: 'Pull-up', category: 'strength', sets: 20, reps: '5' },
  ],
  cooldown: [],
  location: undefined,
  tags: ['hero', 'bodyweight'],
  equipment: ['pull-up bar'],
  cardioTargets: undefined,
  climbingTargets: undefined,
};

describe('template row mapping', () => {
  it('round-trips through templateToRow → rowToTemplate', () => {
    const row = {
      ...templateToRow(TEMPLATE),
      created_at: '2026-08-27T00:00:00Z',
      updated_at: '2026-08-27T00:00:00Z',
    } as WorkoutTemplateRow;
    const back = rowToTemplate(row);
    expect(back).toEqual({ ...TEMPLATE, updatedAt: '2026-08-27T00:00:00Z' });
  });

  it('nulls unset optionals on the row rather than dropping keys', () => {
    const row = templateToRow(TEMPLATE);
    // The upsert overwrites the whole row: an unset field must clear a
    // previously saved value, so it maps to an explicit NULL.
    expect(row.time_cap_minutes).toBeNull();
    expect(row.location).toBeNull();
    expect(row.archived_at).toBeNull();
  });

  it('defaults missing jsonb sections to empty arrays on read', () => {
    const row = {
      ...templateToRow(TEMPLATE),
      warmup: null,
      cooldown: null,
      created_at: 'x',
      updated_at: 'x',
    } as unknown as WorkoutTemplateRow;
    const back = rowToTemplate(row);
    expect(back.warmup).toEqual([]);
    expect(back.cooldown).toEqual([]);
  });
});

describe('mintTemplateId', () => {
  it('mints unique wt- ids', () => {
    const a = mintTemplateId();
    const b = mintTemplateId();
    expect(a).toMatch(/^wt-[0-9a-f-]{36}$/);
    expect(a).not.toEqual(b);
  });
});

describe('matchTemplateByTitle', () => {
  const templates = [TEMPLATE, { ...TEMPLATE, id: 'wt-cindy', title: 'Cindy  Classic' }];

  it('matches case-insensitively', () => {
    expect(matchTemplateByTitle(templates, 'murph')?.id).toBe('wt-abc');
    expect(matchTemplateByTitle(templates, 'MURPH')?.id).toBe('wt-abc');
  });

  it('normalizes surrounding and internal whitespace', () => {
    expect(matchTemplateByTitle(templates, '  cindy classic ')?.id).toBe('wt-cindy');
  });

  it('never fuzzy-matches', () => {
    expect(matchTemplateByTitle(templates, 'murp')).toBeUndefined();
    expect(matchTemplateByTitle(templates, 'murphy')).toBeUndefined();
  });

  it('ignores an empty query', () => {
    expect(matchTemplateByTitle(templates, '   ')).toBeUndefined();
  });
});
