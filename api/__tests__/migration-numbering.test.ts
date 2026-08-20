import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// phaseN is a repo-GLOBAL counter, and nothing about git protects it. Two
// branches can each add a phase33_*.sql, merge without a conflict — different
// filenames, no overlapping lines — and leave one slot holding two migrations.
//
// Nothing then errors. db-reset-local.sh applies the directory in `sort -V`
// order, which is deterministic but decided by the filename suffix, so the two
// run in alphabetical order rather than the order either author intended.
// Production is applied by hand through the Supabase SQL Editor, in whatever
// order someone pastes. Both are stable; neither was chosen; they can disagree.
// If one migration adds a column the other reads, a database built from scratch
// is silently wrong on whichever side lost the coin toss.
//
// CI runs this against the pull_request MERGE commit, so the second PR to claim
// a number fails here while renaming is still free — which is what
// CONTRIBUTING.md asks for and could not enforce. Use scripts/next-phase.sh to
// pick the next one.
//
// phase3 predates the convention: enable_rls and recurrence_rule are
// independent, and renaming a migration that has already run everywhere buys
// nothing. It is grandfathered rather than fixed.
const GRANDFATHERED = new Set([3]);

const MIGRATIONS = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));

describe('migration numbering', () => {
  it('gives every phaseN number to exactly one migration', () => {
    const byNumber = new Map<number, string[]>();

    for (const file of readdirSync(MIGRATIONS)) {
      const match = /^phase(\d+)_.*\.sql$/.exec(file);
      if (!match) continue;
      const n = Number(match[1]);
      byNumber.set(n, [...(byNumber.get(n) ?? []), file]);
    }

    // Proves the scan found something: an empty directory would pass vacuously.
    expect(byNumber.size).toBeGreaterThan(0);

    const collisions = [...byNumber.entries()]
      .filter(([n, files]) => files.length > 1 && !GRANDFATHERED.has(n))
      .map(([n, files]) => `  phase${n}: ${files.sort().join(', ')}`);

    expect(
      collisions.join('\n'),
      'two migrations claim one phase number, so their apply order is decided by '
        + 'filename rather than by intent — rename one (scripts/next-phase.sh)',
    ).toBe('');
  });
});
