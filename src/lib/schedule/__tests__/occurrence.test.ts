import { describe, it, expect } from 'vitest';
import { makeOccurrenceId, isOccurrenceId, baseIdOf, occurrenceDateOf } from '../occurrence';

describe('occurrence ids', () => {
  it('round-trips baseId and date', () => {
    const id = makeOccurrenceId('ai-123', '2026-09-07');
    expect(id).toBe('ai-123__2026-09-07');
    expect(isOccurrenceId(id)).toBe(true);
    expect(baseIdOf(id)).toBe('ai-123');
    expect(occurrenceDateOf(id)).toBe('2026-09-07');
  });

  it('passes plain ids through unchanged', () => {
    expect(isOccurrenceId('ai-123')).toBe(false);
    expect(baseIdOf('ai-123')).toBe('ai-123');
    expect(occurrenceDateOf('ai-123')).toBeNull();
  });

  it('splits at the first separator, matching the historical split("__")[0]', () => {
    expect(baseIdOf('a__2026-09-02')).toBe('a');
    expect(occurrenceDateOf(makeOccurrenceId('a', '2026-09-02'))).toBe('2026-09-02');
  });
});
