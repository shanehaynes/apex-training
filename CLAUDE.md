# Apex Training

Personal training app: React + Vite front end, Vercel serverless API under
`api/`, Supabase (Postgres + RLS) for data. Full workflow rules are in
[CONTRIBUTING.md](CONTRIBUTING.md) — the essentials are here because they are
easy to get wrong and expensive to get wrong.

## Several sessions may be running right now

More than one Claude session works in this repo at once, and none of them can
see each other's uncommitted changes. Assume you are not alone.

### Never work in the primary checkout

`~/projects/apex-training` stays on `main`, clean, always. Read code there; do
not build there, do not commit there.

Start every task — including one-line fixes — with:

```bash
scripts/git-new.sh fix/short-slug     # types: feat/ fix/ chore/ db/
```

That branches from a freshly-fetched `origin/main` and creates a worktree under
`.claude/worktrees/`. **Never put a worktree in `/tmp`**: it does not survive a
reboot, and other sessions cannot find it.

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
  `npm run e2e:live` and `npm run db:reset-local` reset whole tables.
- **Migration numbers.** `supabase/migrations/phaseN_*.sql` is ordered by
  `sort -V` across the directory, so `N` is repo-global. Two branches can both
  add `phase33_*.sql`, merge cleanly, and leave an apply order nobody chose. Run
  `scripts/next-phase.sh` and claim `N` when you open the PR, not when you
  start. A test fails the second PR to claim a number, but only once the first
  has merged — the script is how you avoid the rename.

## Checks

```bash
npm run agent:check     # tsc -b + vitest + playwright (mock)
npm test                # vitest only
npm run build           # tsc -b + vite build — what CI runs
```

CI runs build, test, lint, a guard on the root-level `api/*.ts` count (new
handlers belong in `api/_lib/handlers/`, behind the Hono router), and
`npm audit --omit=dev`.

## Commits

Commits and PRs land as Shane alone — no co-author trailers, no attribution.
