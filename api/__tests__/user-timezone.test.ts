import { describe, expect, it, vi } from 'vitest';
import {
  effectiveTimezone, fetchUserTimezones, isValidTimezone, localDate, localDayBounds, previousDay, userToday,
} from '../_lib/userTimezone';

type Admin = Parameters<typeof fetchUserTimezones>[0];

/** A profiles read that answers `.select().in()` with these rows, or this error. */
function profilesReturning(result: { data?: unknown; error?: { code?: string; message: string } | null }): Admin {
  return {
    from: () => ({ select: () => ({ in: async () => ({ data: result.data ?? null, error: result.error ?? null }) }) }),
  } as unknown as Admin;
}

describe('isValidTimezone / effectiveTimezone', () => {
  it('accepts IANA names and UTC, and nothing else', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    for (const bad of ['', 'Mars/Olympus_Mons', 'x'.repeat(65), null, undefined, 5]) {
      expect(isValidTimezone(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('computes in UTC when the zone is unknown', () => {
    expect(effectiveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(effectiveTimezone(null)).toBe('UTC');
    expect(effectiveTimezone('nope')).toBe('UTC');
  });
});

describe('localDate', () => {
  // 05:00 UTC — when the reflection cron runs.
  const run = new Date('2026-10-15T05:00:00Z');

  it('is the calendar date where the athlete is', () => {
    expect(localDate('UTC', run)).toBe('2026-10-15');
    expect(localDate('America/New_York', run)).toBe('2026-10-15'); // 01:00 EDT
    expect(localDate('America/Los_Angeles', run)).toBe('2026-10-14'); // 22:00 PDT
    expect(localDate('Pacific/Honolulu', run)).toBe('2026-10-14'); // 19:00 HST
    expect(localDate('Asia/Tokyo', run)).toBe('2026-10-15'); // 14:00 JST
    expect(localDate('Pacific/Kiritimati', new Date('2026-10-15T11:00:00Z'))).toBe('2026-10-16'); // UTC+14
  });

  it('falls back to the UTC date for an unknown zone', () => {
    expect(localDate('nope', run)).toBe('2026-10-15');
  });

  it('previousDay steps the calendar, across month and year ends', () => {
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });
});

describe('localDayBounds', () => {
  it('is the UTC day for UTC', () => {
    expect(localDayBounds('2026-10-14', 'UTC')).toEqual({
      start: '2026-10-14T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z',
    });
  });

  it('runs local midnight to local midnight', () => {
    expect(localDayBounds('2026-10-14', 'America/Los_Angeles')).toEqual({
      start: '2026-10-14T07:00:00.000Z', end: '2026-10-15T07:00:00.000Z',
    });
    expect(localDayBounds('2026-10-14', 'Asia/Tokyo')).toEqual({
      start: '2026-10-13T15:00:00.000Z', end: '2026-10-14T15:00:00.000Z',
    });
    expect(localDayBounds('2026-10-14', 'Asia/Kolkata')).toEqual({
      start: '2026-10-13T18:30:00.000Z', end: '2026-10-14T18:30:00.000Z',
    });
  });

  it('is 23 and 25 hours long on the DST change days', () => {
    const spring = localDayBounds('2026-03-08', 'America/New_York');
    expect(spring).toEqual({ start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' });
    const fall = localDayBounds('2026-11-01', 'America/New_York');
    expect(fall).toEqual({ start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z' });
  });
});

describe('fetchUserTimezones / userToday', () => {
  it('maps each athlete to a valid stored zone and leaves the rest out', async () => {
    const zones = await fetchUserTimezones(profilesReturning({
      data: [
        { id: 'a', timezone: 'Asia/Tokyo' },
        { id: 'b', timezone: null },
        { id: 'c', timezone: 'Mars/Olympus_Mons' },
      ],
    }), ['a', 'b', 'c']);
    expect([...zones]).toEqual([['a', 'Asia/Tokyo']]);
  });

  it('never throws: a missing column, a failed read and a thrown client all mean UTC', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { from: () => { throw new Error('boom'); } } as unknown as Admin;
    for (const db of [
      profilesReturning({ error: { code: '42703', message: 'column profiles.timezone does not exist' } }),
      profilesReturning({ error: { code: '500', message: 'down' } }),
      profilesReturning({ data: {} }),
      broken,
    ]) {
      expect((await fetchUserTimezones(db, ['a'])).size).toBe(0);
      expect(await userToday(db, 'a', new Date('2026-10-15T05:00:00Z'))).toBe('2026-10-15');
    }
    warn.mockRestore();
  });

  it("userToday is the athlete's local date", async () => {
    const db = profilesReturning({ data: [{ id: 'a', timezone: 'America/Los_Angeles' }] });
    expect(await userToday(db, 'a', new Date('2026-10-15T05:00:00Z'))).toBe('2026-10-14');
  });
});
