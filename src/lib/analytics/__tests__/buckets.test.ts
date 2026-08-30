import { describe, it, expect } from 'vitest';
import { bucketOf, bucketsFor } from '../buckets';

describe('bucketsFor', () => {
  it('day: one bucket per date in the half-open window', () => {
    const buckets = bucketsFor({ startDate: '2026-09-01', endDateExclusive: '2026-09-11' }, 'day');
    expect(buckets).toHaveLength(10);
    expect(buckets![0]).toEqual({ key: '2026-09-01', label: 'Sep 1' });
    expect(buckets![9].key).toBe('2026-09-10');
  });

  it('week: ISO Mondays, including the partial week containing the start', () => {
    // 2026-09-09 is a Wednesday; its ISO week starts Monday 2026-09-07.
    const buckets = bucketsFor({ startDate: '2026-09-09', endDateExclusive: '2026-10-05' }, 'week');
    expect(buckets!.map(b => b.key)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  });

  it('iso-month: walks 4-week training months across the 5-week month 13 and the year boundary', () => {
    const buckets = bucketsFor({ startDate: '2026-11-01', endDateExclusive: '2027-02-01' }, 'iso-month');
    expect(buckets!.map(b => b.key)).toEqual(['2026-M11', '2026-M12', '2026-M13', '2027-M01']);
  });

  it('total: a single bucket', () => {
    expect(bucketsFor({ startDate: '2026-01-01', endDateExclusive: '2027-01-01' }, 'total')).toHaveLength(1);
  });

  it('refuses absurd resolutions instead of rendering them', () => {
    expect(bucketsFor({ startDate: '2020-01-01', endDateExclusive: '2026-01-01' }, 'day')).toBeNull();
  });
});

describe('bucketOf', () => {
  it('maps a date into its day, week, iso-month, and total buckets', () => {
    expect(bucketOf('2026-09-09', 'day')).toBe('2026-09-09');
    expect(bucketOf('2026-09-09', 'week')).toBe('2026-09-07');
    expect(bucketOf('2026-09-09', 'iso-month')).toBe('2026-M10');
    expect(bucketOf('2026-12-31', 'iso-month')).toBe('2026-M13');
    expect(bucketOf('2026-09-09', 'total')).toBe('total');
  });
});
