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
