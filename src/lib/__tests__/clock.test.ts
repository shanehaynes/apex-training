import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isPastDay } from '../clock';

describe('isPastDay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T14:30:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is true for days before today', () => {
    expect(isPastDay('2026-07-15')).toBe(true);
    expect(isPastDay('2025-12-31')).toBe(true);
  });

  it('is false for today, even late in the day', () => {
    expect(isPastDay('2026-07-16')).toBe(false);
  });

  it('is false for future days', () => {
    expect(isPastDay('2026-07-17')).toBe(false);
  });
});
