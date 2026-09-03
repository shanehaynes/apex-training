# Apex Training

Personal training app: React + Vite front end, Vercel serverless API under
`api/`, Supabase (Postgres + RLS) for data. Full workflow rules are in
[CONTRIBUTING.md](CONTRIBUTING.md) — the essentials are here because they are
easy to get wrong and expensive to get wrong.

## iOS app

A native SwiftUI port is planned and documented in [docs/ios/MASTER.md](docs/ios/MASTER.md).
Any iOS or iOS-driven backend work starts there (it has its own session protocol and a status
board); the `ios/` directory holds the app once workstream W1 lands.

## Several sessions may be running right now

More than one Claude session works in this repo at once, and none of them can
see each other's uncommitted changes. Assume you are not alone.

### Never work in the primary checkout

`~/projects/apex-training` stays on `main`, clean, always. Read code there; do
not build there, do not commit there.

Start every task — including one-line fixes — with:

```bash
scripts/git-new.sh fix/short-slug "what you will touch"   # types: feat/ fix/ chore/ db/
```

That branches from a freshly-fetched `origin/main`, creates a worktree under
`.claude/worktrees/`, and runs `npm ci` there — `node_modules` is per-worktree
(`--no-install` skips it). It works from inside any worktree too. **Never put a
worktree in `/tmp`**: it does not survive a reboot, and other sessions cannot
find it.

The second argument is your claim: it lands in `.claude/state/claims.tsv`,
and `git-new.sh` prints every other session's claim back at you. If one
names the files you are about to change, coordinate before you overlap
(CONTRIBUTING.md, "Declare what you are working on").

When your PR merges, retire the branch and worktree:

```bash
scripts/git-tidy.sh          # dry run
scripts/git-tidy.sh --yes    # apply
```

### Before deleting anything, look

`git status` in a shared checkout may be showing another session's only copy of
its work. Never `git reset --hard` or `git clean -fd` without reading the file
list first. If it holds something that exists nowhere else, commit it to a
branch before you clean.

### Never copy files between branches or worktrees

If branch B needs branch A's code, merge or rebase. Copied files carry no
ancestry, so nothing can tell you whether you have just reverted somebody's
refactor — which is exactly what happened once (see CONTRIBUTING.md).

## Shared resources — one session at a time

- **The dev port is per-worktree.** `dev/port.mjs` gives the primary checkout
  5173 and each worktree its own port in 5200–5999; `vite`, Playwright and
  `scripts/drive.mjs` all read it, so an e2e run can only ever reuse a server
  from its own checkout. `npm run -s port` prints yours; `APEX_PORT` overrides.
  Never `pkill -f vite` — that is other sessions' servers too. To clear a stale
  one, `lsof -i :$(npm run -s port)` and kill that PID only.
- **The local Supabase stack.** One Postgres for the whole machine.
  `npm run e2e:live` and `npm run db:reset-local` reset whole tables; both
  take a machine-wide lock (`scripts/with-stack-lock.sh`), so a second
  session queues behind the first instead of corrupting it. The stack is
  not auto-migrated either: it has the schema of the last reset, which can lag
  `main` — `scripts/db-types.sh --check` tells you. Auto-mode sessions are
  refused the reset; ask rather than work from a stale schema.
- **Migration numbers.** `supabase/migrations/phaseN_*.sql` is ordered by
  `sort -V` across the directory, so `N` is repo-global. Two branches can both
  add `phase33_*.sql`, merge cleanly, and leave an apply order nobody chose. Run
  `scripts/next-phase.sh` and claim `N` when you open the PR, not when you
  start. A test fails the second PR to claim a number, but only once the first
  has merged — the script is how you avoid the rename.
- **Generated schema types.** Both Supabase clients are typed by
  `src/lib/db/database.types.ts`, generated from the local stack. After any
  migration: `npm run db:reset-local && npm run db:types`, commit the result.
  CI's full job fails on drift.

## Checks

```bash
npm run agent:check     # tsc -b + vitest + oxlint + playwright (mock)
npm test                # vitest only
npm run build           # tsc -b + vite build — what CI runs
```

CI runs build, test, lint, and `npm run ci:guards` — the root-level `api/*.ts`
count (new handlers belong in `api/_lib/handlers/`, behind the Hono router)
plus `npm audit --omit=dev`. `agent:check` runs the same guards, so a branch
cannot pass locally and fail those in CI. A nightly scheduled run re-proves
`main` from scratch and runs the coach evals; `scripts/supervisor-report.sh`
prints everything that needs attention (main status, stack drift, stale
worktrees, open PRs) in one read-only sweep.

A `PreToolUse` hook ([.claude/settings.json](.claude/settings.json) →
`scripts/hooks/bash-guard.mjs`) mechanically blocks the three rules above that
used to be prose only: `pkill` on vite, `git reset --hard`/`git clean -f`
(after reviewing `git status`, prefix the command with `APEX_DESTRUCTIVE_OK=1`
to proceed), and building or committing in the primary checkout.

## Commits and merging

Commits and PRs land as Shane alone — no co-author trailers, no attribution.
Open PRs with `gh pr create`. `main` requires branches to be up to date, so
once one PR merges every other open PR needs `git merge origin/main && git push`
and a fresh CI run before it can merge (CONTRIBUTING.md, "Merging more than
one PR") — `scripts/merge-babysit.sh --yes` runs that loop unattended and
never touches a PR that isn't based on `main`. Before opening several PRs at
once, prove they combine with `scripts/combine-check.sh` (pairwise
`merge-tree`; `--check` also builds the combined tree and runs `agent:check`
on it).

The babysitter is allow-listed and may merge without a human — but only what
`scripts/merge-policy.mjs` allows. Migrations, `.github/`, `vercel.json`,
dependency manifests, and every file of the automation itself are HELD for
Shane, who grants one PR with the `shipit` label; the guard hook blocks
`gh pr merge` and self-applied `shipit`, so the babysitter is the only merge
path. Kill switch: `touch .claude/AUTOMERGE_OFF` in the primary checkout.
Full rules: CONTRIBUTING.md, "Autonomous merging".
