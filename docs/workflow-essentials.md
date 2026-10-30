# Workflow essentials

How work lands in Apex Training: React + Vite front end, Vercel serverless API
under `api/`, Supabase (Postgres + RLS) for data. Loaded into every session by
`CLAUDE.md`, beside [MISSION.md](../MISSION.md), which says what Apex
is and will not do. These are the rules that are easy and expensive to get
wrong; the procedures and the history behind them are in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## iOS app

A native SwiftUI port is planned and documented in [docs/ios/MASTER.md](ios/MASTER.md).
Any iOS or iOS-driven backend work starts there (it has its own session protocol and a status
board); the `ios/` directory holds the app once workstream W1 lands.

## Progressive onboarding

The intro, the first-encounter tips and the `/help` pages are one initiative with its own
board: [docs/onboarding/MASTER.md](onboarding/MASTER.md). Any onboarding, tips or help
work starts there — it names which files each lane owns, and `src/styles/app.css`,
`content.ts` and `tips/index.ts` are off-limits to feature lanes.

## Several sessions may be running right now

More than one Claude session works in this repo at once, and none of them can
see each other's uncommitted changes. Assume you are not alone.

Before launching any subagent or workflow, follow the
[parallel-agents skill](../.claude/skills/parallel-agents/SKILL.md). In this repo,
its portable scripts give way to the ones named below (`git-new.sh`,
`git-tidy.sh`, `combine-check.sh`, `with-stack-lock.sh`). A second
`PreToolUse` hook (`.claude/skills/parallel-agents/hooks/agent-guard.mjs`)
refuses a subagent that can write unless its brief has a line of its own
declaring the lane: `Lane: <absolute worktree path>`, `Lane: read-only`, or
`Lane: none — <reason>` (e.g. merge-shepherd, which runs from the primary),
or it launches with `isolation: "worktree"`. Explore/Plan-style agents pass
without one.

### Never work in the primary checkout

The primary checkout — the clone that owns `.git`, not a worktree — stays on
`main`, clean, always. Read code there; do not build there, do not commit there.

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
- **Production's schema.** Migrations reach production by hand, so a skipped
  one is invisible until something 500s. `node scripts/prod-schema-check.mjs`
  runs before and after every production migration: before, anything missing
  that is not the migration being applied is an older gap, applied first in
  phase order; after, exit 0. The babysitter HOLDs a migration PR until
  production matches `main` and has the PR's own migration applied — DDL
  first, then the merge — `shipit` or not. Every migration's last
  statement stamps its name and SQL fingerprint into `public.migration_ledger`
  (phase56; `prod-schema-check.mjs --stamp <file>` prints it), so the check
  names any migration production never finished or ran as different SQL,
  even one that only changes policies. A CI test fails a missing stamp and
  any SQL edit to a migration already on `main`: change one with a new one.
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
npm run agent:check     # build + vitest + oxlint + playwright (mock) + ci:guards — the gate, same as CI
npm test                # vitest only
npm run build           # tsc -b + vite build
```

**Stopping is gated.** A session that cut a lane with `git-new.sh` cannot end
its turn while that lane is dirty, red (`agent:check`), or unpushed — a Stop
hook (`scripts/hooks/stop-gate.mjs`) refuses with the reason. At an ambiguity
that does not change the design: decide, log it (DECISIONS in your report, or
the board's decisions file), continue. Stop early only for an irreversible
action or a design-changing ambiguity, and then run
`scripts/stop-gate.sh blocked "<reason>"` first so the stop is on the record
(CONTRIBUTING.md, "Stopping is gated").

CI runs build, test, lint, and `npm run ci:guards` — the root-level `api/*.ts`
count (new handlers belong in `api/_lib/handlers/`, behind the Hono router)
plus `npm audit --omit=dev`. `agent:check` runs the same guards, so a branch
cannot pass locally and fail those in CI. A nightly scheduled run re-proves
`main` from scratch and runs the coach evals; `scripts/supervisor-report.sh`
prints everything that needs attention (main status, stack drift, production
schema drift, last nightly backup, stale worktrees, open PRs) in one read-only
sweep.

A `PreToolUse` hook ([.claude/settings.json](../.claude/settings.json) →
`scripts/hooks/bash-guard.mjs`) mechanically blocks the three rules above that
used to be prose only: killing vite by name (`pkill`/`killall`, or a `kill`
handed every pid `pgrep`/`pidof` finds for it — `lsof -ti :$(npm run -s port) |
xargs kill` stays fine, the port is yours), commands that throw work away
without a copy, and building or committing in the primary checkout. The
destructive set is `git reset --hard`, `git clean -f`, `git checkout -- <path>`
/ `.` / `-f`, `git restore` (not `--staged`), `git stash drop`/`clear`, a
bare `git stash` / `push` without `-m`, `git stash pop`, and `git stash apply`
with no ref (the stack is shared with every worktree, so an entry you cannot
name may be another session's — tag it: `git stash push -u -m "<unique-tag>"`,
`git stash list --format='%H %gs'`, `git stash apply <sha>`), `git branch -D`,
`git worktree remove --force`, and `git push --force`/`-f`/`+ref`/`--mirror`
(`--force-with-lease` stays allowed). Look first, then re-run with `APEX_DESTRUCTIVE_OK=1`
immediately in front of that one git command — it covers that command only, not
the rest of the line, and not a shell it launches. The hook parses the command,
so a guarded name that is only *mentioned* — in a commit message, a PR body, a
`grep` pattern, a quoted heredoc body — is data and does not block; `bash -c`,
`eval`, `$(…)` and heredocs fed to a shell are followed as code. It judges each
command by the directory it would actually run in: a chain that opens with
`cd <worktree>`, or a `git -C` / `xcodebuild -project` naming one, builds there
even when the shell's cwd is the primary — which is every subagent's cwd.

## Specs, skills and review

- **Every feature gets three documents.** Before any code, a discrete
  feature (defined under Replanning below) gets a folder `docs/specs/<slug>/`
  copied from `docs/specs/_template/`:
  - `requirements.md`: what ships and why; numbered requirements R1, R2…
  - `plan.md`: how, in milestones, each naming the requirements it delivers.
  - `validation.md`: the proof for every requirement, decided before the code.

  The session instruction is then "implement until every milestone box is
  checked and every requirement is proven", one PR per milestone,
  `scripts/merge-babysit.sh --yes` between milestones. A one-PR feature still
  gets all three; they can be short. Board work (`docs/ios/`,
  `docs/onboarding/`) puts the three in the board's workstreams folder. Specs
  written before this rule (the single-file ones in `docs/specs/`) are not
  converted.
- **Every lane report and every board session ends with a drafted next
  brief** (NEXT BRIEF in the report; "Next up" on a board as a paragraph, not
  a one-liner). Shane edits a draft; he does not write one from blank.
- **Before `gh pr create`, launch the `reviewer` agent** on the feature's
  three documents plus `git diff origin/main...HEAD` — never your own explanation — and paste its
  report into the PR body under `## Review` with one line per finding (fixed
  in <sha> | not fixed because). Shane reads the review, then skims the diff.
- **Skills and agents by task**, so none depends on description matching:
  running, screenshotting or driving the app → `run-apex-training` skill;
  proving a UI or API change works in the real app → `app-verifier` agent;
  any coach prompt, model or tool change → `eval-analyst` agent, before it
  ships; landing or shepherding PRs, repo health → `merge-shepherd` agent;
  any fan-out → parallel-agents (the `agent-guard` hook injects it).

## Replanning

Every discrete feature that ships is followed by a replan, before the next
feature starts. A discrete feature is a user-visible capability (a screen, a
flow, an integration, a coach ability), whether it takes one PR or ten; a
board workstream counts. It has shipped when its last milestone has merged.
Bug fixes and chores are not features: no three documents, no replan.

The session that shipped the feature runs the replan and opens one PR,
`Replan after <feature>`, with whatever the work taught:

1. **Roadmap.** Mark the feature shipped, reorder Now / Next / Later from what
   shipping it revealed, and draft the next brief.
2. **Tech stack.** Propose a row change if a choice proved wrong, a dependency
   arrived, or an exit was reached (for example, 30 active iOS users).
3. **Mission.** Never edited in a replan. If the work exposed a conflict with
   an article, the PR names the article and the conflict for Shane.
4. **Workflow.** Propose a change to this file or `CONTRIBUTING.md` for any
   rule that was missing, cost time without catching anything, or was
   followed only by luck.
5. **Lessons.** Record anything else learned in the PR body under
   `## Learned`, one line each, so the next replan can see the trend.

The constitution files are held, so a replan PR waits for Shane's `shipit`.
A replan that finds nothing to change says so in one line on the feature's
PR instead of opening an empty one.

## Commits and merging

Commits and PRs land as Shane alone — no co-author trailers, no attribution; the
`attribution` block in [.claude/settings.json](../.claude/settings.json) enforces
that for every session rather than leaving it to each one to remember.
Open PRs with `gh pr create`. `main` requires branches to be up to date, so
once one PR merges every other open PR needs `git merge origin/main && git push`
and a fresh CI run before it can merge (CONTRIBUTING.md, "Merging more than
one PR") — `scripts/merge-babysit.sh --yes` runs that loop and never touches
a PR that isn't based on `main`. Before opening several PRs at
once, prove they combine with `scripts/combine-check.sh` (pairwise
`merge-tree`; `--check` also builds the combined tree and runs `agent:check`
on it).

The babysitter is the only merge path, and it merges only what
`scripts/merge-policy.mjs` allows. Exactly two invocations are allow-listed
in `.claude/settings.json` and run without a prompt: `scripts/merge-babysit.sh
--yes` and `scripts/merge-babysit.sh --fleet --yes` (any other flag, e.g.
`--no-check`, still prompts). The policy holds that file, so widening the grant
is Shane's call. Migrations, `.github/`, `scripts/ci-guards.sh`, `vercel.json`,
dependency manifests, the iOS release surface (`ios/fastlane/`, `ios/scripts/`,
`ios/project.yml`, `ios/Config/`, the entitlements, the `Info.plist`s and
`PrivacyInfo.xcprivacy`), every file of the automation itself, and the constitution (`MISSION.md`, `TECHSTACK.md`, `ROADMAP.md`) with the files that load it (`CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`) are HELD for
Shane, who grants one PR with the `shipit` label; the guard hook blocks
`gh pr merge` and self-applied `shipit`, so the babysitter is the only merge
path. Kill switch: `touch .claude/AUTOMERGE_OFF` in the primary checkout.
Full rules: CONTRIBUTING.md, "Autonomous merging".
Dependency bumps of names already present are not held: every lockfile entry
must be the registry tarball of the name it installs, and no package may newly
gain an install script (`manifestHold`, `lockfileHold`).
