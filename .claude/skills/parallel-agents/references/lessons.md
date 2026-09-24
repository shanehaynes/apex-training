# Lessons ledger

Where each rule in this skill came from. Distilled from building Apex Training
(React/Vite + serverless API + Supabase, plus a native iOS port) with many
Claude sessions and subagent fleets working one repository at once — up to 37
parallel lanes in one run. Each entry: what happened → what it taught → the
mechanism that now prevents it. Add to this file when a new one happens; the
ratchet only works if the incidents are written down.

## The founding incident: the primary checkout as scratchpad

The primary checkout was left on a long-merged branch and became a scratchpad.
Four features were assembled in it by copying files in from worktrees. When
someone finally looked, it held 44 modified files: 31 were byte-identical
copies of work already committed elsewhere (noise, but indistinguishable from
real work without a file-by-file diff against every branch); 4 were a genuine
bug fix that existed **nowhere else** — one `git clean -fd` from gone; and 1
was a silent revert of a refactor that had since landed on main, which would
have looked like an intentional change in any diff. The files changed *while
being analysed*, because another session was working in the same checkout.

→ The primary checkout is never a workspace. One worktree per task, including
one-liners. Never copy files between branches — merge. Look before discarding.
→ Mechanism: a worktree-creation script as the only easy way to start; a hook
that blocks builds, commits and destructive git in the primary checkout.

## Fixed port + server reuse = testing the wrong code

The test runner reused any server already on the dev port. With one fixed
port, lane B's end-to-end suite could land on lane A's server and pass or fail
on A's code, with no error.

→ Ports are per-worktree, deterministic (hashed from the directory name), read
by every tool from one resolver, with strict-port on so clashes are loud.
→ Never kill servers by name; kill the PID on your own port.

## One database, many resetters

Live e2e and the local reset truncate whole tables. The test runner serialized
workers *within* a run, which did nothing across sessions.

→ A machine-wide lock around every reset/seed command (atomic `mkdir`, PID
recorded, stale locks reaped when the PID is gone, bounded wait that names the
holder). Unattended sessions are refused the reset outright; they report a
stale schema instead of working from it.

## Global counters merge cleanly and wrongly

Migrations are ordered by a `phaseN_` prefix across the directory. Two branches
each added a `phase33_*` file: no conflict, both merge, apply order now decided
by the filename suffix locally and by paste order in production.

→ Claim the number when the PR opens, not at start; a script lists claims on
all branches; a test fails the second PR to take a number while renaming is
still free.

## Branches that each merge cleanly conflict with each other

Found only after the first PR landed, when the second needed a rebuild.

→ Pairwise `git merge-tree` before PRs open; move hunks rather than stack.

## Stacked PR took production down

A PR based on another PR's branch merged into that branch instead of main,
because the base was deleted in the wrong order. Its dependents reached
production; it did not.

→ Every PR is based on the default branch. The merge automation refuses a PR
based on anything else. Dependencies become waves, not stacks.

## Green union, broken platform

The fleet merge proved the folded tree with the web gate. Main did not compile
for iOS for several days, because nothing in the fold compiled Swift.

→ A proof covers exactly what it runs. Every report and PR names what was not
verified; a nightly full run re-proves main from scratch.

## The guard that blocked every subagent

The hook judged commands by the shell's cwd. A subagent's cwd is the primary
checkout on every call, so every `cd <worktree> && git commit` a worker issued
was blocked — an entire wave of a UI implementation stalled on it.

→ Judge a command by the directory it will run in (walk `cd` chains, honor
`git -C`). Test the subagent command shapes explicitly.

## The bare stash

A subagent ran a bare `git stash` inside a compound command and reverted its
own tracked edits. The `pop` that recovered them could as easily have applied
another session's entry — the stash stack is shared by every worktree.

→ Stash only with a unique message; apply by SHA; never `pop`. Prefer a WIP
commit. The hook blocks the untagged forms.

## Tidy removed a lane that had just started

Cleanup treated "branch tip is an ancestor of main" as "merged" and removed a
worktree seconds after it was created, while its session was still setting up.

→ A branch with no commits of its own is never auto-removed; in a squash-merge
repo a genuinely merged branch is never an ancestor, so ancestry alone means
"not started", not "finished".

## Tidy, run from a worktree, saw nothing

`--show-toplevel` answered with the worktree, so every path comparison against
`<root>/.claude/worktrees/` failed.

→ Anchor shared paths on `git rev-parse --git-common-dir`.

## Squash merges hide "merged"

`git branch --merged` never reports a squash-merged branch.

→ Detect by content (in-memory merge leaves main's tree unchanged), plus
"upstream deleted" as evidence reported for review, never auto-deleted.

## Silent truncation

`gh pr list` returned 30 of 39 open PRs and the combine check reported on 30 as
if it were all of them.

→ Ask for far more than you expect and fail loudly if you hit the limit.

## Outputs that died with their worktree

Screenshot sets and git-ignored release config (secrets xcconfig, key IDs)
lived only inside worktrees. Tidying the worktree deleted them; the screenshot
set had to be regenerated from scratch.

→ Anything a lane produces that matters is either committed, copied to a
durable location, or reproducible by one documented command. Reports list
ignored outputs by path so the orchestrator can decide.

## Contention looks like flakiness

Screenshot legs and UI tests failed under parallel simulator load, and a stale
derived-data bundle from another run sank a first attempt.

→ Wave width is set by the scarcest resource (two simulator lanes at a time);
per-lane build/derived-data paths; failures in parallel that pass alone mean
narrow the wave before debugging the code.

## A quota stopped the merge train

A hosting plan's deploy cap made the merge loop refuse most PRs mid-fleet; the
human merged the rest by hand.

→ Know external quotas before a large landing; they are shared resources too.

## What worked, and is worth copying

- **One orchestrator, many lanes, one worktree each.** A coordinator with 37
  code-only lanes (one per open review issue) produced 36 green PRs; a
  coordinator with ten UI workers ran them two at a time in six waves.
- **The orchestrator owns every shared resource.** Workers build, test, commit,
  push, and report a SHA; the orchestrator cuts worktrees, opens PRs, runs
  cross-branch checks and the merge loop.
- **Refused actions are reported, not routed around.** It made permission
  boundaries informative instead of adversarial.
- **Verifiers that cannot edit.** A read-only verification agent that proves or
  disproves a change with evidence, separate from the agent that made it.
- **A session protocol and a status board** for long multi-session efforts:
  read the master doc, the board, exactly one workstream brief; claim the
  workstream; before ending, update the brief's log, the board and the
  decision record. Gates between workstreams ("backend merged before client
  starts") kept waves honest.
- **Structured worker output** (a JSON schema per agent in workflow scripts)
  so the orchestrator composes results mechanically.
