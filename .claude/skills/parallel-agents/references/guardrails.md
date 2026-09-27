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

## Making the skill itself hard to skip: `hooks/agent-guard.mjs`

Skills trigger from their description, which is probabilistic. The bundled
hook makes the skill's load-bearing decision — where does this worker run? —
impossible to skip, and refuses the commonest brief mistake. Wire it as a
`PreToolUse` hook:

```json
{ "hooks": { "PreToolUse": [ {
  "matcher": "Agent|Task|Workflow",
  "hooks": [ { "type": "command",
    "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/skills/parallel-agents/hooks/agent-guard.mjs" } ]
} ] } }
```

What it does on each subagent launch:

- **Unfilled template slots** (`{{NAME}}`, `{{NAME: description}}`) anywhere in
  the prompt → **denied**, listing the slot names and the `{{ NAME }}` escape
  for quoting the syntax. The pattern is narrow (upper-case name right after
  the braces), so JSX `style={{ color: 'red' }}`, Handlebars `{{name}}`, Go
  `{{.Name}}` and GitHub `${{ secrets.X }}` pass. Slots inside code fences
  still count.
- **Writing agent types** (anything with Bash/Edit/Write, `tools: *`, unknown
  types, and agents whose `tools:` it cannot parse — it fails closed) must
  declare a lane on its own line: `Lane: <abs worktree path>`,
  `Lane: read-only`, or `Lane: none — <reason>`, or launch with
  `isolation: "worktree"`. Otherwise the launch is **denied** with a message
  saying how to comply.
- Lane lines inside code fences or `>` quotes are ignored (examples are not
  declarations); several Lane lines naming different checkouts are denied.
  Headings, list items, emphasis, a trailing `(parenthetical)` and
  ` — commentary` are tolerated.
- A lane path must exist, resolve (realpath) outside temp directories, and be
  a *linked worktree* — of the primary's repository, a bare repository or a
  separate-git-dir repository — whose gitdir exists. The primary checkout, a
  submodule, and a stale `.git` file are denied. A declared path is checked
  even with `isolation: "worktree"`. A worktree of a different repository is
  allowed with a note.
- A path lane whose brief contains no report schema (`GATE TOUCHED` or
  `FINDINGS:`) gets a reminder to paste one from `references/briefs.md`.
- `Workflow` launches get a reminder only; the hook cannot see inside a
  workflow script's `agent()` calls.
- Fails open on internal errors; works when invoked through symlinks;
  `PARALLEL_AGENTS_GUARD=off` disables it. Tests: `node --test
  tests/agent-guard.test.mjs` and the guard suite in `tests/acceptance/`.

Verified against Claude Code 2.1.281 (2026-09): `PreToolUse` fires for the
`Agent` tool with `tool_input` = `{description, prompt, subagent_type,
run_in_background, …}`; exit 2 puts stderr in front of the model verbatim;
`hookSpecificOutput.additionalContext` on exit 0 reaches the model. Some
documentation says `PreToolUse` does not fire for `Agent` — test on your
version: log the hook's stdin and launch one agent.

The declaration is honor-system for `read-only` and `none` — the hook cannot
know what a brief intends. What it buys is that the orchestrator must decide
in writing, where a reviewer (or the user) can see the decision.

## What the lane script refuses (and why)

`lane.sh` is the other mechanism: the right way made easy, the destructive
way made hard. Its removal paths fail closed:

- `retire` refuses a lane that is still `active` (release it first), dirty in
  any way git can hide (untracked files even with `status.showUntrackedFiles=no`,
  skip-worktree or assume-unchanged edits present on disk), unpushed, locked,
  holding another registered worktree, or whose HEAD reflog holds commits on
  no branch, remote branch or tag — it lists those commits, and
  `--discard-unreachable` proceeds only after you have looked.
- `tidy` never removes an active, locked, dirty or unreachable-commit lane,
  never prunes a missing worktree outside `.claude/worktrees/` (it may have
  been moved by hand) or one it cannot inspect, and continues past a failed
  removal instead of stopping half-way.
- Every claims write happens under a machine-wide lock, and every field is
  sanitized, so a stray control character can never make an active lane look
  finished.
