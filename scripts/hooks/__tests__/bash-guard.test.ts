import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkoutRoot, decide, effectiveDirs, isPrimaryCheckout, primaryRootOf } from '../bash-guard.mjs';

// A fake primary checkout (.git directory) with one linked worktree
// (.git file pointing back), mirroring the real layout.
const primary = mkdtempSync(join(tmpdir(), 'guard-primary-'));
mkdirSync(join(primary, '.git'));
mkdirSync(join(primary, 'src'));
const worktree = join(primary, '.claude', 'worktrees', 'fix-thing');
mkdirSync(worktree, { recursive: true });
writeFileSync(join(worktree, '.git'), `gitdir: ${join(primary, '.git', 'worktrees', 'fix-thing')}\n`);

afterAll(() => rmSync(primary, { recursive: true, force: true }));

describe('checkout topology', () => {
  it('resolves the primary root from inside the primary', () => {
    expect(checkoutRoot(join(primary, 'src'))).toBe(primary);
    expect(isPrimaryCheckout(primary)).toBe(true);
  });

  it('a linked worktree is its own root and is not primary', () => {
    expect(checkoutRoot(worktree)).toBe(worktree);
    expect(isPrimaryCheckout(worktree)).toBe(false);
  });

  it('primaryRootOf follows a worktree .git file back to the primary', () => {
    expect(primaryRootOf(worktree)).toBe(primary);
    expect(primaryRootOf(primary)).toBe(primary);
  });
});

describe('effectiveDirs', () => {
  it('includes cwd and literal cd targets, skipping unexpanded variables', () => {
    const dirs = effectiveDirs(`cd ${primary} && git commit -m x; cd "$OTHER" && ls`, worktree);
    expect(dirs).toContain(worktree);
    expect(dirs).toContain(primary);
    expect(dirs).toHaveLength(2);
  });
});

describe('rule: never pkill vite', () => {
  it('blocks pkill/killall targeting vite', () => {
    expect(decide('pkill -f vite', worktree, worktree)).toMatch(/every session/);
    expect(decide('killall vite', worktree, worktree)).toMatch(/every session/);
  });

  it('allows pkill of other processes and vite itself', () => {
    expect(decide('pkill -f my-own-daemon', worktree, worktree)).toBeNull();
    expect(decide('npm run dev', worktree, worktree)).toBeNull();
  });
});

describe('rule: look before destroying', () => {
  it('blocks git reset --hard and git clean -f variants', () => {
    expect(decide('git reset --hard origin/main', worktree, worktree)).toMatch(/only copy/);
    expect(decide('git clean -fd', worktree, worktree)).toMatch(/only copy/);
    expect(decide('git clean -xfd', worktree, worktree)).toMatch(/only copy/);
  });

  it('allows dry runs and the explicit override', () => {
    expect(decide('git clean -nd', worktree, worktree)).toBeNull();
    expect(decide('git reset --soft HEAD~1', worktree, worktree)).toBeNull();
    expect(decide('APEX_DESTRUCTIVE_OK=1 git clean -fd', worktree, worktree)).toBeNull();
  });
});

describe('rule: merge authority flows through the babysitter', () => {
  it('blocks direct gh pr merge, by name, absolute path, or API', () => {
    expect(decide('gh pr merge 61 --squash', worktree, worktree)).toMatch(/merge-babysit/);
    expect(decide('/home/shanehaynes/bin/gh pr merge 61 --squash', worktree, worktree)).toMatch(/merge-babysit/);
    expect(decide('gh api -X PUT repos/{owner}/{repo}/pulls/61/merge', worktree, worktree)).toMatch(/merge-babysit/);
  });

  it('blocks the agent granting itself the shipit label', () => {
    expect(decide('gh pr edit 61 --add-label shipit', worktree, worktree)).toMatch(/authority boundary/);
    expect(decide('gh api "repos/{owner}/{repo}/issues/61/labels" -f "labels[]=shipit"', worktree, worktree)).toMatch(/authority boundary/);
  });

  it('allows the babysitter itself, other labels, and reading PRs', () => {
    expect(decide('scripts/merge-babysit.sh --yes', worktree, worktree)).toBeNull();
    expect(decide('gh pr edit 61 --add-label bug', worktree, worktree)).toBeNull();
    expect(decide('gh pr view 61 --json mergeStateStatus', worktree, worktree)).toBeNull();
    expect(decide('gh pr list --state open', worktree, worktree)).toBeNull();
    expect(decide('gh pr create --base main --title x --body y', worktree, worktree)).toBeNull();
  });
});

describe('rule: the primary checkout is never a workspace', () => {
  it('blocks commits and builds when cwd is the primary', () => {
    expect(decide('git commit -m "oops"', primary, primary)).toMatch(/primary checkout/);
    expect(decide('npm run build', primary, primary)).toMatch(/primary checkout/);
    expect(decide('npm run agent:check', primary, primary)).toMatch(/primary checkout/);
  });

  it('blocks a cd into the primary from a worktree session', () => {
    expect(decide(`cd ${primary} && git commit -m x`, worktree, worktree)).toMatch(/primary checkout/);
  });

  it('allows the same commands in a worktree, and reads in the primary', () => {
    expect(decide('git commit -m "fine"', worktree, worktree)).toBeNull();
    expect(decide('npm run build', worktree, worktree)).toBeNull();
    expect(decide('git log --oneline', primary, primary)).toBeNull();
    expect(decide('scripts/git-new.sh fix/x', primary, primary)).toBeNull();
    expect(decide('npm ci', primary, primary)).toBeNull();
  });

  it('blocks Xcode and SwiftPM builds, which write into the checkout they run in', () => {
    expect(decide('xcodegen generate', primary, primary)).toMatch(/primary checkout/);
    expect(decide('cd ios && xcodegen generate', primary, primary)).toMatch(/primary checkout/);
    expect(decide('xcodebuild -scheme Apex test', primary, primary)).toMatch(/primary checkout/);
    expect(decide('swift test --package-path ios/Packages/ApexCore', primary, primary)).toMatch(
      /primary checkout/,
    );
    expect(decide('swift build', primary, primary)).toMatch(/primary checkout/);
  });

  it('allows iOS builds in a worktree, and read-only simulator queries anywhere', () => {
    expect(decide('xcodebuild -scheme Apex test', worktree, worktree)).toBeNull();
    expect(decide('xcodegen generate', worktree, worktree)).toBeNull();
    expect(decide('xcrun simctl list devices', primary, primary)).toBeNull();
    expect(decide('xcodebuild -version', worktree, worktree)).toBeNull();
  });
});
