import { describe, it, expect } from 'vitest';
import { parseRRule, serializeRRule, validateRRule, ruleFromLegacyColumns } from '../index';

describe('parseRRule', () => {
  it('parses a plain daily rule', () => {
    expect(parseRRule('FREQ=DAILY')).toEqual({ freq: 'DAILY', interval: 1 });
  });

  it('parses daily with UNTIL', () => {
    expect(parseRRule('FREQ=DAILY;UNTIL=20270531')).toEqual({
      freq: 'DAILY', interval: 1, until: '2027-05-31',
    });
  });

  it('parses weekly with INTERVAL and BYDAY', () => {
    expect(parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=8')).toEqual({
      freq: 'WEEKLY', interval: 2, byDay: ['TU', 'TH'], count: 8,
    });
  });

  it('parses monthly with BYMONTHDAY', () => {
    expect(parseRRule('FREQ=MONTHLY;BYMONTHDAY=1;COUNT=6')).toEqual({
      freq: 'MONTHLY', interval: 1, byMonthDay: [1], count: 6,
    });
  });

  it('accepts UNTIL with a floating time portion, truncating to the date', () => {
    expect(parseRRule('FREQ=DAILY;UNTIL=20261231T235959').until).toBe('2026-12-31');
  });

  it('rejects UNTIL with a Z suffix (floating time constraint)', () => {
    expect(() => parseRRule('FREQ=DAILY;UNTIL=20261231T235959Z')).toThrow(/UNTIL/);
  });

  it('rejects both COUNT and UNTIL present', () => {
    expect(() => parseRRule('FREQ=DAILY;COUNT=5;UNTIL=20261231')).toThrow(/mutually exclusive/);
  });

  it('rejects FREQ=YEARLY', () => {
    expect(() => parseRRule('FREQ=YEARLY')).toThrow(/YEARLY/);
  });

  it('rejects FREQ=CUSTOM', () => {
    expect(() => parseRRule('FREQ=CUSTOM')).toThrow(/CUSTOM/);
  });

  it('rejects unsupported parts like BYSETPOS', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYSETPOS=1')).toThrow(/BYSETPOS/);
  });

  it('rejects ordinal BYDAY tokens', () => {
    expect(() => parseRRule('FREQ=WEEKLY;BYDAY=2TU')).toThrow(/2TU/);
  });

  it('rejects BYDAY outside WEEKLY', () => {
    expect(() => parseRRule('FREQ=DAILY;BYDAY=MO')).toThrow(/BYDAY/);
    expect(() => parseRRule('FREQ=MONTHLY;BYDAY=MO')).toThrow(/BYDAY/);
  });

  it('rejects BYMONTHDAY outside MONTHLY', () => {
    expect(() => parseRRule('FREQ=WEEKLY;BYMONTHDAY=15')).toThrow(/BYMONTHDAY/);
  });

  it('rejects BYMONTHDAY out of range', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=32')).toThrow(/BYMONTHDAY/);
    expect(() => parseRRule('FREQ=MONTHLY;BYMONTHDAY=0')).toThrow(/BYMONTHDAY/);
  });

  it('rejects missing FREQ, empty strings, malformed parts, duplicates', () => {
    expect(() => parseRRule('COUNT=5')).toThrow(/FREQ/);
    expect(() => parseRRule('')).toThrow(/Empty/);
    expect(() => parseRRule('FREQ=DAILY;NONSENSE')).toThrow(/NONSENSE/);
    expect(() => parseRRule('FREQ=DAILY;FREQ=WEEKLY')).toThrow(/Duplicate/);
  });

  it('rejects impossible calendar dates in UNTIL', () => {
    expect(() => parseRRule('FREQ=DAILY;UNTIL=20260231')).toThrow(/calendar date/);
  });

  it('rejects non-positive INTERVAL and COUNT', () => {
    expect(() => parseRRule('FREQ=DAILY;INTERVAL=0')).toThrow(/INTERVAL/);
    expect(() => parseRRule('FREQ=DAILY;COUNT=0')).toThrow(/COUNT/);
    expect(() => parseRRule('FREQ=DAILY;INTERVAL=-2')).toThrow(/INTERVAL/);
  });
});

describe('serializeRRule round-trips', () => {
  const vectors = [
    'FREQ=DAILY',
    'FREQ=DAILY;COUNT=10',
    'FREQ=DAILY;UNTIL=20270531',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=8',
    'FREQ=MONTHLY;BYMONTHDAY=1;COUNT=6',
    'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15,31;UNTIL=20281231',
  ];

  for (const v of vectors) {
    it(`serializeRRule(parseRRule('${v}')) === '${v}'`, () => {
      expect(serializeRRule(parseRRule(v))).toBe(v);
    });
  }

  it('omits INTERVAL=1 in canonical form', () => {
    expect(serializeRRule(parseRRule('FREQ=DAILY;INTERVAL=1'))).toBe('FREQ=DAILY');
  });
});

describe('validateRRule (programmatic construction)', () => {
  it('rejects invalid combos built without the parser', () => {
    expect(() => validateRRule({ freq: 'DAILY', interval: 1, count: 3, until: '2026-12-31' }))
      .toThrow(/mutually exclusive/);
    expect(() => validateRRule({ freq: 'MONTHLY', interval: 1, byDay: ['MO'] }))
      .toThrow(/BYDAY/);
    // @ts-expect-error deliberately invalid freq
    expect(() => validateRRule({ freq: 'YEARLY', interval: 1 })).toThrow(/FREQ/);
  });
});

describe('ruleFromLegacyColumns', () => {
  it('maps legacy daily columns', () => {
    expect(ruleFromLegacyColumns('daily', null, '2027-05-31')).toBe('FREQ=DAILY;UNTIL=20270531');
    expect(ruleFromLegacyColumns('daily', null, null)).toBe('FREQ=DAILY');
  });

  it('maps legacy weekly columns with recurring_days (0=Sun…6=Sat)', () => {
    expect(ruleFromLegacyColumns('weekly', [1, 3, 5], '2026-12-31'))
      .toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231');
  });

  it('returns null for custom/unknown frequencies instead of mis-serializing', () => {
    expect(ruleFromLegacyColumns('custom', [1], null)).toBeNull();
    expect(ruleFromLegacyColumns(null, null, null)).toBeNull();
  });

  it('produces strings the parser accepts', () => {
    const s = ruleFromLegacyColumns('weekly', [0, 6], '2026-12-31')!;
    expect(serializeRRule(parseRRule(s))).toBe(s);
  });
});
