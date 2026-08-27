import { describe, it, expect } from 'vitest';
import {
  REPEAT_OFF, repeatFromRule, repeatProblem, ruleFromRepeat, snapAnchorDate,
} from '../repeat';

describe('ruleFromRepeat', () => {
  it('serializes days in canonical order with interval and until', () => {
    expect(ruleFromRepeat({ enabled: true, days: ['FR', 'MO'], interval: '2', until: '2026-12-31' }))
      .toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231');
  });

  it('omits INTERVAL=1 and UNTIL when unset', () => {
    expect(ruleFromRepeat({ enabled: true, days: ['MO'], interval: '1', until: '' }))
      .toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('returns undefined when off or dayless, and the custom rule verbatim', () => {
    expect(ruleFromRepeat(REPEAT_OFF)).toBeUndefined();
    expect(ruleFromRepeat({ enabled: true, days: [], interval: '1', until: '' })).toBeUndefined();
    expect(ruleFromRepeat({ ...REPEAT_OFF, enabled: true, custom: 'FREQ=MONTHLY;BYMONTHDAY=1' }))
      .toBe('FREQ=MONTHLY;BYMONTHDAY=1');
  });
});

describe('repeatFromRule', () => {
  it('round-trips a weekly rule into the picker', () => {
    const repeat = repeatFromRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231');
    expect(repeat).toEqual({ enabled: true, days: ['MO', 'FR'], interval: '2', until: '2026-12-31' });
    expect(ruleFromRepeat(repeat)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231');
  });

  it('keeps inexpressible rules as custom, verbatim', () => {
    for (const rule of ['FREQ=DAILY', 'FREQ=MONTHLY;BYMONTHDAY=15', 'FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'FREQ=WEEKLY']) {
      const repeat = repeatFromRule(rule);
      expect(repeat.enabled).toBe(true);
      expect(repeat.custom).toBe(rule);
      expect(ruleFromRepeat(repeat)).toBe(rule);
    }
  });

  it('maps no rule to off', () => {
    expect(repeatFromRule(undefined)).toEqual(REPEAT_OFF);
  });
});

describe('snapAnchorDate', () => {
  // 2026-08-27 is a Thursday.
  it('keeps a date already on a selected weekday', () => {
    expect(snapAnchorDate('2026-08-27', ['TH'])).toBe('2026-08-27');
  });

  it('advances to the first selected weekday', () => {
    expect(snapAnchorDate('2026-08-27', ['MO', 'WE'])).toBe('2026-08-31');
    expect(snapAnchorDate('2026-08-27', ['FR'])).toBe('2026-08-28');
    expect(snapAnchorDate('2026-08-27', ['SU'])).toBe('2026-08-30');
  });

  it('is a no-op with no days selected', () => {
    expect(snapAnchorDate('2026-08-27', [])).toBe('2026-08-27');
  });
});

describe('repeatProblem', () => {
  it('requires days and a sane interval when enabled', () => {
    expect(repeatProblem({ enabled: true, days: [], interval: '1', until: '' }, '2026-08-27')).toMatch(/day/);
    expect(repeatProblem({ enabled: true, days: ['MO'], interval: '0', until: '' }, '2026-08-27')).toMatch(/interval/);
  });

  it('rejects an end date before the first (snapped) occurrence', () => {
    // Anchor snaps Thursday → Monday the 31st, past the until date.
    expect(repeatProblem({ enabled: true, days: ['MO'], interval: '1', until: '2026-08-29' }, '2026-08-27'))
      .toMatch(/end date/);
    expect(repeatProblem({ enabled: true, days: ['MO'], interval: '1', until: '2026-08-31' }, '2026-08-27'))
      .toBeNull();
  });

  it('stays quiet when off or custom', () => {
    expect(repeatProblem(REPEAT_OFF, '2026-08-27')).toBeNull();
    expect(repeatProblem({ ...REPEAT_OFF, enabled: true, custom: 'FREQ=DAILY' }, '2026-08-27')).toBeNull();
  });
});
