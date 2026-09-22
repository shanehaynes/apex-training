import { describe, it, expect } from 'vitest';
import { ALL_CASES } from '../cases/index';

// The case set's own invariants. cases/index.ts throws on a duplicate id, but
// only when something imports it — today that is run.ts alone, so a collision
// would surface mid-run, after the tokens are spent. Importing it here moves
// that check into `npm test`, and the rest guards the shape every case must
// have for the harness and the judges to do anything with it.

describe('ALL_CASES', () => {
  it('has unique ids', () => {
    const ids = ALL_CASES.map(c => c.id);
    const seen = new Set<string>();
    const duplicates = ids.filter(id => (seen.has(id) ? true : (seen.add(id), false)));
    expect(duplicates).toEqual([]);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('gives every case a script that starts with a non-empty user turn', () => {
    for (const c of ALL_CASES) {
      expect(c.script.length, c.id).toBeGreaterThan(0);
      const first = c.script[0];
      expect(first.kind, c.id).toBe('user');
      expect(first.kind === 'user' && first.text.trim().length, c.id).toBeGreaterThan(0);
    }
  });

  it('gives every case at least one judged dimension', () => {
    for (const c of ALL_CASES) {
      const dimensions = Object.entries(c.expect).filter(([, v]) => v !== undefined);
      expect(dimensions.length, c.id).toBeGreaterThan(0);
    }
  });

  it('gives every refusal expectation a rubric for the judge to read', () => {
    for (const c of ALL_CASES) {
      if (!c.expect.refusal) continue;
      expect(c.expect.refusal.rubric.trim().length, c.id).toBeGreaterThan(0);
    }
  });
});
