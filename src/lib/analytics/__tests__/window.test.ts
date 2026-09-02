import { describe, it, expect } from 'vitest';
import { inRange, resolveRange, unionWindow } from '../window';
import { makeSpec } from './helpers';

// 2026-09-07 is a Monday, the first day of ISO-2026 training month 10.
const TODAY = '2026-09-07';

describe('resolveRange', () => {
  it('rolling: a trailing window ending today, half-open', () => {
    expect(resolveRange({ kind: 'rolling', days: 7 }, TODAY, null)).toMatchObject({
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-08',
    });
  });

  it('fixed: passes through with a range label', () => {
    const r = resolveRange({ kind: 'fixed', startDate: '2026-01-01', endDateExclusive: '2026-02-01' }, TODAY, null);
    expect(r).toMatchObject({ startDate: '2026-01-01', endDateExclusive: '2026-02-01' });
    expect(r?.label).toContain('Jan');
  });

  it('iso-month presets: this month starts today (month 10), last month is month 9', () => {
    expect(resolveRange({ kind: 'preset', preset: 'this-iso-month' }, TODAY, null)).toMatchObject({
      startDate: '2026-09-07',
      endDateExclusive: '2026-10-05',
    });
    expect(resolveRange({ kind: 'preset', preset: 'last-iso-month' }, TODAY, null)).toMatchObject({
      startDate: '2026-08-10',
      endDateExclusive: '2026-09-07',
    });
  });

  it('iso-year presets: 2026 is a 53-week year, 2025 a 52-week one', () => {
    expect(resolveRange({ kind: 'preset', preset: 'this-iso-year' }, TODAY, null)).toMatchObject({
      startDate: '2025-12-29',
      endDateExclusive: '2027-01-04',
    });
    expect(resolveRange({ kind: 'preset', preset: 'last-iso-year' }, TODAY, null)).toMatchObject({
      startDate: '2024-12-30',
      endDateExclusive: '2025-12-29',
    });
  });

  it('current-block resolves the active block, or null without one', () => {
    const block = { startDate: '2026-08-24', endDateExclusive: '2026-10-19' };
    expect(resolveRange({ kind: 'preset', preset: 'current-block' }, TODAY, block)).toMatchObject(block);
    expect(resolveRange({ kind: 'preset', preset: 'current-block' }, TODAY, null)).toBeNull();
  });
});

describe('unionWindow', () => {
  it('unions tile ranges and pads by the widest day offset', () => {
    const a = makeSpec({ measure: 'distance' }, {
      range: { kind: 'fixed', startDate: '2026-06-01', endDateExclusive: '2026-07-01' },
    });
    const b = makeSpec(
      { measure: 'protein', filters: { dayFilter: { eventTypes: ['weights'], offsetDays: 2, mode: 'include' } } },
      { range: { kind: 'fixed', startDate: '2026-08-01', endDateExclusive: '2026-09-01' } },
    );
    expect(unionWindow([a, b], TODAY, null)).toEqual({
      startDate: '2026-05-30',
      endDateExclusive: '2026-09-03',
    });
  });

  it('is null when nothing resolves (only a blockless current-block tile)', () => {
    const spec = makeSpec({ measure: 'distance' }, { range: { kind: 'preset', preset: 'current-block' } });
    expect(unionWindow([spec], TODAY, null)).toBeNull();
  });
});

describe('inRange', () => {
  it('is half-open and lexicographic', () => {
    const period = { startDate: '2026-09-01', endDateExclusive: '2026-09-08' };
    expect(inRange('2026-09-01', period)).toBe(true);
    expect(inRange('2026-09-07', period)).toBe(true);
    expect(inRange('2026-09-08', period)).toBe(false);
    expect(inRange('2026-08-31', period)).toBe(false);
  });
});
