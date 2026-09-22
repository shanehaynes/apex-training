import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkoutRoot,
  decide,
  effectiveDirs,
  isPrimaryCheckout,
  parseShell,
  primaryRootOf,
  ShellParseError,
} from '../bash-guard.mjs';
import type { SimpleCommand } from '../bash-guard.mjs';

// A fake primary checkout (.git directory) with one linked worktree
// (.git file pointing back), mirroring the real layout.
const primary = mkdtempSync(join(tmpdir(), 'guard-primary-'));
mkdirSync(join(primary, '.git'));
mkdirSync(join(primary, 'src'));
const worktree = join(primary, '.claude', 'worktrees', 'fix-thing');
mkdirSync(worktree, { recursive: true });
writeFileSync(join(worktree, '.git'), `gitdir: ${join(primary, '.git', 'worktrees', 'fix-thing')}\n`);

afterAll(() => rmSync(primary, { recursive: true, force: true }));

// `decide` in a worktree (the common case) and in the primary checkout.
const inTree = (command: string) => decide(command, worktree, worktree);
const inPrimary = (command: string) => decide(command, primary, primary);
const values = (c: SimpleCommand) => c.words.map((w) => w.value);

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

describe('a chain that opens with cd into a worktree', () => {
  // A subagent's Bash cwd is the primary checkout for every call; the only
  // way it can build or commit is `cd <worktree> && …`, which never runs
  // anything in the cwd. The hook used to count the cwd anyway.
  it('lets xcodebuild, xcodegen and git commit run in the worktree from a primary cwd', () => {
    expect(inPrimary(`cd ${worktree}/ios && xcodegen generate && xcodebuild -scheme Apex build`)).toBeNull();
    expect(inPrimary(`cd ${worktree} && git commit -m x`)).toBeNull();
  });

  it('still blocks a build that runs in the cwd, or after a cd it cannot read', () => {
    expect(inPrimary('xcodebuild -scheme Apex build')).toMatch(/primary checkout/);
    expect(inPrimary(`cd "$W" && xcodebuild build`)).toMatch(/primary checkout/);
    expect(inPrimary(`cd ${worktree} && cd - && git commit -m x`)).toMatch(/primary checkout/);
    expect(inPrimary(`git commit -m x && cd ${worktree}`)).toMatch(/primary checkout/);
  });

  it('honours an invocation that names its own directory over the cwd', () => {
    expect(inPrimary(`git -C ${worktree} commit -m x`)).toBeNull();
    expect(inPrimary(`xcodebuild -project ${worktree}/ios/Apex.xcodeproj -scheme Apex build`)).toBeNull();
    expect(inPrimary(`xcodegen generate --spec ${worktree}/ios/project.yml`)).toBeNull();
    expect(inTree(`git -C ${primary} commit -m x`)).toMatch(/primary checkout/);
    expect(inTree(`xcodebuild -project ${primary}/ios/Apex.xcodeproj build`)).toMatch(/primary checkout/);
  });

  it('resolves a relative path option against the chain directory, not the cwd', () => {
    // A subagent's cwd is the primary; `cd <worktree>/ios && xcodebuild
    // -project Apex.xcodeproj` runs in the worktree, and the relative
    // -project used to be resolved against the cwd instead — which named
    // the primary and discarded the correct chain directory.
    expect(inPrimary(`cd ${worktree}/ios && xcodebuild -project Apex.xcodeproj -scheme Apex build-for-testing`)).toBeNull();
    expect(inPrimary(`cd ${worktree}/ios && xcodebuild -workspace Apex.xcworkspace -scheme Apex build`)).toBeNull();
    expect(inPrimary(`cd ${worktree}/ios && xcodegen generate --spec project.yml`)).toBeNull();
    expect(inPrimary(`cd ${worktree} && git -C ios commit -m x`)).toBeNull();
    expect(inPrimary(`cd ${worktree} && git -C . commit -m x`)).toBeNull();
    // With no cd the relative option really is the primary — still blocked.
    expect(inPrimary('xcodebuild -project ios/Apex.xcodeproj -scheme Apex build')).toMatch(/primary checkout/);
    expect(inPrimary('cd ios && xcodebuild -project Apex.xcodeproj build')).toMatch(/primary checkout/);
    expect(inPrimary('git -C ios commit -m x')).toMatch(/primary checkout/);
    // And a relative option that walks back out of the worktree is caught.
    expect(inTree('cd ios && git -C ../../../.. commit -m x')).toMatch(/primary checkout/);
  });

  it('treats an unexpanded variable in a path option as unknown, not as a literal path', () => {
    // `$W/Apex.xcodeproj` must not be resolved as `<cwd>/$W/Apex.xcodeproj`;
    // the chain directory in effect is the answer, as for a relative path.
    expect(inPrimary(`cd ${worktree}/ios && xcodebuild -project $W/Apex.xcodeproj build`)).toBeNull();
    expect(inPrimary(`cd ${worktree}/ios && W=${worktree}/ios && xcodebuild -project "$W/Apex.xcodeproj" build`)).toBeNull();
    expect(inPrimary(`cd ${worktree} && git -C $W commit -m x`)).toBeNull();
    expect(inPrimary('xcodebuild -project $W/Apex.xcodeproj build')).toMatch(/primary checkout/);
    expect(inPrimary('git -C "$W" commit -m x')).toMatch(/primary checkout/);
  });

  it('resolves a relative cd against the directory the chain has reached', () => {
    expect(inPrimary(`cd ${worktree} && cd ios && xcodebuild -project Apex.xcodeproj build`)).toBeNull();
    expect(inTree(`cd .. && cd .. && cd .. && git commit -m x`)).toMatch(/primary checkout/);
  });
});

describe('effectiveDirs', () => {
  it('includes cwd and literal cd targets, skipping unexpanded variables', () => {
    const dirs = effectiveDirs(`cd ${primary} && git commit -m x; cd "$OTHER" && ls`, worktree);
    expect(dirs).toContain(worktree);
    expect(dirs).toContain(primary);
    expect(dirs).toHaveLength(2);
  });

  it('ignores a cd that is text rather than a directory change', () => {
    expect(effectiveDirs(`echo "cd ${primary}"`, worktree)).toEqual([worktree]);
    expect(effectiveDirs(`cat <<'EOF'\ncd ${primary}\nEOF\n`, worktree)).toEqual([worktree]);
  });

  // effectiveDirs reads the token stream only; `bash -c '…'` is a code
  // context, which `decide` expands but this exported helper does not.
  it('leaves code contexts to decide', () => {
    expect(effectiveDirs(`bash -c 'cd ${primary} && ls'`, worktree)).toEqual([worktree]);
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

// --------------------------------------------------------------------------
// #180 — the destructive commands the rules did not cover. One describe per
// row of the issue's table: the blocked form, the allowed neighbour beside it,
// and the override on the invocation itself.
// --------------------------------------------------------------------------

describe('#180: git checkout over the working tree', () => {
  it('blocks a pathspec checkout, a bare `.`, and -f', () => {
    expect(inTree('git checkout -- src/App.tsx')).toMatch(/overwrites uncommitted work/);
    expect(inTree('git checkout .')).toMatch(/overwrites uncommitted work/);
    expect(inTree('git checkout -f main')).toMatch(/overwrites uncommitted work/);
    expect(inTree('git checkout --force')).toMatch(/overwrites uncommitted work/);
    expect(inTree('git checkout HEAD -- .')).toMatch(/overwrites uncommitted work/);
  });

  it('allows switching branches, -b/-B/--orphan, and -p', () => {
    expect(inTree('git checkout main')).toBeNull();
    expect(inTree('git checkout -b fix/thing origin/main')).toBeNull();
    expect(inTree('git checkout -B fix/thing')).toBeNull();
    expect(inTree('git checkout --orphan gh-pages')).toBeNull();
    expect(inTree('git checkout -p -- src/App.tsx')).toBeNull();
  });

  it('honours the override on that invocation only', () => {
    expect(inTree('APEX_DESTRUCTIVE_OK=1 git checkout -- src/App.tsx')).toBeNull();
    expect(inTree('APEX_DESTRUCTIVE_OK=1 ls && git checkout .')).toMatch(/overwrites uncommitted work/);
  });
});

describe('#180: git restore', () => {
  it('blocks a worktree restore, including --staged --worktree', () => {
    expect(inTree('git restore src/App.tsx')).toMatch(/discards uncommitted changes/);
    expect(inTree('git restore .')).toMatch(/discards uncommitted changes/);
    expect(inTree('git restore --source=HEAD~1 src/')).toMatch(/discards uncommitted changes/);
    expect(inTree('git restore --staged --worktree src/App.tsx')).toMatch(/discards uncommitted changes/);
  });

  it('allows --staged, which only unstages', () => {
    expect(inTree('git restore --staged src/App.tsx')).toBeNull();
    expect(inTree('git restore -S .')).toBeNull();
  });

  it('honours the override', () => {
    expect(inTree('APEX_DESTRUCTIVE_OK=1 git restore src/App.tsx')).toBeNull();
  });
});

describe('#180: git stash drop/clear', () => {
  it('blocks drop and clear — the stack is shared with every worktree', () => {
    expect(inTree('git stash drop')).toMatch(/stash stack is shared/);
    expect(inTree('git stash drop stash@{2}')).toMatch(/stash stack is shared/);
    expect(inTree('git stash clear')).toMatch(/stash stack is shared/);
  });

  it('allows listing, showing and applying', () => {
    expect(inTree('git stash list')).toBeNull();
    expect(inTree('git stash show -p stash@{0}')).toBeNull();
    expect(inTree('git stash apply 0f1e2d3')).toBeNull();
    expect(inTree('git stash push -u -m "my-tag"')).toBeNull();
  });

  it('honours the override', () => {
    expect(inTree('APEX_DESTRUCTIVE_OK=1 git stash drop stash@{0}')).toBeNull();
  });
});

describe('#180: git branch -D', () => {
  it('blocks the force delete, clustered or spelled out', () => {
    expect(inTree('git branch -D fix/thing')).toMatch(/force-deletes a branch/);
    expect(inTree('git branch -d --force fix/thing')).toMatch(/force-deletes a branch/);
    expect(inTree('git branch --delete --force fix/thing')).toMatch(/force-deletes a branch/);
  });

  it('allows -d, listing and the read-only queries', () => {
    expect(inTree('git branch -d fix/thing')).toBeNull();
    expect(inTree('git branch --show-current')).toBeNull();
    expect(inTree('git branch -vv --sort=-committerdate')).toBeNull();
    expect(inTree('git branch -a')).toBeNull();
  });

  it('honours the override', () => {
    expect(inTree('APEX_DESTRUCTIVE_OK=1 git branch -D fix/thing')).toBeNull();
  });
});

describe('#180: git worktree remove --force', () => {
  it('blocks the forced removal', () => {
    expect(inTree('git worktree remove --force .claude/worktrees/fix-thing')).toMatch(
      /uncommitted changes in it/,
    );
    expect(inTree('git worktree remove -f .claude/worktrees/fix-thing')).toMatch(
      /uncommitted changes in it/,
    );
  });

  it('allows the checked removal, list, prune and add', () => {
    expect(inTree('git worktree remove .claude/worktrees/fix-thing')).toBeNull();
    expect(inTree('git worktree list')).toBeNull();
    expect(inTree('git worktree prune')).toBeNull();
    expect(inTree('git worktree add ../x fix/thing')).toBeNull();
    expect(inTree('scripts/git-tidy.sh --yes')).toBeNull();
  });

  it('honours the override', () => {
    expect(inTree('APEX_DESTRUCTIVE_OK=1 git worktree remove -f ../x')).toBeNull();
  });
});

describe('#180: git push --force (the weakest row)', () => {
  it('blocks --force, -f, +ref and --mirror', () => {
    expect(inTree('git push --force origin main')).toMatch(/overwrites the remote branch/);
    expect(inTree('git push -f')).toMatch(/overwrites the remote branch/);
    expect(inTree('git push origin +main:main')).toMatch(/overwrites the remote branch/);
    expect(inTree('git push --mirror backup')).toMatch(/overwrites the remote branch/);
  });

  it('allows --force-with-lease, --force-if-includes and an ordinary push', () => {
    expect(inTree('git push --force-with-lease origin fix/thing')).toBeNull();
    expect(inTree('git push --force-with-lease=fix/thing origin fix/thing')).toBeNull();
    expect(inTree('git push --force-if-includes --force-with-lease')).toBeNull();
    expect(inTree('git push -u origin fix/thing')).toBeNull();
    expect(inTree('git push')).toBeNull();
  });

  it('honours the override', () => {
    expect(inTree('APEX_DESTRUCTIVE_OK=1 git push --force origin fix/thing')).toBeNull();
  });
});

describe('#180: kill by pgrep/pidof of vite', () => {
  it('blocks a kill fed by a vite pid lookup, via substitution or pipe', () => {
    expect(inTree('kill $(pgrep -f vite)')).toMatch(/every session/);
    expect(inTree('kill -9 `pgrep -f vite`')).toMatch(/every session/);
    expect(inTree('kill $(pidof vite)')).toMatch(/every session/);
    expect(inTree('pgrep -f vite | xargs kill')).toMatch(/every session/);
    expect(inTree('pgrep -f vite | xargs kill -9')).toMatch(/every session/);
  });

  it('allows the lookup itself and the per-worktree port form CLAUDE.md teaches', () => {
    expect(inTree('pgrep -f vite')).toBeNull();
    expect(inTree('lsof -i :$(npm run -s port)')).toBeNull();
    expect(inTree('lsof -ti :$(npm run -s port) | xargs kill')).toBeNull();
    expect(inTree('kill 48213')).toBeNull();
    expect(inTree('kill $(pgrep -f my-own-daemon)')).toBeNull();
  });
});

describe('#180: gh api graphql mutations', () => {
  it('blocks the merge mutations', () => {
    expect(inTree("gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'")).toMatch(
      /merge-babysit/,
    );
    expect(inTree('gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) { x } }"')).toMatch(
      /merge-babysit/,
    );
  });

  it('blocks labelling by node id, which cannot be checked for shipit', () => {
    expect(inTree("gh api graphql -f query='mutation { addLabelsToLabelable(input: {}) { x } }'")).toMatch(
      /authority boundary/,
    );
  });

  it('allows graphql reads and the mutation names as prose', () => {
    expect(inTree("gh api graphql -f query='query { viewer { login } }'")).toBeNull();
    expect(inTree('gh issue create --title "Never call mergePullRequest by hand" --body x')).toBeNull();
    expect(inTree('gh pr create --base main --title x --body "addLabelsToLabelable is blocked"')).toBeNull();
  });
});

describe('#180: the new rows survive an unparseable command line', () => {
  it.each([
    ['checkout', "echo 'oops; git checkout -- src/App.tsx"],
    ['restore', "echo 'oops; git restore src/App.tsx"],
    ['stash drop', "echo 'oops; git stash drop"],
    ['branch -D', "echo 'oops; git branch -D fix/thing"],
    ['worktree remove -f', "echo 'oops; git worktree remove -f ../x"],
    ['push --force', "echo 'oops; git push --force origin main"],
  ])('falls back to the legacy regex for %s', (_label, command) => {
    expect(() => parseShell(command)).toThrow(ShellParseError);
    expect(inTree(command)).toMatch(/APEX_DESTRUCTIVE_OK=1/);
  });

  it('keeps the allowed neighbours allowed on that path too', () => {
    expect(inTree("echo 'oops; git push --force-with-lease origin fix/thing")).toBeNull();
    expect(inTree("echo 'oops; git restore --staged src/App.tsx")).toBeNull();
    expect(inTree("echo 'oops; git branch -d fix/thing")).toBeNull();
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

// --------------------------------------------------------------------------
// #144 — the guard matched raw text, so writing *about* a guarded command was
// refused and an override that was only mentioned was honoured.
// --------------------------------------------------------------------------

describe('#144: the reproduction table', () => {
  it('allows a PR body that describes the destructive-git rule', () => {
    expect(
      inTree(
        'gh pr create --base main --title x --body-file - ' +
          "<<'EOF'\nThe guard hook blocks git clean -f variants regardless.\nEOF",
      ),
    ).toBeNull();
  });

  it('allows a commit message that mentions git reset --hard', () => {
    expect(
      inTree("git commit -F - <<'EOF'\nguard: say why git reset --hard needs a look first\nEOF"),
    ).toBeNull();
  });

  it('allows grepping for a destructive command', () => {
    expect(inTree('grep -n "git clean -f" CONTRIBUTING.md')).toBeNull();
  });

  it('allows a commit message that mentions pkill vite', () => {
    expect(inTree('git commit -m "docs: never pkill -f vite, kill your own PID"')).toBeNull();
  });

  it('allows an issue title that mentions gh pr merge', () => {
    expect(
      inTree('gh issue create --title "Land PRs via the babysitter, never gh pr merge" --body x'),
    ).toBeNull();
  });

  it('allows grepping for the build list in the primary checkout', () => {
    expect(inPrimary('grep -n "npm run build" CONTRIBUTING.md')).toBeNull();
  });

  it('blocks a reset chained after an overridden clean', () => {
    expect(inTree('APEX_DESTRUCTIVE_OK=1 git clean -fd -- tmp/ && git reset --hard origin/main')).toMatch(
      /only copy/,
    );
  });

  it('still blocks the three destructive forms the fix had to keep', () => {
    expect(inTree('git clean -fd')).toMatch(/only copy/);
    expect(inTree("bash -c 'git clean -fd'")).toMatch(/only copy/);
    expect(inTree('git -C ../other clean -xfd')).toMatch(/only copy/);
  });
});

describe('#144: code stays code', () => {
  it('follows substitutions, heredocs fed to a shell, and pipes into one', () => {
    expect(inTree('cat <<EOF\n$(git clean -fd)\nEOF')).toMatch(/only copy/);
    expect(inTree('echo "$(git reset --hard)"')).toMatch(/only copy/);
    expect(inTree('echo `git clean -fd`')).toMatch(/only copy/);
    expect(inTree("eval 'git clean -fd'")).toMatch(/only copy/);
    expect(inTree("bash <<'EOF'\ngit clean -fd\nEOF")).toMatch(/only copy/);
    expect(inTree("echo 'git clean -fd' | bash")).toMatch(/only copy/);
  });

  it('follows a substitution nested inside a parameter expansion', () => {
    expect(inTree('echo "${x:-$(git clean -fd)}"')).toMatch(/only copy/);
    expect(inTree('echo "${x:-`git reset --hard`}"')).toMatch(/only copy/);
  });

  it('follows commands handed to another program to run', () => {
    expect(inTree('xargs git clean -fd')).toMatch(/only copy/);
    expect(inTree('find . -name x -exec git clean -fd {} \\;')).toMatch(/only copy/);
    expect(inTree("git submodule foreach 'git clean -fd'")).toMatch(/only copy/);
    expect(inTree("git rebase -x 'git reset --hard' main")).toMatch(/only copy/);
    expect(inTree("git -c alias.nuke='!git clean -fd' nuke")).toMatch(/only copy/);
  });

  it('sees through wrapper prefixes and git-<sub> basenames', () => {
    expect(inTree('sudo -u me env nohup timeout 30 git clean -fd')).toMatch(/only copy/);
    expect(inTree('/usr/lib/git-core/git-clean -fd')).toMatch(/only copy/);
    expect(inTree('git --git-dir=/x/.git reset --hard')).toMatch(/only copy/);
  });

  it('reaches into loop and if bodies', () => {
    expect(inTree('for f in a b; do git clean -fd; done')).toMatch(/only copy/);
    expect(inTree('if [ -d x ]; then git reset --hard; fi')).toMatch(/only copy/);
  });

  it('treats quoted heredoc bodies and quoted arguments as data', () => {
    expect(inTree("cat <<'EOF'\ngit clean -fd\nEOF")).toBeNull();
    expect(inTree("echo 'git clean -fd'")).toBeNull();
  });

  it('allows the Claude-style commit message, but not in the primary checkout', () => {
    const command = 'git commit -m "$(cat <<\'EOF\'\nguard: explain git reset --hard\nEOF\n)"';
    expect(inTree(command)).toBeNull();
    // `git commit` itself is what the primary checkout bans, not the message.
    expect(inPrimary(command)).toMatch(/primary checkout/);
  });
});

describe('#144: the override is per-invocation', () => {
  it('honours it on the destructive command, directly or through a wrapper', () => {
    expect(inTree('APEX_DESTRUCTIVE_OK=1 git clean -fd')).toBeNull();
    expect(inTree('env APEX_DESTRUCTIVE_OK=1 git clean -fd')).toBeNull();
  });

  it('refuses it when it is exported earlier or sits on a neighbour', () => {
    expect(inTree('export APEX_DESTRUCTIVE_OK=1; git clean -fd')).toMatch(/only copy/);
    expect(inTree('APEX_DESTRUCTIVE_OK=1 ls && git clean -fd')).toMatch(/only copy/);
  });

  it('refuses it when it is merely mentioned, or is not exactly 1', () => {
    expect(inTree('git commit -m "use APEX_DESTRUCTIVE_OK=1 before git clean -fd"')).toBeNull();
    expect(inTree('APEX_DESTRUCTIVE_OK=2 git clean -fd')).toMatch(/only copy/);
  });

  it('refuses it as a prefix on a shell that runs the destructive command', () => {
    expect(inTree("APEX_DESTRUCTIVE_OK=1 bash -c 'git clean -fd'")).toMatch(/only copy/);
    expect(inTree("APEX_DESTRUCTIVE_OK=1 eval 'git clean -fd'")).toMatch(/only copy/);
  });
});

describe('#144: forms the raw-text rules used to miss', () => {
  it('catches destructive flags the old adjacency regexes skipped', () => {
    expect(inTree('git clean -d -f')).toMatch(/only copy/);
    expect(inTree('git clean -x -f -d')).toMatch(/only copy/);
    expect(inTree('git reset -q --hard')).toMatch(/only copy/);
    expect(inTree('git reset HEAD --hard')).toMatch(/only copy/);
  });

  it('catches banned builds behind options and wrappers', () => {
    expect(inPrimary('npm run -s build')).toMatch(/primary checkout/);
    expect(inTree(`npm --prefix ${primary} run build`)).toMatch(/primary checkout/);
    expect(inPrimary('npx --yes vite')).toMatch(/primary checkout/);
    expect(inPrimary('xcrun xcodebuild -scheme Apex test')).toMatch(/primary checkout/);
    expect(inPrimary('swift --package-path ios/Packages/ApexCore build')).toMatch(/primary checkout/);
  });

  it('catches commits aimed at the primary checkout from elsewhere', () => {
    expect(inTree(`git -C ${primary} commit -m x`)).toMatch(/primary checkout/);
    expect(inPrimary('git --no-pager commit -m x')).toMatch(/primary checkout/);
    expect(inPrimary('/usr/lib/git-core/git-commit -m x')).toMatch(/primary checkout/);
  });

  it('catches a merge behind a global gh option', () => {
    expect(inTree('gh pr --repo o/r merge')).toMatch(/merge-babysit/);
  });

  it('catches a build that a shell string cds into the primary to run', () => {
    expect(inTree(`bash -c 'cd ${primary} && npm run build'`)).toMatch(/primary checkout/);
    // The same text as data still says nothing about where anything runs.
    expect(inTree(`echo 'cd ${primary} && npm run build'`)).toBeNull();
  });
});

describe('#144: mentions are data', () => {
  it('allows reading and writing about guarded commands', () => {
    expect(inPrimary('grep -n "xcodebuild" docs/x.md')).toBeNull();
    expect(inTree('git log --grep "reset --hard"')).toBeNull();
    expect(inTree('gh issue edit 5 --body "gh pr edit 61 --add-label shipit"')).toBeNull();
  });

  it('still blocks the real thing when the argument is merely quoted', () => {
    expect(inTree('pkill -f "vite"')).toMatch(/every session/);
  });
});

describe('#144: unparseable input falls back to the regexes, never to allow', () => {
  const deep = `${'$('.repeat(10)}git clean -fd${')'.repeat(10)}`;

  it.each([
    ['an unterminated quote', "echo 'git clean -fd"],
    ['a case statement', 'case x in y) git clean -fd;; esac'],
    ['an array assignment', 'arr=(1 2 3); git clean -fd'],
    ['nesting past the depth cap', deep],
  ])('blocks %s via the legacy path', (_label, command) => {
    expect(() => parseShell(command)).toThrow(ShellParseError);
    expect(inTree(command)).toMatch(/only copy/);
  });
});

describe('#144: grammar pins', () => {
  it("decodes $'…' escapes", () => {
    expect(values(parseShell("echo $'a\\tb'")[0])).toEqual(['echo', 'a\tb']);
  });

  it('keeps heredoc body text out of argv', () => {
    const [cat] = parseShell("cat <<'EOF'\ngit clean -fd\nEOF\n");
    expect(values(cat)).toEqual(['cat']);
    expect(cat.heredocs[0].body).toBe('git clean -fd\n');
    expect(cat.heredocs[0].quotedDelim).toBe(true);
  });

  it('reads 2>&1 as a redirection, not a separator', () => {
    const commands = parseShell('npm run build 2>&1 | tail -3');
    expect(commands).toHaveLength(2);
    expect(values(commands[0])).toEqual(['npm', 'run', 'build']);
    expect(values(commands[1])).toEqual(['tail', '-3']);
    expect(commands[1].pipeFrom).toBe(commands[0]);
  });

  it('keeps gh api placeholder braces in one word', () => {
    expect(values(parseShell('gh api repos/{owner}/{repo}/pulls/61/merge')[0])).toEqual([
      'gh',
      'api',
      'repos/{owner}/{repo}/pulls/61/merge',
    ]);
  });

  it('splits a mixed separator line into the right commands', () => {
    expect(parseShell('a && b || c; d | e & f\ng').map(values)).toEqual([
      ['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g'],
    ]);
  });
});

describe('#144: the hook process itself', () => {
  // The failure mode this catches is silent: a module that throws on import
  // exits 1, which the PreToolUse protocol reads as "allow" — the guard would
  // be off with nothing to show for it.
  const guard = fileURLToPath(new URL('../bash-guard.mjs', import.meta.url));
  const run = (input: string) => spawnSync(process.execPath, [guard], { input, encoding: 'utf8' });

  it('exits 2 with the reason for a blocked command', () => {
    const result = run(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git clean -fd' }, cwd: worktree }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/only copy/);
  });

  it('exits 0 for an allowed command, a non-Bash tool, and malformed stdin', () => {
    expect(
      run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: worktree }))
        .status,
    ).toBe(0);
    expect(run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } })).status).toBe(0);
    expect(run('not json at all').status).toBe(0);
  });
});
