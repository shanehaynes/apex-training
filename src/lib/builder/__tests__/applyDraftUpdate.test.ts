import { describe, it, expect } from 'vitest';
import { applyDraftUpdate, describeDraft, emptyDraft } from '../draft';
import type { ExerciseDefinition } from '../../../types/workout';

const DEFS = new Map<string, ExerciseDefinition>([
  ['pull-up', {
    id: 'pull-up', canonicalName: 'Pull-up', aliases: [], category: 'strength',
    muscleGroups: ['back'], equipment: [], isUnilateral: false, defaultSets: 3, defaultReps: '8',
  }],
  ['pistol-squat', {
    id: 'pistol-squat', canonicalName: 'Pistol Squat', aliases: [], category: 'strength',
    muscleGroups: ['legs'], equipment: [], isUnilateral: true,
  }],
]);

const base = () => emptyDraft('2026-08-28', 'Test');

describe('applyDraftUpdate', () => {
  it('applies scalar fields partially and reports what changed', () => {
    const result = applyDraftUpdate(base(), {
      title: 'CINDY', scoring_type: 'amrap', time_cap_minutes: 20, difficulty: 4,
    }, DEFS);
    if ('error' in result) throw new Error(result.error);
    expect(result.draft.title).toBe('CINDY');
    expect(result.draft.scoringType).toBe('amrap');
    expect(result.draft.timeCap).toBe('20');
    expect(result.draft.difficulty).toBe(4);
    expect(result.draft.date).toBe('2026-08-28');
    expect(result.summary).toContain('title');
    expect(result.summary).toContain('Apply');
  });

  it('replaces a section, matching library names and normalizing supersets', () => {
    const result = applyDraftUpdate(base(), {
      exercises: [
        { name: 'Pull-up', reps: '5', superset: 'X' },
        { name: 'Push-up', reps: '10', superset: 'X' },
      ],
    }, DEFS);
    if ('error' in result) throw new Error(result.error);
    const [pullUp, pushUp] = result.draft.lists.exercises;
    expect(pullUp.definitionId).toBe('pull-up');
    // Unknown name stays a snapshot-only entry — no library write.
    expect(pushUp.definitionId).toBeUndefined();
    expect(pushUp.name).toBe('Push-up');
    expect([pullUp.superset, pushUp.superset]).toEqual(['A', 'A']);
  });

  it('rejects unilateral counts without a per-side statement', () => {
    const result = applyDraftUpdate(base(), {
      exercises: [{ name: 'pistol squat', reps: '5' }],
    }, DEFS);
    expect('error' in result && result.error).toMatch(/per side/);
  });

  it('maps repeat on and off', () => {
    const on = applyDraftUpdate(base(), { repeat: { days: ['MO', 'FR'], interval_weeks: 2 } }, DEFS);
    if ('error' in on) throw new Error(on.error);
    expect(on.draft.repeat).toEqual({ enabled: true, days: ['MO', 'FR'], interval: '2', until: '' });

    const off = applyDraftUpdate(on.draft, { repeat: { off: true } }, DEFS);
    if ('error' in off) throw new Error(off.error);
    expect(off.draft.repeat.enabled).toBe(false);

    expect('error' in applyDraftUpdate(base(), { repeat: { days: [] } }, DEFS)).toBe(true);
  });

  it('ignores malformed values rather than corrupting the draft', () => {
    const result = applyDraftUpdate(base(), {
      date: 'tomorrow', difficulty: 9, duration_minutes: -10, title: 'ok',
    }, DEFS);
    if ('error' in result) throw new Error(result.error);
    expect(result.draft.date).toBe('2026-08-28');
    expect(result.draft.difficulty).toBe(3);
    expect(result.draft.duration).toBe('60');
  });

  it('errors on an empty update so the model restates', () => {
    expect('error' in applyDraftUpdate(base(), {}, DEFS)).toBe(true);
  });
});

describe('describeDraft', () => {
  it('serializes the form the coach needs to see', () => {
    const result = applyDraftUpdate(base(), {
      title: 'CINDY', scoring_type: 'amrap', time_cap_minutes: 20,
      exercises: [{ name: 'Pull-up', reps: '5', superset: 'A' }, { name: 'Push-up', reps: '10', superset: 'A' }],
      repeat: { days: ['MO'], interval_weeks: 1 },
    }, DEFS);
    if ('error' in result) throw new Error(result.error);
    const text = describeDraft(result.draft);
    expect(text).toContain('Title: CINDY');
    expect(text).toContain('amrap (cap 20 min)');
    expect(text).toContain('Pull-up');
    expect(text).toContain('[superset A]');
    expect(text).toContain('Repeat: MO every 1 week(s)');
  });
});
