import { describe, it, expect, vi } from 'vitest';
import { findCoachTool, type CoachToolContext, type CoachToolDeps } from '../tools';
import { coachToolSchemas } from '../schemas';
import {
  describeSessionTimes,
  formatTimeRange,
  parseSessionTimesInput,
  resolveSessionTimes,
  type RecordedSessionTimes,
} from '../sessionTimes';
import type { WorkoutEvent } from '../../../types/workout';

// docs/specs/coach-session-times: the 2026-11-08 report — a stretch started
// Sep 1 at 9:14 PM EDT and left running until Sep 21 (1,695,855 s).

const RUNAWAY: RecordedSessionTimes = {
  eventId: 'ext-2026-09-01-stretch',
  title: 'Nightly Stretch — Lower',
  startedAt: '2026-09-02T01:14:00.000Z',
  finishedAt: '2026-09-21T15:18:15.000Z',
  totalDurationSeconds: 1_695_855,
};

const BASE = { event_id: 'ext-2026-09-01-stretch', date: '2026-09-01' };
const NY = 'America/New_York';

function deps(overrides: Partial<CoachToolDeps> = {}): CoachToolDeps {
  return {
    createEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent: vi.fn(), deleteEventInstance: vi.fn(),
    rescheduleEvent: vi.fn(), definitions: new Map(), createDefinition: vi.fn(), updateDefinition: vi.fn(),
    meals: [], createMeal: vi.fn(), updateMeal: vi.fn(), deleteMeal: vi.fn(),
    getSessionTimes: vi.fn(async () => RUNAWAY),
    editSessionTimes: vi.fn(async edit => ({
      ok: true as const,
      totalDurationSeconds: Math.round((Date.parse(edit.finishedAt) - Date.parse(edit.startedAt)) / 1000),
    })),
    ...overrides,
  };
}

const tool = findCoachTool('edit_session_times')!;

describe('parseSessionTimesInput (R2, R3)', () => {
  it('accepts a finish with Z or an offset, and a duration', () => {
    expect(parseSessionTimesInput({ ...BASE, finished_at: '2026-09-02T01:30:00Z' }).ok).toBe(true);
    expect(parseSessionTimesInput({ ...BASE, finished_at: '2026-09-01T21:30:00-04:00' }).ok).toBe(true);
    expect(parseSessionTimesInput({ ...BASE, finished_at: '2026-09-01T21:30-04:00' }).ok).toBe(true);
    expect(parseSessionTimesInput({ ...BASE, duration_minutes: 16 })).toMatchObject({ ok: true, value: { durationMinutes: 16 } });
  });

  it('refuses a timestamp with no zone and points at duration_minutes', () => {
    const r = parseSessionTimesInput({ ...BASE, finished_at: '2026-09-01T21:30:00' });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/UTC offset or Z.*duration_minutes/);
    expect(parseSessionTimesInput({ ...BASE, started_at: '9:14 PM', duration_minutes: 16 }).ok).toBe(false);
  });

  it('refuses both, and neither, of finished_at and duration_minutes', () => {
    expect(parseSessionTimesInput({ ...BASE, finished_at: '2026-09-02T01:30:00Z', duration_minutes: 16 }).ok).toBe(false);
    expect(parseSessionTimesInput({ ...BASE }).ok).toBe(false);
    expect(parseSessionTimesInput({ ...BASE, started_at: '2026-09-02T01:14:00Z' }).ok).toBe(false);
  });

  it('refuses a duration that is not a positive number', () => {
    for (const d of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '16']) {
      expect(parseSessionTimesInput({ ...BASE, duration_minutes: d }).ok, String(d)).toBe(false);
    }
  });

  it('refuses a finish before the start, and a missing id or date', () => {
    expect(parseSessionTimesInput({ ...BASE, started_at: '2026-09-02T01:30:00Z', finished_at: '2026-09-02T01:14:00Z' }).ok).toBe(false);
    expect(parseSessionTimesInput({ date: '2026-09-01', duration_minutes: 16 }).ok).toBe(false);
    expect(parseSessionTimesInput({ event_id: 'x', date: 'Sep 1', duration_minutes: 16 }).ok).toBe(false);
  });
});

describe('resolveSessionTimes (R2)', () => {
  const resolve = (input: Record<string, unknown>) => {
    const parsed = parseSessionTimesInput({ ...BASE, ...input });
    if (!parsed.ok) throw new Error(parsed.reason);
    return resolveSessionTimes(parsed.value, RUNAWAY);
  };

  it('keeps the recorded start for finished_at and for duration_minutes', () => {
    expect(resolve({ finished_at: '2026-09-01T21:30:00-04:00' })).toEqual({
      ok: true,
      value: { startedAt: new Date('2026-09-02T01:14:00Z'), finishedAt: new Date('2026-09-02T01:30:00Z'), totalDurationSeconds: 960 },
    });
    expect(resolve({ duration_minutes: 16 })).toEqual({
      ok: true,
      value: { startedAt: new Date('2026-09-02T01:14:00Z'), finishedAt: new Date('2026-09-02T01:30:00Z'), totalDurationSeconds: 960 },
    });
  });

  it('ends a duration from a given started_at', () => {
    expect(resolve({ started_at: '2026-09-02T01:20:00Z', duration_minutes: 10.5 })).toMatchObject({
      ok: true,
      value: { finishedAt: new Date('2026-09-02T01:30:30Z'), totalDurationSeconds: 630 },
    });
  });

  it('refuses a finish before the recorded start', () => {
    expect(resolve({ finished_at: '2026-09-02T01:00:00Z' }).ok).toBe(false);
  });
});

describe('the card label (R5)', () => {
  it('names the start, finish and duration in the given zone, zone named', () => {
    expect(describeSessionTimes({ ...BASE, started_at: '2026-09-02T01:14:00Z', finished_at: '2026-09-02T01:30:00Z' }, NY))
      .toBe('Sep 1, 9:14 PM EDT → 9:30 PM EDT · 16 min');
    expect(describeSessionTimes({ ...BASE, started_at: '2026-09-02T01:14:00Z', duration_minutes: 16 }, 'UTC'))
      .toBe('Sep 2, 1:14 AM UTC → 1:30 AM UTC · 16 min');
  });

  it('dates the finish when it falls on another day', () => {
    expect(formatTimeRange(Date.parse('2026-09-02T03:30:00Z'), Date.parse('2026-09-02T04:30:00Z'), NY))
      .toBe('Sep 1, 11:30 PM EDT → Sep 2, 12:30 AM EDT');
  });

  it('says the recorded start is kept when only a finish or a duration is given', () => {
    expect(describeSessionTimes({ ...BASE, duration_minutes: 16 }, NY)).toBe('recorded start kept · 16 min');
    expect(describeSessionTimes({ ...BASE, finished_at: '2026-09-02T01:30:00Z' }, NY))
      .toBe('recorded start kept, finish Sep 1, 9:30 PM EDT');
  });

  it('falls back to UTC, named, for a zone the runtime does not know', () => {
    expect(describeSessionTimes({ ...BASE, started_at: '2026-09-02T01:14:00Z', duration_minutes: 16 }, 'Mars/Olympus'))
      .toBe('Sep 2, 1:14 AM UTC → 1:30 AM UTC · 16 min');
  });

  it('labels a call the executor will refuse without throwing', () => {
    expect(describeSessionTimes({ ...BASE, finished_at: '9:30 PM' }, NY)).toBe('times the app will reject');
  });

  it('names the workout the id resolves to, an unresolved id as such, and the claimed title without context', () => {
    const event = { id: 'ext-2026-09-01-stretch', date: '2026-09-01', title: 'Nightly Stretch — Lower' } as WorkoutEvent;
    const ctx: CoachToolContext = { definitions: new Map(), events: [event], meals: [], timeZone: NY };
    const input = { ...BASE, duration_minutes: 16, event_title: 'Something else' };
    expect(tool.displayLabel(input, ctx)).toBe('Fix recorded times: Nightly Stretch — Lower · 2026-09-01 (recorded start kept · 16 min)');
    expect(tool.displayLabel({ ...input, event_id: 'nope' }, ctx)).toBe('Fix recorded times: (no matching entry for id "nope") (recorded start kept · 16 min)');
    expect(tool.displayLabel(input)).toBe('Fix recorded times: Something else · 2026-09-01 (recorded start kept · 16 min)');
  });
});

describe('edit_session_times executor (R1, R3, R4, R7, R8)', () => {
  it('keeps the recorded start, hands the resolved instants to editSessionTimes, and reports before and after', async () => {
    const d = deps();
    const result = await tool.execute({ ...BASE, duration_minutes: 16 }, d);
    expect(d.getSessionTimes).toHaveBeenCalledWith('ext-2026-09-01-stretch', '2026-09-01');
    expect(d.editSessionTimes).toHaveBeenCalledWith({
      eventId: 'ext-2026-09-01-stretch',
      date: '2026-09-01',
      startedAt: '2026-09-02T01:14:00.000Z',
      finishedAt: '2026-09-02T01:30:00.000Z',
      title: 'Nightly Stretch — Lower',
      before: RUNAWAY,
    });
    expect(result).toBe(
      'Changed the recorded times of "Nightly Stretch — Lower" (2026-09-01) [ext-2026-09-01-stretch]: started ' +
      '2026-09-02T01:14:00.000Z, finished 2026-09-02T01:30:00.000Z — 16 min (was 28,264 min). ' +
      'Totals and reviews now read the new duration.',
    );
  });

  it('edits the session row the deps found, so a base id reaches a recurring occurrence', async () => {
    const occurrence = { ...RUNAWAY, eventId: 'evt-stretch__2026-09-01' };
    const d = deps({ getSessionTimes: vi.fn(async () => occurrence) });
    await tool.execute({ event_id: 'evt-stretch', date: '2026-09-01', finished_at: '2026-09-02T01:30:00Z' }, d);
    expect(d.getSessionTimes).toHaveBeenCalledWith('evt-stretch', '2026-09-01');
    expect(d.editSessionTimes).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-stretch__2026-09-01' }));
  });

  it('changes nothing for input it refuses', async () => {
    const d = deps();
    expect(await tool.execute({ ...BASE, finished_at: '2026-09-01T21:30:00' }, d)).toMatch(/UTC offset or Z/);
    expect(d.getSessionTimes).not.toHaveBeenCalled();
    expect(d.editSessionTimes).not.toHaveBeenCalled();
  });

  it('says so when there is no tracked session, or no backend', async () => {
    const none = deps({ getSessionTimes: vi.fn(async () => null) });
    expect(await tool.execute({ ...BASE, duration_minutes: 16 }, none)).toMatch(/^No tracked session for "ext-2026-09-01-stretch" on 2026-09-01/);
    expect(none.editSessionTimes).not.toHaveBeenCalled();
    const bare = deps({ getSessionTimes: undefined, editSessionTimes: undefined });
    expect(await tool.execute({ ...BASE, duration_minutes: 16 }, bare)).toBe('Session times cannot be edited here; nothing was changed.');
  });

  it('passes the server\'s refusal through as the result', async () => {
    const d = deps({ editSessionTimes: vi.fn(async () => ({ ok: false as const, reason: 'Times can be edited once the workout is finished' })) });
    expect(await tool.execute({ ...BASE, duration_minutes: 16 }, d))
      .toBe('Could not change the times: Times can be edited once the workout is finished. Nothing was changed.');
  });
});

describe('update_event points at edit_session_times (R10)', () => {
  it('says it changes the plan and names the tool for the record', () => {
    const update = coachToolSchemas().find(s => s.name === 'update_event')!;
    expect(update.description).toContain('the PLAN');
    expect(update.description).toContain('edit_session_times');
  });
});
