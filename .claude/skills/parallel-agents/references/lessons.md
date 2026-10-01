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

→ Ports are per-worktree, read by every tool from one resolver, with
strict-port on so clashes are loud. (First hashed from the directory name;
v2 allocates the lowest free port and records it in the claim, since hashing
had ~60% collision odds at 40 lanes.)
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
based on anything else. Dependencies become edges scheduled after the dependency merges, not stacks.

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

## The skill's own scripts, under independent review (v2 build)

v2 of this skill's scripts was built the way the skill says: four
implementation lanes against a written contract, an independent verifier lane
writing acceptance tests from the contract alone, then adversarial reviewers
on the pinned result — twice. Each author's own tests passed every time. The
independent checks found, among others:

- **An unquoted cleanup loop deleted a user's directory.** With the primary
  checkout at `…/my repo/p`, `for w in $made_wts` split the path and the
  fallback `rm -rf` removed the sibling directory `…/my`. The author's tests
  never used a path with a space.
- **`retire` deleted untracked notes** when the user's git config set
  `status.showUntrackedFiles=no`: the "dirty" check trusted a display setting.
- **The ledger lost a recorded merge** after a crash left a partial last line;
  the next append glued onto it, and `ready` offered the merged lane again.
- **The guard silently disabled itself** when invoked through any symlink:
  `import.meta.url` is the realpath, `process.argv[1]` is not.
- **`--baseline` blamed main for the lanes' fault**: the check ran test files
  the lanes added; on base they didn't exist (exit 127), which read as "base
  fails too". Found by running the tool on its own integration.
- **A byte 0x1F in a lane's intent** shifted the claims row so an active lane
  read as finished, and tidy removed it under a live worker.

→ A green self-authored suite is not evidence. Independent acceptance tests,
reviewers who never see the author's reasoning, and reproducing every
critical finding before acting on it are what caught these. Review severity
converged across rounds (data loss → edge cases); that, not a quiet round, is
the signal to stop. Also: the verifier can be stricter than the spec, and an
author may be right that a rule is too blunt (ignoring global excludes would
have made every macOS lane with a `.DS_Store` unretirable) — rule on it,
don't just enforce it.

## Design note: why the hub stays the gate

Message Passing Language Models (Liu, Arora, Swamy, Zanette, CMU, arXiv
2607.01077) let parallel reasoning threads message only the peers they depend
on, instead of funnelling everything through a coordinator. On Sudoku and
3-SAT they beat a fork-join hub trained the same way (9×9 Sudoku: 100% in 15 s
against 93% in 60 s; only message passing scaled to 16×16 and 25×25), on a
fine-tuned 0.6B model.

What that does and doesn't transfer:

- Those tasks have a dependency graph fixed in advance, and every message is
  the output of a procedure the model was trained to run (constraint
  propagation, DPLL). The Sudoku set was filtered so no step needs a guess.
  The paper does not study a wrong message spreading. A lane's report is a
  claim; passed peer-to-peer it becomes a premise before anyone checks it.
- Peer messaging destroys independence: lanes that share findings make
  correlated mistakes and can no longer serve as each other's check or as
  redundant attempts.
- The gains that don't need peer topology are adopted here:
  - *wait only on the peers you need* → dependency edges, not waves; contracts
    delete edges;
  - *persistent workers and targeted queries* (the paper's only prompting-only
    experiment, long-context QA, kept the parent as hub: 37.8% vs 29.7% at
    1.7× faster on one model, parity at 2.2× faster on another) → short report
    first, then follow-up questions to the specific worker;
  - *preemption* (best case 3.45× on unbalanced 3-SAT trees) →
    FIRST-SUFFICIENT races stopped once a win checks out;
  - *respawn with a compressed state* → continuation briefs;
  - *send only to dependents* → targeted relays of checked facts.
- Logging a message is not checking it; the hub is valuable as a gate, not as
  an audit log.
