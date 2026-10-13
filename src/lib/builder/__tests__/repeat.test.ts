import { describe, it, expect } from 'vitest';
import {
  REPEAT_OFF, describeRepeat, repeatFromRule, repeatProblem, ruleFromRepeat, snapAnchorDate,
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
    // Monthly, weekly without days, daily with days, both ends at once: none
    // of these has a picker state.
    for (const rule of ['FREQ=MONTHLY;BYMONTHDAY=15', 'FREQ=WEEKLY', 'FREQ=WEEKLY;COUNT=3', 'FREQ=DAILY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=MO;COUNT=2;UNTIL=20261231']) {
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
    expect(repeatProblem({ ...REPEAT_OFF, enabled: true, custom: 'FREQ=MONTHLY' }, '2026-08-27')).toBeNull();
  });
});

describe('daily rules and count-based ends', () => {
  it('serializes a daily rule from the interval alone, days ignored', () => {
    expect(ruleFromRepeat({ enabled: true, freq: 'DAILY', days: [], interval: '2', until: '' }))
      .toBe('FREQ=DAILY;INTERVAL=2');
    expect(ruleFromRepeat({ enabled: true, freq: 'DAILY', days: ['MO'], interval: '1', until: '2026-12-31' }))
      .toBe('FREQ=DAILY;UNTIL=20261231');
  });

  it('serializes COUNT for weekly and daily rules', () => {
    expect(ruleFromRepeat({ enabled: true, days: ['MO', 'WE'], interval: '1', until: '', count: '4' }))
      .toBe('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4');
    expect(ruleFromRepeat({ enabled: true, freq: 'DAILY', days: [], interval: '2', until: '', count: '6' }))
      .toBe('FREQ=DAILY;INTERVAL=2;COUNT=6');
  });

  it('round-trips daily and counted rules through the picker state', () => {
    expect(repeatFromRule('FREQ=DAILY;INTERVAL=2'))
      .toEqual({ enabled: true, freq: 'DAILY', days: [], interval: '2', until: '' });
    expect(repeatFromRule('FREQ=DAILY;COUNT=6'))
      .toEqual({ enabled: true, freq: 'DAILY', days: [], interval: '1', until: '', count: '6' });
    expect(repeatFromRule('FREQ=WEEKLY;BYDAY=MO;COUNT=10'))
      .toEqual({ enabled: true, days: ['MO'], interval: '1', until: '', count: '10' });
    for (const rule of ['FREQ=DAILY;INTERVAL=2', 'FREQ=DAILY;COUNT=6', 'FREQ=DAILY;INTERVAL=3;UNTIL=20261231', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=12']) {
      const repeat = repeatFromRule(rule);
      expect(repeat.custom).toBeUndefined();
      expect(ruleFromRepeat(repeat)).toBe(rule);
    }
  });

  it('keeps a weekly, count-less rule in the shape older clients send', () => {
    expect(Object.keys(repeatFromRule('FREQ=WEEKLY;BYDAY=MO')).sort()).toEqual(['days', 'enabled', 'interval', 'until']);
  });

  it('never emits COUNT and UNTIL together: the date wins, the problem says so', () => {
    const both = { enabled: true, days: ['MO'] as const, interval: '1', until: '2026-12-31', count: '5' };
    expect(ruleFromRepeat({ ...both, days: [...both.days] })).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231');
    expect(repeatProblem({ ...both, days: [...both.days] }, '2026-08-27')).toMatch(/not both/);
  });

  it('drops a bad count from the rule and refuses it as a problem', () => {
    for (const count of ['0', '-1', 'x', '1.5']) {
      expect(ruleFromRepeat({ enabled: true, freq: 'DAILY', days: [], interval: '1', until: '', count }))
        .toBe('FREQ=DAILY');
      expect(repeatProblem({ enabled: true, freq: 'DAILY', days: [], interval: '1', until: '', count }, '2026-08-27'))
        .toMatch(/count/);
    }
    expect(repeatProblem({ enabled: true, freq: 'DAILY', days: [], interval: '1', until: '', count: '' }, '2026-08-27'))
      .toBeNull();
  });

  it('bounds the interval the same way for daily rules', () => {
    expect(ruleFromRepeat({ enabled: true, freq: 'DAILY', days: [], interval: '0', until: '' })).toBe('FREQ=DAILY');
    expect(ruleFromRepeat({ enabled: true, freq: 'DAILY', days: [], interval: '', until: '' })).toBe('FREQ=DAILY');
    expect(repeatProblem({ enabled: true, freq: 'DAILY', days: [], interval: '0', until: '' }, '2026-08-27')).toMatch(/interval/);
    expect(repeatProblem({ enabled: true, freq: 'DAILY', days: [], interval: '', until: '' }, '2026-08-27')).toMatch(/interval/);
  });

  it('needs no days for a daily rule, and checks its end date against the anchor itself', () => {
    expect(repeatProblem({ enabled: true, freq: 'DAILY', days: [], interval: '1', until: '' }, '2026-08-27')).toBeNull();
    expect(repeatProblem({ enabled: true, freq: 'DAILY', days: [], interval: '1', until: '2026-08-26' }, '2026-08-27')).toMatch(/end date/);
    expect(repeatProblem({ enabled: true, freq: 'DAILY', days: [], interval: '1', until: '2026-08-27' }, '2026-08-27')).toBeNull();
  });

  it('describes every shape in one line', () => {
    expect(describeRepeat({ enabled: true, days: ['MO', 'WE'], interval: '2', until: '2026-12-31' })).toBe('MO,WE every 2 week(s) until 2026-12-31');
    expect(describeRepeat({ enabled: true, freq: 'DAILY', days: [], interval: '2', until: '', count: '6' })).toBe('every 2 day(s), 6 times');
    expect(describeRepeat({ ...REPEAT_OFF, enabled: true, custom: 'FREQ=MONTHLY' })).toBe('FREQ=MONTHLY');
  });
});
