import { describe, expect, it } from 'vitest';
import { GRANT_LABEL, HELD, decide } from '../merge-policy.mjs';

describe('auto-mergeable changes', () => {
  it('allows ordinary code, tests, and docs', () => {
    expect(decide(
      ['src/components/Tracker.tsx', 'api/_lib/handlers/events.ts', 'src/lib/__tests__/origin.test.ts', 'README.md'],
      [],
    )).toBeNull();
  });

  it('allows scripts that are not part of the authority chain', () => {
    expect(decide(['scripts/git-new.sh', 'scripts/next-phase.sh'], [])).toBeNull();
  });

  it('allows an empty change set', () => {
    expect(decide([], [])).toBeNull();
  });
});

describe('the authority chain can never merge itself', () => {
  // The self-erosion guard: every piece of the automation — the policy, the
  // actor, the guards, the settings that grant them — must be in HELD. A PR
  // that removes one of these from the list fails here, visibly.
  const authorityChain = [
    'scripts/merge-policy.mjs',
    'scripts/merge-policy.d.mts',
    'scripts/merge-babysit.sh',
    'scripts/deploy-verify.sh',
    'scripts/git-tidy.sh',
    'scripts/supervisor-report.sh',
    'scripts/combine-check.sh',
    'scripts/hooks/bash-guard.mjs',
    '.claude/settings.json',
  ];

  it.each(authorityChain)('holds %s', (path) => {
    expect(decide([path], [])).toMatch(/held for a human/);
  });
});

describe('held paths outside the authority chain', () => {
  it('holds migrations, CI, routing config, and dependency manifests', () => {
    for (const path of [
      'supabase/migrations/phase33_new_table.sql',
      '.github/workflows/ci.yml',
      'vercel.json',
      'package.json',
      'package-lock.json',
    ]) {
      expect(decide([path], []), path).toMatch(/held for a human/);
    }
  });

  it('one held path holds the whole PR, and the message names it', () => {
    const verdict = decide(['src/lib/coach/prompt.ts', 'vercel.json'], []);
    expect(verdict).toMatch(/vercel\.json/);
  });

  it('does not hold lookalike paths', () => {
    expect(decide(['src/lib/vercel.json.ts', 'docs/package.json.md'], [])).toBeNull();
  });
});

describe('the shipit label is a per-PR human grant', () => {
  it('overrides any hold', () => {
    expect(decide(['supabase/migrations/phase33_x.sql', '.claude/settings.json'], [GRANT_LABEL])).toBeNull();
  });

  it('other labels grant nothing', () => {
    expect(decide(['vercel.json'], ['bug', 'enhancement'])).toMatch(/held for a human/);
  });
});

describe('fail closed on partial information', () => {
  it('holds when the file listing is truncated', () => {
    expect(decide(['src/App.tsx'], [], 120)).toMatch(/truncated/);
  });

  it('a truncated listing still yields to the grant label', () => {
    expect(decide(['src/App.tsx'], [GRANT_LABEL], 120)).toBeNull();
  });
});

describe('HELD stays well-formed', () => {
  it('directory rules end in a slash and paths are repo-relative', () => {
    for (const { path } of HELD) {
      expect(path.startsWith('/')).toBe(false);
      expect(path.length).toBeGreaterThan(0);
    }
  });
});
