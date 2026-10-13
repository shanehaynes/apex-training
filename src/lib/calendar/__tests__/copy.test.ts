import { describe, it, expect } from 'vitest';
import {
  copyBody, eventsInWeek, isCopyable, mintCopyId, planWeekCopy, runCopies, weekCopySummary, weekStartIso,
} from '../copy';
import type { WorkoutEvent } from '../../../types/workout';

function makeEvent(overrides: Partial<WorkoutEvent> = {}): WorkoutEvent {
  return {
    id: 'w1-tue-weights',
    type: 'weights',
    sport: 'other',
    title: 'Upper Body',
    subtitle: 'Push focus',
    date: '2026-09-01',
    startTime: '6:00 AM',
    endTime: '7:00 AM',
    estimatedDuration: 60,
    description: 'Bench, press, rows',
    warmup: [{ id: 'wu1', name: 'Band pull-apart', category: 'mobility', sets: 2, reps: '15' }],
    exercises: [{ id: 'ex1', definitionId: 'bench-press', name: 'Bench Press', category: 'strength', sets: 4, reps: '6' }],
    cooldown: [],
    difficulty: 4,
    location: 'Garage',
    coverImageUrl: 'https://img.example/upper.jpg',
    cardioTargets: undefined,
    tags: ['push', 'strength'],
    equipment: ['barbell'],
    source: 'coros',
    templateId: 'wt-upper',
    scoringType: 'strength',
    isCompleted: true,
    completedAt: '2026-09-01T07:05:00Z',
    isRecurring: false,
    ...overrides,
  };
}

const ids = () => { let n = 0; return () => `copy-${++n}`; };

describe('copyBody', () => {
  it('copies the plan and drops identity, completion, recurrence and provenance', () => {
    const body = copyBody(makeEvent(), '2026-09-08', 'copy-1');
    expect(body).toEqual({
      id: 'copy-1',
      type: 'weights',
      sport: 'other',
      title: 'Upper Body',
      subtitle: 'Push focus',
      date: '2026-09-08',
      start_time: '6:00 AM',
      end_time: '7:00 AM',
      estimated_duration: 60,
      description: 'Bench, press, rows',
      warmup: [{ id: 'wu1', name: 'Band pull-apart', category: 'mobility', sets: 2, reps: '15' }],
      exercises: [{ id: 'ex1', definitionId: 'bench-press', name: 'Bench Press', category: 'strength', sets: 4, reps: '6' }],
      cooldown: [],
      difficulty: 4,
      location: 'Garage',
      cover_image_url: 'https://img.example/upper.jpg',
      tags: ['push', 'strength'],
      equipment: ['barbell'],
      is_recurring: false,
      recurrence_rule: null,
      recurring_frequency: null,
      recurring_days: null,
      recurring_end_date: null,
      template_id: 'wt-upper',
      scoring_type: 'strength',
      triggered_by: 'user',
    });
    // Nothing of the source's identity, completion or provenance leaks in.
    expect(body).not.toHaveProperty('source');
    expect(body).not.toHaveProperty('is_completed');
    expect(body).not.toHaveProperty('completed_at');
    expect(body).not.toHaveProperty('user_id');
  });

  it('a series occurrence duplicates as a one-off of the resolved occurrence', () => {
    const occurrence = makeEvent({
      id: 'w1-mon-morning__2026-09-07',
      date: '2026-09-07',
      isRecurring: true,
      recurrenceRule: 'FREQ=DAILY;UNTIL=20270531',
      recurringPattern: { frequency: 'daily', endDate: '2027-05-31' },
    });
    const body = copyBody(occurrence, '2026-09-20', 'copy-2');
    expect(body.id).toBe('copy-2');
    expect(body.date).toBe('2026-09-20');
    expect(body.is_recurring).toBe(false);
    expect(body.recurrence_rule).toBeNull();
    expect(body.recurring_frequency).toBeNull();
    expect(body.recurring_days).toBeNull();
    expect(body.recurring_end_date).toBeNull();
  });

  it('keeps cardio and climbing targets when the source has them', () => {
    const body = copyBody(makeEvent({ cardioTargets: { distance: '5 mi' } }), '2026-09-08', 'copy-3');
    expect(body.cardio_targets).toEqual({ distance: '5 mi' });
  });
});

describe('isCopyable', () => {
  it('is true for a one-off only', () => {
    expect(isCopyable(makeEvent())).toBe(true);
    expect(isCopyable(makeEvent({ isRecurring: true }))).toBe(false);
    expect(isCopyable(makeEvent({ id: 'series__2026-09-01' }))).toBe(false);
  });
});

describe('mintCopyId', () => {
  it('mints copy-<uuid>, fresh every call', () => {
    const a = mintCopyId();
    expect(a).toMatch(/^copy-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(mintCopyId()).not.toBe(a);
  });
});

describe('weeks', () => {
  it('weekStartIso is the Monday of the week, Sunday included', () => {
    expect(weekStartIso(new Date(2026, 8, 7))).toBe('2026-09-07');   // a Monday
    expect(weekStartIso(new Date(2026, 8, 13))).toBe('2026-09-07');  // its Sunday
    expect(weekStartIso(new Date(2026, 8, 14))).toBe('2026-09-14');
  });

  it('eventsInWeek is Monday through Sunday inclusive, by date string', () => {
    const events = ['2026-09-06', '2026-09-07', '2026-09-13', '2026-09-14']
      .map(date => makeEvent({ id: date, date }));
    expect(eventsInWeek(events, '2026-09-07').map(e => e.id)).toEqual(['2026-09-07', '2026-09-13']);
  });
});

describe('planWeekCopy', () => {
  it('copies last week\'s one-offs to the same weekday + 7, across a month boundary', () => {
    // Viewed: Mon 2026-10-05 – Sun 2026-10-11. Last week: Sep 28 – Oct 4.
    const events = [
      makeEvent({ id: 'mon', date: '2026-09-28', title: 'Mon' }),
      makeEvent({ id: 'wed', date: '2026-09-30', title: 'Wed' }),
      makeEvent({ id: 'sun', date: '2026-10-04', title: 'Sun' }),
      makeEvent({ id: 'too-early', date: '2026-09-27', title: 'Sun before' }),
      makeEvent({ id: 'this-week', date: '2026-10-05', title: 'Already here' }),
    ];
    const plan = planWeekCopy(events, new Date(2026, 9, 8), ids());
    expect(plan.weekStart).toBe('2026-10-05');
    expect(plan.sourceWeekStart).toBe('2026-09-28');
    expect(plan.skipped).toBe(0);
    expect(plan.copies.map(c => [c.source.id, c.body.id, c.body.date])).toEqual([
      ['mon', 'copy-1', '2026-10-05'],
      ['wed', 'copy-2', '2026-10-07'],
      ['sun', 'copy-3', '2026-10-11'],
    ]);
  });

  it('maps across a year boundary', () => {
    const plan = planWeekCopy([makeEvent({ date: '2026-12-30' })], new Date(2027, 0, 6), ids());
    expect(plan.copies.map(c => c.body.date)).toEqual(['2027-01-06']);
  });

  it('skips series bases, occurrences and overridden occurrences, and counts them', () => {
    const events = [
      makeEvent({ id: 'one-off', date: '2026-08-31' }),
      makeEvent({ id: 'series', date: '2026-08-31', isRecurring: true, recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' }),
      makeEvent({ id: 'series__2026-09-02', date: '2026-09-02', isRecurring: true, recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' }),
      // An occurrence rescheduled into last week keeps its original-date id.
      makeEvent({ id: 'series__2026-08-28', date: '2026-09-04', isRecurring: true, recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' }),
    ];
    const plan = planWeekCopy(events, new Date(2026, 8, 9), ids());
    expect(plan.copies.map(c => c.source.id)).toEqual(['one-off']);
    expect(plan.skipped).toBe(3);
  });

  it('an empty source week plans nothing', () => {
    expect(planWeekCopy([], new Date(2026, 8, 9), ids())).toEqual({
      weekStart: '2026-09-07', sourceWeekStart: '2026-08-31', copies: [], skipped: 0,
    });
  });
});

describe('runCopies', () => {
  const plan = (titles: string[]) =>
    titles.map((title, i) => ({ source: makeEvent({ id: `src-${i}`, title }), body: copyBody(makeEvent({ title }), '2026-09-08', `copy-${i}`) }));

  it('posts every body, one at a time, in order', async () => {
    const posted: string[] = [];
    let inFlight = 0;
    const result = await runCopies(plan(['A', 'B', 'C']), async body => {
      expect(inFlight, 'never two inserts in flight').toBe(0);
      inFlight += 1;
      await new Promise(r => setTimeout(r, 1));
      inFlight -= 1;
      posted.push(body.id);
    });
    expect(posted).toEqual(['copy-0', 'copy-1', 'copy-2']);
    expect(result).toEqual({ landed: ['A', 'B', 'C'], failed: [] });
  });

  it('stops at the first failure and names what landed and what did not', async () => {
    const posted: string[] = [];
    const result = await runCopies(plan(['A', 'B', 'C']), async body => {
      if (body.id === 'copy-1') throw new Error('500');
      posted.push(body.id);
    });
    expect(posted).toEqual(['copy-0']);
    expect(result).toEqual({ landed: ['A'], failed: ['B', 'C'] });
  });
});

describe('weekCopySummary', () => {
  it('reports the counts and that deleting a copy undoes it', () => {
    expect(weekCopySummary({ landed: ['A', 'B'], failed: [] }, 1))
      .toBe('Copied 2 workouts; skipped 1 repeating one — delete a copy to undo');
    expect(weekCopySummary({ landed: ['A'], failed: [] }, 0))
      .toBe('Copied 1 workout — delete a copy to undo');
    expect(weekCopySummary({ landed: ['A'], failed: [] }, 2))
      .toBe('Copied 1 workout; skipped 2 repeating ones — delete a copy to undo');
  });

  it('never reports an empty success', () => {
    expect(weekCopySummary({ landed: [], failed: [] }, 0)).toBe('Nothing to copy');
    expect(weekCopySummary({ landed: [], failed: [] }, 3)).toBe('Nothing to copy; skipped 3 repeating ones');
  });

  it('a partial failure says which titles landed and which did not', () => {
    expect(weekCopySummary({ landed: ['Run'], failed: ['Yoga', 'Lift'] }, 0))
      .toBe('Copied 1 of 3 (Run). Not copied: Yoga, Lift — try again');
    expect(weekCopySummary({ landed: [], failed: ['Yoga'] }, 0))
      .toBe('Copied 0 of 1. Not copied: Yoga — try again');
  });
});
