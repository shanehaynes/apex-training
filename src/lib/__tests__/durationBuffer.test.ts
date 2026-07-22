import { describe, expect, it } from 'vitest';
import { digitsToDisplay, digitsToSeconds, isPlain } from '../durationBuffer';
import { formatSeconds } from '../time';

describe('digitsToDisplay', () => {
  it('shows literal right-to-left groups', () => {
    expect(digitsToDisplay('')).toBe('');
    expect(digitsToDisplay('2')).toBe('0:02');
    expect(digitsToDisplay('23')).toBe('0:23');
    expect(digitsToDisplay('230')).toBe('2:30');
    expect(digitsToDisplay('2345')).toBe('23:45');
    expect(digitsToDisplay('12345')).toBe('1:23:45');
    expect(digitsToDisplay('123456')).toBe('12:34:56');
  });

  it('keeps overflow literal while typing', () => {
    expect(digitsToDisplay('90')).toBe('0:90');
    expect(digitsToDisplay('999')).toBe('9:99');
  });
});

describe('digitsToSeconds', () => {
  it('splits groups from the right', () => {
    expect(digitsToSeconds('2')).toBe(2);
    expect(digitsToSeconds('75')).toBe(75);
    expect(digitsToSeconds('90')).toBe(90);
    expect(digitsToSeconds('230')).toBe(150);
    expect(digitsToSeconds('2345')).toBe(1425);
    expect(digitsToSeconds('10500')).toBe(3900);
    expect(digitsToSeconds('123456')).toBe(45296);
  });

  it('rolls overflow up through formatSeconds on commit', () => {
    expect(formatSeconds(digitsToSeconds('90'))).toBe('1:30');
    expect(formatSeconds(digitsToSeconds('230'))).toBe('2:30');
    expect(formatSeconds(digitsToSeconds('2'))).toBe('2s');
    expect(formatSeconds(digitsToSeconds('10500'))).toBe('1:05:00');
  });
});

describe('isPlain', () => {
  it('accepts single duration tokens', () => {
    for (const v of ['', '2', '90s', '1:30', '2 min', '1:05:00', '1.5m']) {
      expect(isPlain(v), v).toBe(true);
    }
  });

  it('rejects interval-style free text', () => {
    for (const v of ['10s on 5s off', 'each side', 'to failure', '2x30s']) {
      expect(isPlain(v), v).toBe(false);
    }
  });
});
