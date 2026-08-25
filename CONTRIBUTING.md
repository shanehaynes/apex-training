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
`.claude/worktrees/fix-stranded-event-dates/`, installs its dependencies, and
prints the path to `cd` into along with the dev port that worktree will use.
Run it from the primary checkout or from inside any worktree — it anchors on
the primary checkout either way, so worktrees never nest.

`--no-install` skips the `npm ci` (a docs-only change, say). Remember what it
skips: **`node_modules` is per-worktree.** Nothing in a fresh worktree — not
`tsc`, not a single test — runs until it has one, and five sessions in a row
discovering that independently is five minutes nobody needed to spend.

Do it by hand if you prefer, but keep the four invariants:

1. **Branch from current `origin/main`**, not from whatever the primary checkout
   happens to be sitting on.
2. **Worktrees live in `.claude/worktrees/<branch-with-slashes-as-dashes>`.**
   Never in `/tmp`. `/tmp` does not survive a reboot, and a scratch directory
   under one session's id is invisible to every other session — including to
   the human trying to work out where a branch went.
3. **One worktree = one branch = one PR = one concern.** If you find a second
   thing worth fixing, cut a second worktree.
4. **Install before you check.** `npm ci` in the new worktree, then
   `npm run agent:check` proves the branch point is green before you change it.

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

Run the gate, then open the PR:

```bash
npm run agent:check       # tsc -b, vitest, oxlint, playwright (mock) — what CI's check + e2e-mock jobs run
gh pr create --base main  # squash-merge it on GitHub; the remote branch auto-deletes
```

`gh` is how a session opens PRs and watches CI (`gh pr checks`,
`gh api repos/…/commits/<sha>/check-runs`). Its token needs the `workflow`
scope to push anything under `.github/workflows/` — see "Repo settings".

Squash-merge it. GitHub deletes the remote branch. Then retire the local side:

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

### Merging more than one PR

`main` requires a branch to be **up to date** before it merges (see "Repo
settings"). So the moment one PR lands, every other open PR is "out of date" —
not conflicted, just behind — and has to take the new `main` and re-run CI
before it can merge. Five parallel PRs are five serial rounds of
update → CI → merge, about ten minutes each for the `full` job, and the order
you merge them in makes no difference.

The update is a merge of `origin/main` into the branch: GitHub's **Update
branch** button, or from the worktree:

```bash
git merge --no-edit origin/main && git push
```

A merge commit on a PR branch is fine — the PR squash-merges, so the branch's
history never reaches `main`. Do not rebase a pushed branch for this; a
force-push is how one session ends up re-assembling another's work by hand.
Whoever is coordinating several PRs owns running this loop — and

```bash
scripts/merge-babysit.sh          # dry run: where every open PR sits in the loop
scripts/merge-babysit.sh --yes    # run the loop unattended until they all land
```

runs it for them: merge whatever is green and current, update-branch the rest
(GitHub's update-branch API — a merge of `main` into the branch, never a
rebase), wait for CI, repeat. PRs with conflicts or failing checks are
reported and skipped, and a PR not based on `main` is never merged — that is
the stacked-PR trap that took production down (see above about #23).

The thing that would replace the loop is GitHub's **merge queue** — press
*Merge when ready* on every green PR and the queue tests and lands each one on
the latest `main` by itself. It is **not available here**: GitHub offers it to
public repositories owned by an *organization* (and to Enterprise Cloud), and
this repository is owned by a personal account. Creating the `merge_queue`
ruleset fails validation with an empty error for exactly that reason. `ci.yml`
keeps its inert `merge_group` trigger so that if the repository ever moves to
an organization, the queue is a settings change away rather than a code one.

### Autonomous merging: what the babysitter may do alone

`scripts/merge-babysit.sh --yes` is allow-listed in
[.claude/settings.json](.claude/settings.json), so an unattended Claude
session can run the merge loop without a human pressing the button. That
authority is bounded on four sides:

- **Branch protection is the floor.** The babysitter cannot land anything the
  required CI checks have not passed — that is GitHub's rule, not the
  script's, and no autonomy change may weaken those checks.
- **The merge policy is the boundary** ([scripts/merge-policy.mjs](scripts/merge-policy.mjs)):
  a PR touching `supabase/migrations/`, `.github/`, `vercel.json`, the
  dependency manifests, or any file of the automation itself — the policy,
  the babysitter, the guard hooks, `.claude/settings.json`, every script that
  file allow-lists — is `HOLD`ed, never merged. The first principle of the
  held list: **the agent must never be able to merge an expansion of its own
  authority.** A vitest suite pins every entry, so quietly shrinking the list
  fails a test.
- **A human overrides per PR** with the `shipit` label
  (`gh pr edit N --add-label shipit`). The guard hook blocks the agent from
  applying that label itself, and blocks direct `gh pr merge` — merging flows
  through the babysitter or a human, nothing else. (A review approval cannot
  be the token: `gh` acts as the repo owner, who cannot approve their own
  PRs.)
- **The kill switch stops everything.** `touch .claude/AUTOMERGE_OFF` in the
  primary checkout; it is checked every pass, so it also halts a loop that is
  already running.

Every autonomous merge leaves two records: a comment on the PR and a line in
`.claude/state/merge-log` in the primary checkout. After a run that merged
anything, the babysitter also retires merged worktrees (`git-tidy.sh --yes`,
only when running from the primary checkout), fast-forwards the primary
checkout to the new `main`, and runs
[scripts/deploy-verify.sh](scripts/deploy-verify.sh): production must serve
the SPA and route `/api/` — the catch-all blackhole that once 404'd every API
route (PR #25) is exactly the failure CI cannot see. A failed verification is
an `ACTION` line and a non-zero exit, never a shrug.

These guards are nets against slip-ups, not walls against an adversary — a
sufficiently creative command line can get around a regex. The layers behind
them are the permission classifier, branch protection, and the fact that
every change the automation could make to itself is held for a human.

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

All three rules above are now enforced mechanically, not just by prose: a
`PreToolUse` hook (`.claude/settings.json` → `scripts/hooks/bash-guard.mjs`)
blocks builds and commits in the primary checkout, `pkill`/`killall` on vite,
and destructive git commands. For the destructive ones, review `git status`
first and then re-run the exact command prefixed with `APEX_DESTRUCTIVE_OK=1`
— the override exists so the hook makes you look, not so it stops you.

## Parallel-session hazards specific to this repo

These are real collisions that have happened or can happen today.

### Declare what you are working on

Sessions cannot see each other's uncommitted changes, but they can see
declared intent. `git-new.sh` records one line per worktree in the primary
checkout's `.claude/state/claims.tsv` — branch, when, where, and an optional
free-text intent:

```bash
scripts/git-new.sh feat/coach-tools "touching src/lib/coach/* and prompt.ts"
```

It prints every other session's claim when it cuts your worktree — the
moment overlap is cheapest to avoid. If another claim names the files you
are about to change, coordinate (smaller hunks, different files) or wait;
two branches editing the same lines merge cleanly into `main` and then
conflict with *each other* (see "Several branches in flight" below).

The registry is metadata, never work: `git-tidy.sh` prunes claims whose
worktree is gone, and `supervisor-report.sh` flags claims older than a week
or pointing at nothing. Trust it as a hint, not as a lock — a session that
started by hand may not have claimed anything.

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

The stack is also **not kept current for you**. `supabase start` only
auto-applies timestamped migrations and this repo's are `phaseN_*.sql` (see
below), so the local database has exactly the schema of the last
`npm run db:reset-local` — which can be several migrations behind `main`
without anything saying so. Before trusting it (live e2e, `npm run db:types`),
check: `scripts/db-types.sh --check` passing means the committed types match
the local schema, which means the schema is current. If it is behind, reset
it. An unattended (auto-mode) session is refused the reset by the permission
classifier — a destructive action on a shared resource — so that is a human's
job; the session should say so rather than work from a stale database.

### Several branches in flight: prove they combine before the PRs open

Two branches that edit adjacent lines of the same file each merge cleanly
against `main` and conflict with *each other*, and with the flow above you find
out after the first one lands. `git merge-tree` is a three-way merge that
touches no working tree:

```bash
git fetch origin
git merge-tree --write-tree --name-only origin/feat/a origin/feat/b
# exit 1 and "CONFLICT (content): …" lines if they collide; a tree id if not
```

Run it on every pair. When a pair conflicts, **move one hunk; do not stack the
PRs.** Put the new script line on the far side of an unchanged line, the type
import first and the value import second — whatever keeps each side's change
off the other's lines — and re-check. Stacking (basing B on A) only retargets
B to `main` if A's branch is deleted in the right order, which is how #23
merged into its base branch instead of `main` and took production down.

To prove N branches combine — textually *and* semantically — fold them into a
throwaway commit and run the checks on that:

```bash
cur=$(git rev-parse origin/feat/a)
for b in feat/b feat/c; do
  tree=$(git merge-tree --write-tree "$cur" "origin/$b")            # fails loudly on conflict
  cur=$(git commit-tree "$tree" -p "$cur" -p "origin/$b" -m "throwaway")
done
git worktree add --detach .claude/worktrees/_combined "$cur"
(cd .claude/worktrees/_combined && npm ci && npm run agent:check)
git worktree remove --force .claude/worktrees/_combined
```

A clean textual merge can still fail to build — one branch tightens lint,
another adds code the new rule rejects — and this is the only check that sees
it before the last PR merges.

Both checks are scripted:

```bash
scripts/combine-check.sh                  # every open PR branch, pairwise merge-tree
scripts/combine-check.sh feat/a feat/b    # specific branches
scripts/combine-check.sh --check          # + fold into a combined tree, run agent:check on it
```

### One session coordinating several agents

Fanning one task out to parallel agents works with the rules above unchanged —
one worktree, one branch, one PR per agent — plus a division of labour:

- **The coordinating session owns every shared resource.** It cuts the
  worktrees (`git-new.sh`), it alone touches the local Supabase stack and the
  primary checkout, and it runs the cross-branch checks above before the PRs
  open and the merge loop after.
- **Agents verify with `npm run build`, `npm test`, and `npm run lint`**, all
  per-worktree and safe in parallel. `npm run e2e` is fine too now that ports
  are per-worktree; `e2e:live`, `db:reset-local`, and the integration suites
  are not — they need the shared stack.
- **Agents commit and push their own branch and report the SHA**; the
  coordinator opens the PRs. An agent refused a shared-resource action by its
  permission mode should report that, not route around it.

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

### The schema types are generated, and checked

`src/lib/db/database.types.ts` is generated from the real schema and types
both Supabase clients; `src/lib/db/types.ts` derives the app's row types from
it, so the column set of every row type comes from the database rather than
from memory. A column a migration dropped or renamed fails `tsc`, not a
production query.

That only holds while the file is current. After adding a migration:

```bash
npm run db:reset-local   # build the local database from every migration
npm run db:types         # regenerate the types from it
```

and commit the result with the migration. CI's **full** job runs
`scripts/db-types.sh --check` against a database it has just built from
scratch, and goes red if the committed file differs by a byte. The CLI
version is pinned in the script because the generator's output changes
between releases — bump it deliberately, regenerating in the same PR.

## Repo settings this assumes

- **Auto-delete head branches on merge: on.** Without it, every merged PR leaves
  a remote branch behind forever.
- **Squash merge only.** Rebase and merge-commit are disabled, so `main` stays
  one commit per PR and "is this branch merged?" has an unambiguous answer.
- **`main` protected**, requiring the `check`, `e2e-mock`, and `full` jobs,
  blocking force-pushes, and **requiring branches to be up to date before
  merging**. That last one is what makes parallel PRs merge serially — see
  "Merging more than one PR".
- **No merge queue — not by choice.** GitHub only offers it to
  organization-owned public repositories and Enterprise Cloud; a
  personal-account repository cannot enable it. If the repository is ever
  transferred to an organization, create a ruleset on `main` with a
  `merge_queue` rule (squash, `min_entries_to_merge: 1`, up to five built in
  parallel, `ALLGREEN`, 60-minute check timeout) and the loop above goes away;
  `ci.yml` already listens for `merge_group`.
- **A `gh` login with the `repo` and `workflow` scopes.** Pushing a branch
  that touches `.github/workflows/` is rejected without `workflow`. Git's
  credential helper calls `gh` by absolute path, so pushes keep working even
  from a shell where `gh` itself is off the `PATH` — which is also why
  "`gh: not found`" and "my push worked" are not a contradiction.

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
