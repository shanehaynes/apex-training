#!/usr/bin/env node
// PreToolUse hook for the Bash tool (wired in .claude/settings.json): the
// mechanical form of three CLAUDE.md rules that used to be prose only.
//
//   1. Never `pkill -f vite` — that is every session's dev server.
//   2. Never `git reset --hard` / `git clean -f` without looking first — the
//      working tree may hold another session's only copy of its work.
//      Reviewed and safe? Re-run prefixed with APEX_DESTRUCTIVE_OK=1.
//   3. Never build or commit in the primary checkout — it stays on main,
//      clean. Worktrees (scripts/git-new.sh) are the workspace.
//
// Protocol: exit 2 with the reason on stderr blocks the call and shows the
// agent the message; anything else allows it. Internal errors allow (fail
// open) — a broken guard must not brick every session.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Walk up from dir to the checkout root (the first dir owning `.git`).
// A linked worktree stops here at its own root: its `.git` is a file.
export function checkoutRoot(dir) {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

// Primary checkout = `.git` is a directory (same test dev/port.mjs uses).
export function isPrimaryCheckout(root) {
  try {
    return statSync(join(root, '.git')).isDirectory();
  } catch {
    return false;
  }
}

// The primary checkout that owns this session's project dir — from the
// primary itself, or via a linked worktree's `.git` file, which reads
// `gitdir: <primary>/.git/worktrees/<name>`.
export function primaryRootOf(projectDir) {
  const root = checkoutRoot(projectDir);
  if (!root) return null;
  if (isPrimaryCheckout(root)) return root;
  try {
    const gitdir = readFileSync(join(root, '.git'), 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
    if (!gitdir) return null;
    return resolve(root, gitdir[1], '..', '..', '..');
  } catch {
    return null;
  }
}

// Directories a command may execute in: the hook cwd plus any literal `cd`
// targets. `cd "$SOMEWHERE"` with an unexpanded variable is skipped rather
// than guessed at.
export function effectiveDirs(command, cwd) {
  const dirs = [resolve(cwd)];
  for (const segment of command.split(/(?:&&|\|\||[;|\n])/)) {
    const m = segment.trim().match(/^cd\s+(?:"([^"$]+)"|'([^']+)'|([^\s"'$]+))/);
    if (!m) continue;
    let target = m[1] ?? m[2] ?? m[3];
    if (target.startsWith('~')) target = join(homedir(), target.slice(1));
    dirs.push(resolve(cwd, target));
  }
  return dirs;
}

const PKILL_VITE = /\b(pkill|killall)\b[^|;&]*\bvite\b/;
const DESTRUCTIVE_GIT = /\bgit\b[^|;&()]*\b(reset\s+--hard|clean\s+(-[A-Za-z]*f[A-Za-z]*\b|[^|;&]*--force))/;
// What "do not build there, do not commit there" means concretely.
const PRIMARY_BANNED = /\bgit\s+commit\b|\bnpm\s+run\s+(build|dev(:agent)?|preview|e2e(:live)?|agent:check(:full)?)\b|\bnpx?\s+vite\b/;

export function decide(command, cwd, projectDir) {
  if (PKILL_VITE.test(command)) {
    return (
      'Blocked: `pkill`/`killall` on vite kills every session’s dev server, not just yours (CLAUDE.md). ' +
      'Kill only your own: `lsof -i :$(npm run -s port)`, then kill that PID.'
    );
  }

  if (DESTRUCTIVE_GIT.test(command) && !command.includes('APEX_DESTRUCTIVE_OK=1')) {
    return (
      'Blocked: `git reset --hard` / `git clean -f` can destroy another session’s only copy of its work ' +
      '(CONTRIBUTING.md, “Never do this”). First run `git status` and read the file list; commit anything ' +
      'that exists nowhere else to a branch. If you have looked and it is safe, re-run the exact command ' +
      'prefixed with APEX_DESTRUCTIVE_OK=1.'
    );
  }

  if (PRIMARY_BANNED.test(command)) {
    const primary = primaryRootOf(projectDir);
    for (const dir of effectiveDirs(command, cwd)) {
      const root = checkoutRoot(dir);
      if (root && root === primary && isPrimaryCheckout(root)) {
        return (
          'Blocked: this would run in the primary checkout, which stays on main, clean — never build or ' +
          'commit there (CLAUDE.md). Start work with `scripts/git-new.sh <type>/<slug>` and run this inside ' +
          'the worktree it prints.'
        );
      }
    }
  }

  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (input.tool_name !== 'Bash') return 0;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return 0;
  const cwd = input.cwd || process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;

  let verdict = null;
  try {
    verdict = decide(command, cwd, projectDir);
  } catch {
    return 0; // fail open
  }
  if (verdict) {
    process.stderr.write(verdict + '\n');
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.exit(main());
}
