import { describe, it, expect } from 'vitest';
import { tileSalt } from '../useTileResults';

// The tile cache key must change whenever the server would compute or label
// a tile differently — including the athlete's weight unit and body weight.

describe('tileSalt (A7)', () => {
  const base = { max_hr: 190, threshold_hr: 165, weight_unit: 'lb', body_weight_lb: 180 };
  const block = { startDate: '2026-09-07', endDateExclusive: '2026-11-02' };

  it('changes with the weight unit and the body weight', () => {
    const salt = tileSalt(base, block);
    expect(tileSalt({ ...base, weight_unit: 'kg' }, block)).not.toBe(salt);
    expect(tileSalt({ ...base, body_weight_lb: 181 }, block)).not.toBe(salt);
    expect(tileSalt({ ...base, body_weight_lb: null }, block)).not.toBe(salt);
  });

  it('still changes with the HR settings and the active block, and is stable otherwise', () => {
    const salt = tileSalt(base, block);
    expect(tileSalt({ ...base }, { ...block })).toBe(salt);
    expect(tileSalt({ ...base, max_hr: 191 }, block)).not.toBe(salt);
    expect(tileSalt(base, null)).not.toBe(salt);
  });
});
