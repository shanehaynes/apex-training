import { describe, it, expect } from 'vitest';
import { parseRRule, expandRecurrence } from '../index';

const none = new Set<string>();

// Reminder on the contract: expandRecurrence returns only the dates generated
// AFTER dtstart — the base event is the first occurrence and counts toward
// COUNT, but is not included in the returned array.

describe('RFC 5545 reference vectors (adapted to date-only floating subset)', () => {
  it('FREQ=DAILY;COUNT=10 from 2026-09-02 → 10 consecutive occurrences total', () => {
    const out = expandRecurrence(parseRRule('FREQ=DAILY;COUNT=10'), '2026-09-02', none);
    expect(out).toEqual([
      '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07',
      '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
    ]);
  });

  it('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=8 from Tue 2026-09-01', () => {
    const out = expandRecurrence(parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=8'), '2026-09-01', none);
    expect(out).toEqual([
      '2026-09-03',               // Thu of dtstart's week
      '2026-09-15', '2026-09-17', // two weeks later
      '2026-09-29', '2026-10-01',
      '2026-10-13', '2026-10-15',
    ]);
  });

  it('FREQ=MONTHLY;BYMONTHDAY=1;COUNT=6 from 2026-09-01 → the 1st of 6 consecutive months', () => {
    const out = expandRecurrence(parseRRule('FREQ=MONTHLY;BYMONTHDAY=1;COUNT=6'), '2026-09-01', none);
    expect(out).toEqual(['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
  });
});

describe('WEEKLY details', () => {
  it('defaults to dtstart weekday when BYDAY is absent', () => {
    const out = expandRecurrence(parseRRule('FREQ=WEEKLY;COUNT=4'), '2026-09-07', none); // Monday
    expect(out).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
  });

  it('BYDAY not containing dtstart weekday: dtstart still counts as first occurrence', () => {
    // dtstart Wed 2026-09-02, pattern is Mondays only
    const out = expandRecurrence(parseRRule('FREQ=WEEKLY;BYDAY=MO;COUNT=3'), '2026-09-02', none);
    expect(out).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('UNTIL is inclusive', () => {
    const out = expandRecurrence(parseRRule('FREQ=WEEKLY;UNTIL=20260928'), '2026-09-07', none);
    expect(out).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
  });
});

describe('MONTHLY edge cases', () => {
  it('BYMONTHDAY=31 skips short months entirely (no clamping)', () => {
    const out = expandRecurrence(parseRRule('FREQ=MONTHLY;BYMONTHDAY=31;UNTIL=20261231'), '2026-01-31', none);
    expect(out).toEqual([
      '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31', '2026-12-31',
    ]);
    expect(out).not.toContain('2026-02-28'); // explicitly: no clamp
    expect(out).not.toContain('2026-04-30');
  });

  it('BYMONTHDAY=29 includes leap-year February', () => {
    const out = expandRecurrence(parseRRule('FREQ=MONTHLY;BYMONTHDAY=29;UNTIL=20280429'), '2027-12-29', none);
    expect(out).toEqual(['2028-01-29', '2028-02-29', '2028-03-29', '2028-04-29']);
  });

  it('BYMONTHDAY=29 skips non-leap February', () => {
    const out = expandRecurrence(parseRRule('FREQ=MONTHLY;BYMONTHDAY=29;UNTIL=20270429'), '2026-12-29', none);
    expect(out).toEqual(['2027-01-29', '2027-03-29', '2027-04-29']);
  });

  it('skipped months do not consume COUNT', () => {
    const out = expandRecurrence(parseRRule('FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3'), '2026-01-31', none);
    expect(out).toEqual(['2026-03-31', '2026-05-31']); // Feb & Apr skipped, still 3 real occurrences total
  });

  it('multiple BYMONTHDAY values emit in chronological order', () => {
    const out = expandRecurrence(parseRRule('FREQ=MONTHLY;BYMONTHDAY=15,1;COUNT=4'), '2026-09-01', none);
    expect(out).toEqual(['2026-09-15', '2026-10-01', '2026-10-15']);
  });
});

describe('DST-adjacent dates stay pure calendar arithmetic (floating-time constraint)', () => {
  it('daily expansion across US spring-forward (2026-03-08) has no skipped/duplicate date', () => {
    const out = expandRecurrence(parseRRule('FREQ=DAILY;COUNT=5'), '2026-03-06', none);
    expect(out).toEqual(['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  });

  it('daily expansion across US fall-back (2026-11-01) has no skipped/duplicate date', () => {
    const out = expandRecurrence(parseRRule('FREQ=DAILY;COUNT=5'), '2026-10-30', none);
    expect(out).toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  });

  it('daily expansion across the 2027 US transitions (Mar 14 / Nov 7)', () => {
    expect(expandRecurrence(parseRRule('FREQ=DAILY;COUNT=3'), '2027-03-13', none))
      .toEqual(['2027-03-14', '2027-03-15']);
    expect(expandRecurrence(parseRRule('FREQ=DAILY;COUNT=3'), '2027-11-06', none))
      .toEqual(['2027-11-07', '2027-11-08']);
  });
});

describe('EXDATE handling', () => {
  it('weekly rule across 4 weeks with 1 exdate omits exactly that date', () => {
    const out = expandRecurrence(
      parseRRule('FREQ=WEEKLY;COUNT=4'),
      '2026-09-07',
      new Set(['2026-09-21']),
    );
    expect(out).toEqual(['2026-09-14', '2026-09-28']);
    expect(out).not.toContain('2026-09-21');
  });

  it('exdates do not extend a COUNT-bounded series', () => {
    // COUNT=3 → dtstart + 2 generated; excluding one leaves 1, not 2
    const out = expandRecurrence(parseRRule('FREQ=DAILY;COUNT=3'), '2026-09-02', new Set(['2026-09-03']));
    expect(out).toEqual(['2026-09-04']);
  });
});

describe('bounding & termination', () => {
  it('rangeEnd caps an open-ended rule', () => {
    const out = expandRecurrence(parseRRule('FREQ=DAILY'), '2026-09-02', none, '2026-09-05');
    expect(out).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
  });

  it('rangeEnd also caps COUNT/UNTIL rules to the requested window', () => {
    expect(expandRecurrence(parseRRule('FREQ=DAILY;COUNT=100'), '2026-09-02', none, '2026-09-04'))
      .toEqual(['2026-09-03', '2026-09-04']);
    expect(expandRecurrence(parseRRule('FREQ=DAILY;UNTIL=20270101'), '2026-09-02', none, '2026-09-04'))
      .toEqual(['2026-09-03', '2026-09-04']);
  });

  it('throws on an open-ended rule with no rangeEnd instead of looping forever', () => {
    expect(() => expandRecurrence(parseRRule('FREQ=DAILY'), '2026-09-02', none)).toThrow(/rangeEnd/);
  });

  it('terminates on pathological COUNT rules that can never complete', () => {
    // Every April has 30 days: BYMONTHDAY=31 + INTERVAL=12 from April never occurs.
    const out = expandRecurrence(
      parseRRule('FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=31;COUNT=5'),
      '2026-04-01',
      none,
    );
    expect(out).toEqual([]);
  });

  it('rejects invalid dtstart', () => {
    expect(() => expandRecurrence(parseRRule('FREQ=DAILY;COUNT=2'), '2026-13-01', none)).toThrow(/dtstart/);
  });
});
