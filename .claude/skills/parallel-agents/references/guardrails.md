# Guardrails: turning rules into mechanisms

Prose rules are read by the session that reads them. Parallel work means many
sessions, some of them subagents with a two-paragraph brief, so every rule that
matters eventually has to become either the default path (a script) or a
blocked path (a hook). The source project reached this the hard way: each rule
below was prose first, broken by some session, then mechanized.

## What to block (a `PreToolUse` hook on `Bash`)

| Block | Why | Keep allowed (the safe neighbour) |
|---|---|---|
| Build, install or commit in the **primary checkout** | It is every session's shared read space; a build there is invisible damage to all of them | Reading, `git log`, `git fetch`, `git worktree add` |
| `git reset --hard`, `git clean -f` | Throws away uncommitted work that may be another session's only copy | `git reset --soft`, `git clean -n` |
| `git checkout -- <path>` / `.` / `-f`, `git restore` | Same, one file at a time | `git checkout -b`, `git restore --staged` |
| Bare `git stash` / `stash push` with no `-m`, `stash pop`, `stash apply` with no ref, `stash drop`/`clear` | One stash stack per repo, shared by all worktrees; `pop` applies whoever pushed last | `git stash push -u -m "<unique-tag>"`, `git stash apply <sha>` |
| `git branch -D`, `git worktree remove --force` | Deletes unmerged work | `git branch -d`, `git worktree remove` (refuses when dirty) |
| `git push --force` / `-f` / `+ref` / `--mirror` | Rewrites someone else's base | `git push --force-with-lease` |
| `pkill`/`killall <server>`, `kill $(pgrep -f <server>)` | Kills every lane's server | `lsof -ti :<my-port> \| xargs kill` |
| Merging PRs directly, self-applying an approval label | Merges must go through the one path that checks policy | The merge script |

Give destructive rows a **per-command override** (an env var placed directly
before that one command, e.g. `PROJECT_DESTRUCTIVE_OK=1 git reset --hard`).
The point is to make the session *look* first, not to make the action
impossible; an override that covers the whole line or a spawned shell defeats
that.

## How to write the hook so it holds up

These are the bugs the source project's guard actually had, in order:

1. **Regex over raw text blocks mentions.** A commit message or PR body that
   *mentions* `git clean -fd` got blocked. Tokenize the command into shell
   words and match commands, not substrings. Do follow `bash -c`, `eval`,
   `$(…)` and heredocs fed to a shell — those are code.
2. **Judging by the shell's cwd blocks every subagent.** A subagent's Bash cwd
   is often the primary checkout for every call; its only way to work is
   `cd <worktree> && …`. A guard that looked at cwd blocked every build and
   commit a worker issued — a whole wave stalled on it. Walk the chain: a
   literal `cd` moves the effective directory; `git -C <dir>` and tool flags
   that name a project (`-project`, `--spec`, `--prefix`) are judged by that
   directory; an unresolvable `cd "$X"` falls back to cwd.
3. **Relative paths resolved against the wrong base.** Resolve relative `cd`
   targets and path options against the chain's current directory, not the
   shell's.
4. **Gaps in the destructive set.** The first version knew only
   `reset --hard` and `clean -f`. A subagent then ran a bare `git stash`
   inside a compound command, reverting its own edits; the `pop` that
   recovered them could as easily have applied another session's entry.
   Enumerate every way to discard work, and test each one *and* its safe
   neighbour.
5. **Anchoring on `--show-toplevel`.** From inside a worktree that answers
   with the worktree. The primary checkout is
   `$(git rev-parse --git-common-dir)/..` — use that for "where is primary"
   and for where shared state (claims, locks) lives.

Write the hook with a test table: one row per blocked form, one per allowed
neighbour, and the subagent shapes (`cd <wt> && git commit`, `git -C <wt>
commit` from primary). Hooks are code that every session runs; they deserve
tests more than most code.

## Authority boundaries

The merge path is the most consequential automation. Bound it on four sides:

- **Branch protection is the floor** — required checks cannot be skipped by any
  script.
- **A merge policy holds some paths for a human**: CI config, the merge policy
  and hook files themselves, settings/permissions, deploy config, dependency
  manifests, migrations, release/signing surface. First principle: *an agent
  must never be able to merge an expansion of its own authority.* Pin the held
  list with tests so shrinking it fails CI.
- **A per-PR human grant** (a label the hook forbids agents to apply).
- **A kill switch** file checked on every pass of any unattended loop.

These are nets against slip-ups, not walls against an adversary. The layers
behind them are the permission system, branch protection, and holding every
change to the automation for a human.

## Making the skill itself hard to skip

Skills trigger from their description, which is probabilistic. If every
subagent launch must follow this skill, back it with a hook on the Agent/Task
tool (or on `SubagentStart`, where supported) that injects a one-line reminder
or checks the brief contains a worktree path. Verify the current hook events
and output fields in the Claude Code docs before relying on one.
