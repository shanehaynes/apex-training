import { describe, it, expect } from 'vitest';
import { parseISO, addDays, format } from 'date-fns';
import { expandRecurringEvents } from '../ScheduleContext';
import scheduleData from '../../data/schedule.json';
import type { WorkoutEvent, Schedule } from '../../types/workout';

function makeEvent(overrides: Partial<WorkoutEvent> & Pick<WorkoutEvent, 'id' | 'date'>): WorkoutEvent {
  return {
    type: 'stretching',
    title: 'Test Event',
    estimatedDuration: 20,
    description: '',
    exercises: [],
    difficulty: 2,
    tags: [],
    isCompleted: false,
    isRecurring: false,
    ...overrides,
  };
}

describe('expandRecurringEvents', () => {
  it('expands a WEEKLY rule with BYDAY', () => {
    const base = makeEvent({
      id: 'wk', date: '2026-09-07', // Monday
      isRecurring: true,
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260920',
    });
    const out = expandRecurringEvents([base], new Set());
    expect(out.map(e => e.date)).toEqual([
      '2026-09-07', // base event itself
      '2026-09-09', '2026-09-14', '2026-09-16',
    ]);
    expect(out[1].id).toBe('wk__2026-09-09');
  });

  it('excludes recurring_exceptions instances (per-series keys)', () => {
    const base = makeEvent({
      id: 'daily', date: '2026-09-01',
      isRecurring: true,
      recurrenceRule: 'FREQ=DAILY;UNTIL=20260904',
    });
    const out = expandRecurringEvents([base], new Set(['daily__2026-09-03']));
    expect(out.map(e => e.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-04']);
  });

  it('regression for Finding #5: an unrelated same-type one-off no longer suppresses the series', () => {
    const recurring = makeEvent({
      id: 'series', date: '2026-09-01',
      isRecurring: true,
      recurrenceRule: 'FREQ=DAILY;UNTIL=20260903',
    });
    const oneOff = makeEvent({ id: 'solo', date: '2026-09-02' }); // same type, same date as an occurrence
    const out = expandRecurringEvents([recurring, oneOff], new Set());
    const sept2 = out.filter(e => e.date === '2026-09-02');
    expect(sept2.map(e => e.id).sort()).toEqual(['series__2026-09-02', 'solo']);
  });

  it('an exception for one series does not affect another series on the same date', () => {
    const a = makeEvent({ id: 'a', date: '2026-09-01', isRecurring: true, recurrenceRule: 'FREQ=DAILY;UNTIL=20260903' });
    const b = makeEvent({ id: 'b', date: '2026-09-01', type: 'yoga', isRecurring: true, recurrenceRule: 'FREQ=DAILY;UNTIL=20260903' });
    const out = expandRecurringEvents([a, b], new Set(['a__2026-09-02']));
    expect(out.find(e => e.id === 'a__2026-09-02')).toBeUndefined();
    expect(out.find(e => e.id === 'b__2026-09-02')).toBeDefined();
  });

  it('skips events with an invalid rule instead of throwing', () => {
    const bad = makeEvent({ id: 'bad', date: '2026-09-01', isRecurring: true, recurrenceRule: 'FREQ=CUSTOM' });
    const out = expandRecurringEvents([bad], new Set());
    expect(out).toHaveLength(1); // just the base event, no expansion, no crash
  });

  it('matches the legacy daily-only algorithm for all DAILY rules in schedule.json', () => {
    // The pre-engine implementation, reproduced verbatim (minus the
    // type-keyed suppression, which has no effect on the cleaned seed data —
    // no non-recurring event shares a type+date with a recurring occurrence).
    function legacyExpand(rawEvents: WorkoutEvent[]): string[] {
      const out: string[] = [];
      for (const base of rawEvents) {
        if (!base.isRecurring || base.recurringPattern?.frequency !== 'daily') continue;
        const endDate = base.recurringPattern?.endDate;
        if (!endDate) continue;
        let cursor = addDays(parseISO(base.date), 1);
        const end = parseISO(endDate);
        while (cursor <= end) {
          out.push(`${base.id}__${format(cursor, 'yyyy-MM-dd')}`);
          cursor = addDays(cursor, 1);
        }
      }
      return out.sort();
    }

    const seed = (scheduleData as Schedule).events as WorkoutEvent[];
    // Seed events carry legacy recurringPattern; derive recurrenceRule the
    // same way the provider's fallback path does.
    const normalized = seed.map(e =>
      e.isRecurring && e.recurringPattern?.frequency === 'daily' && e.recurringPattern.endDate
        ? { ...e, recurrenceRule: `FREQ=DAILY;UNTIL=${e.recurringPattern.endDate.replace(/-/g, '')}` }
        : e,
    );

    const legacyIds = legacyExpand(seed);
    expect(legacyIds.length).toBeGreaterThan(300); // sanity: the daily series really expands

    // Only compare parity for events carrying the legacy recurringPattern shape —
    // events authored directly with a canonical recurrenceRule (e.g. WEEKLY series)
    // are out of scope for this legacy-algorithm comparison by definition.
    const legacyOnly = normalized.filter(e => e.recurringPattern?.frequency === 'daily');
    const engineIds = expandRecurringEvents(legacyOnly, new Set())
      .filter(e => e.id.includes('__'))
      .map(e => e.id)
      .sort();

    expect(engineIds).toEqual(legacyIds);
  });
});
