# Working on Apex Training

This repo is worked on by one person and several Claude Code sessions at once,
often simultaneously. That is the constraint everything below is designed
around: **more than one agent may be editing this repo right now, and none of
them can see each other's uncommitted work.**

Ignoring that is not a style violation, it is how work gets destroyed. The
incident that produced this document is written up at the end.

## The one rule

**The primary checkout is never a workspace.**

`~/projects/apex-training` stays on `main`, clean, always. It is where you read
code, run `git log`, and cut new branches from. Nothing is ever built there.

Every piece of work happens in a worktree. No exceptions, including "this is a
one-line fix."

## Starting work

```bash
scripts/git-new.sh fix/stranded-event-dates
```

That cuts a branch from a freshly-fetched `origin/main`, creates
`.claude/worktrees/fix-stranded-event-dates/`, and prints the path to `cd` into.

Do it by hand if you prefer, but keep the three invariants:

1. **Branch from current `origin/main`**, not from whatever the primary checkout
   happens to be sitting on.
2. **Worktrees live in `.claude/worktrees/<branch-with-slashes-as-dashes>`.**
   Never in `/tmp`. `/tmp` does not survive a reboot, and a scratch directory
   under one session's id is invisible to every other session — including to
   the human trying to work out where a branch went.
3. **One worktree = one branch = one PR = one concern.** If you find a second
   thing worth fixing, cut a second worktree.

### Naming

`<type>/<slug>`, lowercase, hyphenated:

| Type | For |
|---|---|
| `feat/` | new user-visible capability |
| `fix/` | bug fix |
| `chore/` | tooling, CI, deps, docs |
| `db/` | anything adding a `supabase/migrations/phaseN_*.sql` |

Do not use `claude/*` or `worktree-*`. Those encode *who* made the branch or
*how*, which nobody needs to know. The branch name should say what changed.

## Finishing work

Open a PR against `main`. Squash-merge it. GitHub deletes the remote branch.
Then retire the local side:

```bash
scripts/git-tidy.sh
```

That removes every worktree whose branch is fully merged into `origin/main`,
deletes the merged local branches, and prunes dead remote-tracking refs. It
refuses to touch a worktree with uncommitted changes, and it never deletes an
unmerged branch.

Run it when you finish something. The alternative is what this repo looked like
before this document: 7 worktrees, 15 merged-but-undeleted local branches, and
10 remote refs pointing at branches that no longer existed.

## Never do this

**Never hand-assemble changes across branches in a working tree.** If branch B
needs branch A's code, merge A into B, or rebase B onto A. Do not copy files
between worktrees, and do not "just paste in" the version you want.

This is the single practice that caused the incident below. Copied files carry
no ancestry, so git cannot tell you where they came from, whether they are
current, or whether you have just reverted somebody's refactor. Merging carries
that information; copying discards it.

**Never commit from the primary checkout.** If you find yourself typing
`git commit` in `~/projects/apex-training`, stop — you are on `main`.

**Never `git reset --hard` or `git clean -fd` in a shared checkout** without
first checking `git status` for work that exists nowhere else. Another session's
only copy of something may be sitting there.

## Parallel-session hazards specific to this repo

These are real collisions that have happened or can happen today.

### The dev server port is per-worktree, so it cannot be shared

`playwright.config.ts` sets `reuseExistingServer: !process.env.CI`: if a dev
server is already listening on the port, the e2e run uses it rather than
starting its own. With one fixed port, session B's suite could land on session
A's server and **test A's code** — no error, no warning.

So there is no fixed port. `dev/port.mjs` resolves it, and `vite`, Playwright
and `scripts/drive.mjs` all read the same answer:

1. `APEX_PORT`, if set (1024–65535; anything else throws).
2. 5173 in the primary checkout, so the README stays true.
3. Otherwise a port in 5200–5999 hashed from the worktree's directory name —
   the same every time for that worktree, different from any other.

`npm run -s port` prints yours. `strictPort` is on, so a taken port fails
`npm run dev` loudly instead of sliding to the next free one, which nothing
else would follow.

Never `pkill -f vite`: that is every session's server, not just yours. To
clear a stale one, `lsof -i :$(npm run -s port)` and kill that PID only.

### The local Supabase stack is shared

There is one local Postgres. `npm run e2e:live` resets whole tables, and
`playwright.config.ts` already drops live runs to `workers: 1` for that reason —
but that only serializes *within* a run, not *across sessions*. Two sessions
running live e2e will corrupt each other's fixtures.

One session at a time for `e2e:live` and `db:reset-local`.

### Migration numbers are a global counter

`supabase/migrations/phaseN_*.sql` is ordered by `sort -V` across the whole
directory, so `N` is repo-global, not branch-local. Two branches that both add
`phase33_*.sql` will not conflict in git — different filenames, no overlap — and
will both merge cleanly, leaving two migrations claiming the same slot and an
ambiguous apply order.

**Claim `N` when you open the PR, not when you start work**, and check what is
taken across every branch rather than just the one you are on:

```bash
scripts/next-phase.sh
```

It prints the next free number and lists any claim that is not yet on `main` —
those are the ones you can still collide with.

If someone takes your number first, rename before merging. Renaming an unmerged
migration is free; two live `phase33`s are not.

A test enforces this, so you cannot merge past it by forgetting. CI runs against
the pull_request *merge* commit, so the second PR to claim a number goes red
before it lands, while renaming still costs nothing:

```
AssertionError: two migrations claim one phase number, so their apply order is
decided by filename rather than by intent — rename one (scripts/next-phase.sh)
  phase33: phase33_alpha_adds_column.sql, phase33_zebra_reads_column.sql
```

What that protects you from is quiet rather than loud. Two migrations in one slot
never error: `db-reset-local.sh` applies the directory in `sort -V` order, which
is deterministic but decided by the filename suffix, and production is applied by
hand through the Supabase SQL Editor in whatever order someone pastes. Both
orders are stable, neither was chosen, and they can disagree. If one migration
adds a column the other reads, a database built from scratch is silently wrong on
whichever side lost the coin toss.

`phase3` is grandfathered: `enable_rls` and `recurrence_rule` are independent and
have already run everywhere, so renaming them would buy nothing.

## Repo settings this assumes

- **Auto-delete head branches on merge: on.** Without it, every merged PR leaves
  a remote branch behind forever.
- **Squash merge only.** Rebase and merge-commit are disabled, so `main` stays
  one commit per PR and "is this branch merged?" has an unambiguous answer.
- **`main` protected**, requiring the CI check and blocking force-pushes.

## What went wrong, once

The primary checkout was left sitting on `canonical-origin`, a branch that had
already been merged into `main` months earlier. Because it was never returned to
`main`, it became a scratch pad. Over time four separate features were assembled
in it by copying files in from other worktrees.

By the time anyone looked, it held 44 modified files:

- 31 were byte-identical copies of work already committed on `main` or on one of
  the open PR branches — pure noise, but indistinguishable from real work
  without a file-by-file comparison against every branch.
- 4 were a genuine, unlanded bug fix that existed **nowhere else in the repo** —
  no branch, no stash, no remote. One `git clean -fd` from being gone.
- 1 was a silent revert: the working copy still had the old inline `setTimeout`
  debounce in `ScheduleContext.tsx`, while `main` had since extracted it into
  `useDebouncedReload`. Committing that tree anywhere would have quietly undone
  the refactor, and the diff would have looked like an intentional change.

The 44 files also changed *while they were being analysed*, because a second
session was working in the same checkout.

Every rule above exists to make one of those four outcomes impossible.
