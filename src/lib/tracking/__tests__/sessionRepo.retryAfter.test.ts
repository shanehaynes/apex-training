import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseRetryAfterMs } from '../sessionRepo';
import { DEFAULT_MAX_RETRY_MS } from '../saveQueue';

// The 429's Retry-After as the save queue receives it: seconds or an HTTP
// date, never negative, never past the queue's clamp.

describe('parseRetryAfterMs', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reads seconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('reads an HTTP date relative to now', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    expect(parseRetryAfterMs('Tue, 13 Oct 2026 12:00:30 GMT')).toBe(30_000);
    expect(parseRetryAfterMs('Tue, 13 Oct 2026 11:59:30 GMT')).toBe(0);
  });

  it('caps at the queue clamp and ignores garbage', () => {
    expect(parseRetryAfterMs('3600')).toBe(DEFAULT_MAX_RETRY_MS);
    expect(parseRetryAfterMs(String(2 ** 31))).toBe(DEFAULT_MAX_RETRY_MS);
    expect(parseRetryAfterMs('-5')).toBe(0);
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});
