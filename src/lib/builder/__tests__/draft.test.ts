import { describe, it, expect } from 'vitest';
import {
  createInputFromDraft, draftFromEvent, draftFromTemplate, draftProblem,
  emptyDraft, eventFieldsFromDraft, templateInputFromDraft, withType,
} from '../draft';
import type { WorkoutEvent, WorkoutTemplate } from '../../../types/workout';

const TEMPLATE: WorkoutTemplate = {
  id: 'wt-1',
  title: 'CINDY',
  type: 'weights',
  scoringType: 'amrap',
  timeCapMinutes: 20,
  estimatedDuration: 30,
  difficulty: 4,
  description: '5 pull-ups, 10 push-ups, 15 squats',
  warmup: [],
  exercises: [{ id: 'ex-1', name: 'Pull-up', category: 'strength', reps: '5' }],
  cooldown: [],
  tags: ['benchmark'],
  equipment: [],
};

describe('emptyDraft / withType', () => {
  it('starts as a strength weights draft on the given date', () => {
    const d = emptyDraft('2026-08-28', 'Leg Day');
    expect(d.type).toBe('weights');
    expect(d.scoringType).toBe('strength');
    expect(d.date).toBe('2026-08-28');
    expect(d.title).toBe('Leg Day');
    expect(d.duration).toBe('60');
  });

  it('withType follows default title and duration, preserves customized ones', () => {
    const fresh = withType(emptyDraft('2026-08-28'), 'cardio');
    expect(fresh.title).toBe('Cardio');
    expect(fresh.duration).toBe('45');

    const custom = withType(
      { ...emptyDraft('2026-08-28', 'Hill Repeats'), duration: '75' },
      'cardio',
    );
    expect(custom.title).toBe('Hill Repeats');
    expect(custom.duration).toBe('75');
  });
});

describe('draftProblem', () => {
  it('requires a title and a positive duration', () => {
    expect(draftProblem(emptyDraft('2026-08-28'))).toMatch(/title/);
    expect(draftProblem({ ...emptyDraft('2026-08-28', 'X'), duration: '0' })).toMatch(/Duration/);
    expect(draftProblem({ ...emptyDraft('2026-08-28', 'X'), duration: 'abc' })).toMatch(/Duration/);
  });

  it('requires a time cap only for AMRAP', () => {
    const base = emptyDraft('2026-08-28', 'X');
    expect(draftProblem({ ...base, scoringType: 'amrap' })).toMatch(/time cap/);
    expect(draftProblem({ ...base, scoringType: 'amrap', timeCap: '20' })).toBeNull();
    expect(draftProblem({ ...base, scoringType: 'for-time' })).toBeNull();
  });
});

describe('template round-trip', () => {
  it('draftFromTemplate → templateInputFromDraft preserves the template', () => {
    const draft = draftFromTemplate(TEMPLATE, '2026-08-28');
    expect(draft.templateId).toBe('wt-1');
    expect(draft.timeCap).toBe('20');
    const { id: _id, archivedAt: _a, updatedAt: _u, ...expected } = {
      ...TEMPLATE,
      warmup: undefined,
      cooldown: undefined,
      location: undefined,
      cardioTargets: undefined,
      climbingTargets: undefined,
    };
    expect(templateInputFromDraft(draft)).toEqual(expected);
  });

  it('drops the time cap when scoring moves away from AMRAP', () => {
    const draft = { ...draftFromTemplate(TEMPLATE, '2026-08-28'), scoringType: 'for-time' as const };
    expect(templateInputFromDraft(draft).timeCapMinutes).toBeUndefined();
    expect(createInputFromDraft(draft, 'wt-1').timeCapMinutes).toBeUndefined();
  });
});

describe('createInputFromDraft', () => {
  it('stamps the template linkage and scoring snapshot', () => {
    const input = createInputFromDraft(draftFromTemplate(TEMPLATE, '2026-08-28'), 'wt-1');
    expect(input.templateId).toBe('wt-1');
    expect(input.scoringType).toBe('amrap');
    expect(input.timeCapMinutes).toBe(20);
    expect(input.date).toBe('2026-08-28');
  });

  it('converts input times to display times and parses tags', () => {
    const draft = {
      ...emptyDraft('2026-08-28', 'Row Intervals'),
      startTime: '06:30',
      tags: ' erg,  zone 2 ,',
    };
    const input = createInputFromDraft(draft, 'wt-2');
    expect(input.startTime).toBe('6:30 AM');
    expect(input.tags).toEqual(['erg', 'zone 2']);
  });

  it('packs cardio targets only for cardio drafts with values', () => {
    const cardio = { ...withType(emptyDraft('2026-08-28', 'Run'), 'cardio'), distance: '5 mi' };
    expect(createInputFromDraft(cardio, 'wt-3').cardioTargets).toEqual({ distance: '5 mi' });
    expect(createInputFromDraft(withType(emptyDraft('2026-08-28', 'Run'), 'cardio'), 'wt-3').cardioTargets)
      .toBeUndefined();
  });
});

describe('draftFromEvent / eventFieldsFromDraft', () => {
  const EVENT: WorkoutEvent = {
    id: 'evt-1',
    type: 'weights',
    title: 'Upper',
    date: '2026-08-20',
    startTime: '7:00 AM',
    endTime: '8:00 AM',
    estimatedDuration: 60,
    description: 'push focus',
    exercises: [{ id: 'ex-1', name: 'Bench', category: 'strength', sets: 3, reps: '8' }],
    difficulty: 3,
    tags: ['push'],
    isCompleted: false,
    isRecurring: true,
    templateId: 'wt-9',
    scoringType: 'strength',
  };

  it('round-trips display times through the draft', () => {
    const draft = draftFromEvent(EVENT);
    expect(draft.startTime).toBe('07:00');
    const fields = eventFieldsFromDraft(draft, { includeSchedule: true });
    expect(fields.startTime).toBe('7:00 AM');
    expect(fields.date).toBe('2026-08-20');
  });

  it('omits schedule fields for series-wide edits', () => {
    const fields = eventFieldsFromDraft(draftFromEvent(EVENT), { includeSchedule: false });
    expect('date' in fields).toBe(false);
    expect('startTime' in fields).toBe(false);
    expect(fields.title).toBe('Upper');
  });

  it('never touches fields the builder does not edit', () => {
    const fields = eventFieldsFromDraft(draftFromEvent(EVENT), { includeSchedule: true });
    expect('subtitle' in fields).toBe(false);
    expect('recurrenceRule' in fields).toBe(false);
    expect('isRecurring' in fields).toBe(false);
    expect('templateId' in fields).toBe(false);
  });
});
