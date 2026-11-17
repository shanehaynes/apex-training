import { describe, it, expect } from 'vitest';
import { parseRestSeconds, restFor, restLine, restSummary } from '../rest';
import { parseDurationSeconds } from '../records';

// Ruling R2.5: `Ns`, `N sec`, `N min`, `M:SS`, and a range `A-B` / `A–B` with
// a shared unit (its lower end). Everything else is no timer — never a
// default, never a guess.

describe('parseRestSeconds — accepted grammar', () => {
  it.each([
    ['90s', 90],
    ['60s', 60],
    ['45 s', 45],
    ['90 sec', 90],
    ['90 secs', 90],
    ['90 seconds', 90],
    ['1 second', 1],
    ['2 min', 120],
    ['3min', 180],
    ['2 mins', 120],
    ['2 minutes', 120],
    ['1.5 min', 90],
    ['1:30', 90],
    ['0:45', 45],
    ['2:00', 120],
    ['10:00', 600],
  ])('%s → %i', (text, seconds) => {
    expect(parseRestSeconds(text)).toBe(seconds);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(parseRestSeconds('  2 MIN ')).toBe(120);
    expect(parseRestSeconds('90S')).toBe(90);
  });
});

describe('parseRestSeconds — ranges take the low end', () => {
  it.each([
    ['2-3 min', 120],
    ['2–3 min', 120],
    ['60-90s', 60],
    ['60 - 90 s', 60],
    ['60–90 sec', 60],
    ['1.5-2 min', 90],
    ['90-90s', 90],
  ])('%s → %i', (text, seconds) => {
    expect(parseRestSeconds(text)).toBe(seconds);
  });

  it('is exactly the case the loose duration parser gets wrong', () => {
    // records.ts reads "2-3 min" as a bare "2" — two seconds. The rest
    // parser must never be swapped for it.
    expect(parseDurationSeconds('2-3 min')).toBe(2);
    expect(parseRestSeconds('2-3 min')).toBe(120);
  });

  it('rejects a range whose unit is on the low end only, or missing', () => {
    expect(parseRestSeconds('2 min-3')).toBeNull();
    expect(parseRestSeconds('2-3')).toBeNull();
    expect(parseRestSeconds('2 min - 3 min')).toBeNull();
  });

  it('rejects a descending range', () => {
    expect(parseRestSeconds('90-60s')).toBeNull();
  });
});

describe('parseRestSeconds — rejects', () => {
  it.each([
    ['as needed'],
    ['0'],
    ['0s'],
    ['0 min'],
    ['0:00'],
    [''],
    ['   '],
    ['90'],
    ['2m'],
    ['2 m'],
    ['1 hr'],
    ['1h'],
    ['90 sec/side'],
    ['90s each'],
    ['rest 90s'],
    ['~90s'],
    ['1:60'],
    ['1:5'],
    ['-90s'],
    ['2 to 3 min'],
    ['2—3 min'],
    ['10s on 5s off'],
    ['minimal'],
    ['none'],
  ])('%j → null', text => {
    expect(parseRestSeconds(text)).toBeNull();
  });

  it('treats null and undefined as no prescription', () => {
    expect(parseRestSeconds(null)).toBeNull();
    expect(parseRestSeconds(undefined)).toBeNull();
  });
});

describe('restFor — a set\'s rest', () => {
  it('is the row\'s own rest, else the exercise\'s', () => {
    expect(restFor({ targetRest: '3 min' }, '90s')).toBe('3 min');
    expect(restFor({}, '90s')).toBe('90s');
    expect(restFor({ targetRest: '  ' }, '90s')).toBe('90s');
    expect(restFor(undefined, '90s')).toBe('90s');
    expect(restFor({}, undefined)).toBeUndefined();
  });
});

describe('restSummary — the card\'s rest line', () => {
  it('reads one value when every set rests the same', () => {
    expect(restSummary(['90s', '90s', '90s'])).toBe('90s');
  });

  it('reads runs in set order when sets differ', () => {
    expect(restSummary(['2 min', '2 min', '2 min', '90s'])).toBe('2 min ×3 · 90s');
    expect(restSummary(['60s', '90s', '60s'])).toBe('60s · 90s · 60s');
  });

  it('names a set with no rest, and is null when nothing rests', () => {
    expect(restSummary(['3 min', undefined])).toBe('3 min · none');
    expect(restSummary([undefined, ''])).toBeNull();
    expect(restSummary([])).toBeNull();
  });
});

describe('restLine — a tracked exercise', () => {
  const set = (targetRest?: string, isExtra = false) => ({ isExtra, planned: { targetRest } });

  it('summarizes the planned sets and leaves extras out', () => {
    expect(restLine({ exercise: { restPeriod: '90s' }, sets: [set(), set('3 min'), set(undefined, true)] })).toBe('90s · 3 min');
    expect(restLine({ exercise: { restPeriod: '90s' }, sets: [set(), set()] })).toBe('90s');
  });

  it('is the exercise\'s rest when nothing is planned per set (cardio)', () => {
    expect(restLine({ exercise: { restPeriod: '2 min' }, sets: [] })).toBe('2 min');
    expect(restLine({ exercise: {}, sets: [] })).toBeNull();
  });
});
