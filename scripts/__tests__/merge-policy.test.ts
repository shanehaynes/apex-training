import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GRANT_LABEL, HELD, decide, gatherSources, lockfileHold, manifestHold } from '../merge-policy.mjs';

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
    'scripts/prod-schema-check.mjs',
    'scripts/combine-check.sh',
    'scripts/owner-preflight.sh',
    'scripts/hooks/bash-guard.mjs',
    '.claude/skills/parallel-agents/hooks/agent-guard.mjs',
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

  it("holds the merge floor's content, which ci.yml delegates to", () => {
    expect(decide(['scripts/ci-guards.sh'], [])).toMatch(/the merge floor's content/);
  });

  it('holds the coach eval baseline, and nothing else under evals/', () => {
    // The baseline IS the standard the coach gate judges against, so changing
    // it is not a code change — it is a change to what "no regression" means.
    // The attestation next to it is only evidence and stays auto-mergeable:
    // it is worthless the moment its hashes stop matching the tree.
    expect(decide(['evals/baseline/claude-sonnet-5.json'], []))
      .toMatch(/redefines what correct coach behavior is/);
    expect(decide(['evals/gate/attestation.json', 'evals/cases/refusal.ts'], [])).toBeNull();
  });

  it('holds the constitution and the file that loads it, not the workflow essentials', () => {
    expect(decide(['CONSTITUTION.md'], [])).toMatch(/only Shane amends it/);
    expect(decide(['CLAUDE.md'], [])).toMatch(/loads the constitution/);
    expect(decide(['TECHSTACK.md'], [])).toMatch(/stack decisions/);
    for (const p of ['.claude/CLAUDE.md', 'CLAUDE.local.md', '.claude/rules/a.md']) {
      expect(decide([p], [])).toMatch(/constitution's standing/);
    }
    expect(decide(['docs/workflow-essentials.md', 'ios/CLAUDE.md'], [])).toBeNull();
  });

  it('holds the iOS release lane', () => {
    for (const path of ['ios/fastlane/Fastfile', 'ios/scripts/testflight.sh']) {
      expect(decide([path], []), path).toMatch(/the release lane/);
    }
  });

  it('holds what Apple receives', () => {
    for (const path of [
      'ios/project.yml',
      'ios/Config/Release.xcconfig',
      'ios/Apex/Apex.entitlements',
      'ios/Apex/Info.plist',
      'ios/Apex/PrivacyInfo.xcprivacy',
      'ios/ApexWidgets/Info.plist',
    ]) {
      expect(decide([path], []), path).toMatch(/what Apple receives/);
    }
  });

  it('still auto-merges ordinary iOS source', () => {
    expect(decide(
      ['ios/Packages/ApexCore/Sources/ApexCore/API/ApexClient.swift', 'ios/Packages/ApexCore/Tests/ApexCoreTests/WriteQueueTests.swift'],
      [],
    )).toBeNull();
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

describe('dependency bumps of names already present merge alone', () => {
  const base = {
    name: 'apex',
    private: true,
    type: 'module',
    scripts: { build: 'vite build' },
    dependencies: { react: '^19.0.0' },
    devDependencies: { vitest: '^3.0.0' },
  };
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  const with_ = (patch: Record<string, unknown>) => json({ ...base, ...patch });
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    version: '1.0.0',
    resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    integrity: 'sha512-abc',
    ...extra,
  });
  const lock = (packages: Record<string, unknown>) => json({ lockfileVersion: 3, packages: { '': {}, ...packages } });
  const goodLock = lock({ 'node_modules/react': entry('react') });

  it('a version bump with its lockfile is not held', () => {
    const after = with_({ dependencies: { react: '^19.2.1' } });
    expect(decide(['package.json', 'package-lock.json'], [], 2, {
      'package.json': { before: json(base), after },
      'package-lock.json': { before: goodLock, after: goodLock },
    })).toBeNull();
  });

  it('a lockfile-only change (a bump, a new transitive name) is not held', () => {
    const after = lock({
      'node_modules/react': entry('react', { version: '1.0.1', resolved: 'https://registry.npmjs.org/react/-/react-1.0.1.tgz' }),
      'node_modules/@scope/dep': entry('@scope/dep', { resolved: 'https://registry.npmjs.org/@scope/dep/-/dep-1.0.0.tgz' }),
    });
    expect(decide(['package-lock.json'], [], 1, { 'package-lock.json': { before: goodLock, after } })).toBeNull();
  });

  it.each([
    ['a tarball of another publisher under an existing key', lock({ 'node_modules/react': entry('react', { name: 'evil', resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz' }) }), /new alias for evil/],
    ['a tarball of another name with no alias', lock({ 'node_modules/react': entry('react', { resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz' }) }), /resolves to a different package \(evil\)/],
    ['a tarball version that is not the entry version', lock({ 'node_modules/react': entry('react', { resolved: 'https://registry.npmjs.org/react/-/react-9.9.9.tgz' }) }), /not react@1\.0\.0/],
    ['a key outside node_modules', lock({ 'scripts/hooks': entry('hooks') }), /outside node_modules/],
    ['a traversal key', lock({ 'node_modules/../../x': entry('x') }), /outside node_modules/],
    ['a link', lock({ 'node_modules/x': { link: true, resolved: 'evil' } }), /is a link/],
    ['a bundled entry nothing bundles', lock({ 'node_modules/ghost': { version: '1.0.0', inBundle: true } }), /parent does not bundle it/],
  ])('holds a lockfile with %s', (_label, after, reason) => {
    expect(lockfileHold(goodLock, after)).toMatch(reason);
  });

  it('an alias the lockfile already had is not new', () => {
    const aliased = lock({ 'node_modules/p2r-updated': entry('path-to-regexp', { name: 'path-to-regexp' }) });
    expect(lockfileHold(aliased, aliased)).toBeNull();
  });

  it.each(['.npmrc', 'web/.npmrc', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '.yarnrc.yml', 'bun.lockb', 'packages/x/package.json'])(
    'holds %s by pattern',
    (path) => {
      expect(decide([path], [])).toMatch(/held for a human/);
    },
  );

  it.each(['resolutions', 'workspaces', 'bin', 'type', 'main', 'exports'])('holds a change to "%s"', (key) => {
    expect(manifestHold(json(base), with_({ [key]: key === 'type' ? 'commonjs' : { x: 'y' } }))).toMatch(new RegExp(`changes "${key}"`));
  });

  it.each(['workspace:*', 'link:../x', 'https://example.com/x.tgz', 'github:x/y', '^1 || file:../x'])('holds the version spec %s', (spec) => {
    expect(manifestHold(json(base), with_({ dependencies: { react: spec } }))).toMatch(/not a registry semver range/);
  });

  it('removing a dependency, or moving one to devDependencies, is not held', () => {
    expect(manifestHold(json(base), with_({ devDependencies: {} }))).toBeNull();
    expect(manifestHold(json(base), with_({ dependencies: {}, devDependencies: { vitest: '^3.0.0', react: '^19.0.0' } }))).toBeNull();
  });

  it.each([
    ['a new dependency', with_({ dependencies: { react: '^19.0.0', leftpad: '^1.0.0' } }), /adds a new dependency: leftpad/],
    ['a new dev dependency', with_({ devDependencies: { vitest: '^3.0.0', evil: '1.0.0' } }), /adds a new dependency: evil/],
    ['a dev dependency promoted to runtime', with_({ dependencies: { react: '^19.0.0', vitest: '^3.0.0' }, devDependencies: {} }), /moves vitest into dependencies/],
    ['a scripts change', with_({ scripts: { build: 'vite build', postinstall: 'curl x | sh' } }), /changes "scripts"/],
    ['an overrides block', with_({ overrides: { react: '19.0.0' } }), /changes "overrides"/],
    ['an engines change', with_({ engines: { node: '>=99' } }), /changes "engines"/],
    ['a git spec', with_({ dependencies: { react: 'git+https://github.com/x/react.git' } }), /not a registry semver range/],
    ['a file spec', with_({ dependencies: { react: 'file:../react' } }), /not a registry semver range/],
    ['an npm alias', with_({ dependencies: { react: 'npm:preact@^10' } }), /not a registry semver range/],
    ['a dist-tag', with_({ dependencies: { react: 'latest' } }), /not a registry semver range/],
  ])('holds %s', (_label, after, reason) => {
    const verdict = decide(['package.json'], [], 1, { 'package.json': { before: json(base), after } });
    expect(verdict).toMatch(/held for a human/);
    expect(verdict).toMatch(reason);
  });

  it('accepts ordinary semver ranges', () => {
    for (const spec of ['1.2.3', '^1.2.3', '~1.2', '1.x', '>=1.2.0 <2', '1.2.3 - 2.0.0', '^1 || ^2', '1.0.0-beta.2']) {
      expect(manifestHold(json(base), with_({ dependencies: { react: spec } })), spec).toBeNull();
    }
  });

  it.each([
    ['a git tarball', lock({ 'node_modules/react': entry('react', { resolved: 'git+ssh://git@github.com/x/react.git#abc' }) }), /resolves outside the npm registry/],
    ['another registry', lock({ 'node_modules/react': entry('react', { resolved: 'https://evil.example/react.tgz' }) }), /resolves outside the npm registry/],
    ['a lookalike registry host', lock({ 'node_modules/react': entry('react', { resolved: 'https://registry.npmjs.org.evil.example/react.tgz' }) }), /resolves outside the npm registry/],
    ['a missing integrity hash', lock({ 'node_modules/react': entry('react', { integrity: undefined }) }), /no integrity hash/],
    ['a newly added install script', lock({ 'node_modules/react': entry('react', { hasInstallScript: true }) }), /react newly runs an install script/],
  ])('holds a lockfile with %s', (_label, after, reason) => {
    const verdict = decide(['package-lock.json'], [], 1, { 'package-lock.json': { before: goodLock, after } });
    expect(verdict).toMatch(reason);
  });

  it('an install script the package already had is not new', () => {
    const scripted = lock({ 'node_modules/esbuild': entry('esbuild', { hasInstallScript: true }) });
    expect(lockfileHold(scripted, scripted)).toBeNull();
  });

  it('bundled entries without a resolved URL are fine when their parent bundles them', () => {
    expect(lockfileHold(goodLock, lock({
      'node_modules/a': entry('a', { bundleDependencies: ['b'] }),
      'node_modules/a/node_modules/b': { version: '1.0.0', inBundle: true },
    }))).toBeNull();
  });

  it('fails closed: missing sources, a new or deleted manifest, unparseable JSON', () => {
    expect(decide(['package.json'], [])).toMatch(/contents were not provided/);
    expect(decide(['package-lock.json'], [])).toMatch(/contents were not provided/);
    expect(manifestHold(null, json(base))).toMatch(/is new/);
    expect(manifestHold(json(base), null)).toMatch(/is deleted/);
    expect(manifestHold(json(base), '{nope')).toMatch(/does not parse/);
    expect(lockfileHold(goodLock, null)).toMatch(/is deleted/);
    expect(lockfileHold(goodLock, '[]')).toMatch(/does not parse/);
  });

  it('a clean manifest does not unhold anything else in the PR', () => {
    const verdict = decide(['package.json', 'vercel.json'], [], 2, { 'package.json': { before: json(base), after: json(base) } });
    expect(verdict).toMatch(/vercel\.json/);
    expect(verdict).not.toMatch(/package\.json —/);
  });

  it('the real manifest and lockfile pass against themselves', () => {
    const pkg = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const lk = readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8');
    expect(manifestHold(pkg, pkg)).toBeNull();
    expect(lockfileHold(lk, lk)).toBeNull();
  });

  it('gatherSources reads nothing it cannot pin to the given head', () => {
    expect(gatherSources(['src/App.tsx'], 1, 'a'.repeat(40))).toBeUndefined();
    expect(gatherSources(['package.json'], undefined, 'not-a-sha')).toBeUndefined();
    expect(gatherSources(['package.json'], undefined, '0'.repeat(40))).toBeUndefined();
  });
});

describe('merge-policy.mjs end to end: it reads the manifest at the PR head itself', () => {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const policy = fileURLToPath(new URL('../merge-policy.mjs', import.meta.url));

  const scenario = (after: Record<string, unknown>) => {
    const tmp = mkdtempSync(join(tmpdir(), 'apex-policy-'));
    const work = join(tmp, 'work');
    const git = (...a: string[]) => execFileSync('git', a, { cwd: work, env, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')], { env });
    execFileSync('git', ['init', '-q', '-b', 'main', work], { env });
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'x', dependencies: { react: '^19.0.0' } }));
    git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'main');
    git('remote', 'add', 'origin', join(tmp, 'origin.git')); git('push', '-q', 'origin', 'main');
    git('checkout', '-qb', 'pr');
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'x', ...after }));
    git('-c', 'commit.gpgsign=false', 'commit', '-qam', 'bump');
    const head = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', 'HEAD:refs/pull/3/head');
    git('checkout', '-q', 'main'); git('branch', '-qD', 'pr');
    const run = () => {
      try {
        execFileSync('node', [policy], { cwd: work, env, encoding: 'utf8', input: JSON.stringify({ number: 3, head, paths: ['package.json'], labels: [], changed: 1 }) });
        return { code: 0, out: '' };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { code: err.status, out: err.stdout };
      }
    };
    try { return run(); } finally { rmSync(tmp, { recursive: true, force: true }); }
  };

  it('a bump of an existing dependency exits 0', () => {
    expect(scenario({ dependencies: { react: '^19.2.0' } })).toEqual({ code: 0, out: '' });
  });

  it('a new dependency exits 10 and says which', () => {
    const r = scenario({ dependencies: { react: '^19.0.0', leftpad: '^1.0.0' } });
    expect(r.code).toBe(10);
    expect(r.out).toMatch(/adds a new dependency: leftpad/);
  });
});
