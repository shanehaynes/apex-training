---
name: new-dev-project
description: Start a new software project so it is ready on day one for real work by several Claude sessions and subagent fleets — step-0 stakes, repo and stack, CLAUDE.md with a shared-state inventory, the parallel-agents skill vendored and its hooks wired, one parallel-safe gate command, CI, merge settings, envs and deploy, a status board and a decision log. Use this skill EVERY time a new project, repo, app, service or package begins — "start a new project", "new repo", "scaffold an app", "let's build X from scratch", "init this project", "set up a monorepo package for Y", or when the user opens an empty or near-empty directory/repo and asks to build something in it — even if they never say "project" and only describe the thing they want built. Also use it for a new app or workstream inside an existing repo (light path). Not for one-off scripts, notebooks, or a new feature/component/branch in an existing codebase.
---

# New Development Project

A new project is the one moment when structure is nearly free. Every mechanism
below costs minutes on an empty repo and days to retrofit into a live one —
the parallel-agents lessons ledger is mostly a record of retrofits. So this
skill front-loads the *structure* (where state lives, how work is gated, how
it merges, where decisions are written) and defers everything that depends on
facts the project does not have yet.

It is built on the **parallel-agents** skill and never restates it. Wherever a
step below says "parallel-agents", read that skill's relevant part and follow
it; the project gets a vendored copy in step 3, after which read that copy.

## Paths

- **Full path** — a new repository, or an empty/near-empty directory that will
  become one. Do every step.
- **Light path** — a new app, package or workstream inside an existing repo
  (an `ios/` port, a new service in a monorepo). The repo already has its
  rules; read its `CLAUDE.md`/`CONTRIBUTING.md` and follow them. Do step 0,
  then only: add the new part's rows to the existing shared-state inventory
  (new ports, new databases, new generated files, new numbered files), fold its
  checks into the existing gate, add a `CLAUDE.md` section and a status-board
  row, and write the decision record for its stack. Do not re-vendor
  parallel-agents or add a second CI pipeline.
- **Not this skill** — a throwaway script, a notebook, a spike the user says
  will be deleted. Say so in one line and just build it.

## Step 0 — Settle the stakes (ask; do not assume)

Everything later scales with four answers. Ask them together, briefly, with
your guess for each so the user can just confirm:

1. **Lifespan**: throwaway · prototype (weeks) · product (months+).
2. **Who works on it**: the user alone · the user plus parallel Claude
   sessions/fleets · other humans too.
3. **Data**: none · the user's own · other people's (accounts, PII, payments).
4. **Reach**: local only · shared with a few people · public/deployed.

Also get: a one-sentence purpose, a name, and whether the default stack fits
(see [references/default-stack.md](references/default-stack.md) — the user's
proven stack, with the reasons and the cases where it does not fit).

Write the answers as the first decision record (step 7). Every day-0 item below
exists at every level; the answers set how much of it gets built. A throwaway-
leaning prototype still gets a `STATUS.md` — three lines — and a deploy section
that says "none yet, because …". A product with other people's data gets the
full treatment of every item.

## Step 1 — Repository

1. `git init -b main` (name the branch — a bare `git init` may default to
   `master`, and `lane.sh` bases lanes on the remote's default). The first commit on `main`
   holds only the skeleton; everything after it goes through branches and PRs,
   which is what makes parallel work possible from commit two.
2. **Create the GitHub repository only after the user confirms** name, owner
   and visibility (default: private). Creating a repo is outward-facing; show
   exactly what you will create, wait for a yes, then create it with the
   GitHub tools available (MCP `create_repository`, or `gh repo create`) and
   push `main`.
   Commit as the identity git is already configured with; if none is set, ask.
   Never compose a name or email from fragments (an email's local part is not
   a surname).
3. Merge settings are chosen deliberately, not defaulted — see
   [references/ci-and-merge.md](references/ci-and-merge.md). Default for this
   user: **squash-merge only, branches must be up to date, auto-delete merged
   branches**, required status check = the CI gate job. If you cannot apply
   repo settings with your tools, hand the user the checklist from that file
   and record in `STATUS.md` that it is pending; a later session verifies it.

## Step 2 — Scaffold the stack

Scaffold with the stack's own generator (e.g. `npm create vite@latest`), not
by hand-writing boilerplate. Then apply the parallel-safety edits for that
stack, which [references/default-stack.md](references/default-stack.md) lists
concretely. The ones that matter on any stack:

- **One port resolver.** Every tool that binds or targets a port (dev server,
  test runner, scripts) reads one function, and that function delegates to
  parallel-agents' `lane.sh port` so the port a lane is told and the port its
  server binds can never disagree. Strict-port on, so a clash fails loudly.
- **No fixed global paths.** Caches, build output, scratch files and
  simulators' derived data live inside the checkout or under a per-lane path.
- **Tests never reuse a server they did not start from this checkout**, unless
  the port is per-checkout (then reuse is safe, and faster).

## Step 3 — Make parallel-agents work from day one

Read the parallel-agents skill now if you have not in this session. Then:

1. **Vendor it**: `bash <this-skill>/scripts/vendor-parallel-agents.sh <repo>`.
   This copies the installed parallel-agents skill to
   `<repo>/.claude/skills/parallel-agents/` and stamps `VENDORED` with the
   source and a content hash. The copy is needed because hooks and scripts run
   from a path inside the project — in CI, in cloud containers and on other
   machines, the user's installed skills are not there — and agent-guard's own
   messages point at that in-repo path. It is a *pinned, stamped* copy, which
   is what distinguishes it from the silent copies parallel-agents warns
   about: `scripts/check-vendored.sh <repo>` reports whether it has drifted
   from the installed skill (upstream changed) or been edited in place (local
   change). Never edit the vendored copy; improve parallel-agents at its
   source and re-vendor.
2. **Git-ignore** `.claude/worktrees/`, `.claude/state/` and
   `.claude/settings.local.json`.
3. **Wire the hooks** in `.claude/settings.json`: agent-guard as a
   `PreToolUse` hook with matcher `Agent|Task|Workflow`, exactly as
   parallel-agents' guardrails reference shows. Wire a Bash guard too if
   parallel-agents ships one (look in its `hooks/`); if it does not, add the
   Bash-guard rows from its guardrails reference to the `CLAUDE.md` rules as
   prose and list "Bash guard: not mechanized" under known gaps in `STATUS.md`.
   Do not write a project-specific guard from scratch on day 0 — a guard is
   code every session runs and needs its own tests.
4. **Lane setup**: if a fresh worktree needs anything beyond dependency
   install (pulling env from the host, generating config, codegen), write
   `.claude/lane-setup.sh`; `lane.sh new` runs it automatically. With the
   default stack it pulls env from the host (see
   [references/envs-and-deploy.md](references/envs-and-deploy.md)) — lanes
   regenerate secrets, they never copy them from another worktree.
5. **Shared-state inventory**: do parallel-agents' shared-state inventory for
   this project, using its discovery checklist and template, and write it into
   `CLAUDE.md`. On a new project most rows are *designed* rather than
   discovered — you are choosing the mechanism before the collision exists.
   Rows a new project nearly always has that are easy to miss:
   - the local database and every command that resets/seeds it → serialize
     through parallel-agents' lock script, with the lock *inside* the npm
     script, not in prose;
   - migrations → see the numbering note in default-stack.md (timestamps do
     not solve apply order);
   - `STATUS.md`, `CLAUDE.md`, route tables, lockfiles → hot files;
   - decision records → named by date and slug, never by a sequence number,
     so they are not a global counter at all;
   - host deploy quotas and preview deployments → capacity.

## Step 4 — One gate command

Define exactly one command that proves a lane — build + typecheck + unit tests
+ lint — and make it **safe to run in N worktrees at once**: no fixed port, no
shared database, no global path. Name it in `package.json` (default:
`npm run check`) or a `Makefile`. Anything that needs shared state (live e2e
against the local DB) is a *separate* command, wrapped in the lock, and listed
in `CLAUDE.md` as orchestrator-only. If part of the gate cannot run on some
machines (no SDK, no simulator) it may skip there, but it must print that it
skipped, fail instead when `CI` is set, and `CLAUDE.md` must tell lanes to list
the skip under NOT VERIFIED — a skipped check reported as a pass is the
"green union, broken platform" failure parallel-agents records. The gate is what every lane brief names,
what `combine-check --check` runs on the fold, and what CI runs — one
definition, three users, so a lane cannot pass locally and fail in CI.

## Step 5 — CI

A single workflow that runs the gate command on every PR and on `main`; its
job name is the required status check from step 1. Details and a template in
[references/ci-and-merge.md](references/ci-and-merge.md), including a small
step that fails a PR which hand-edits the vendored parallel-agents without
re-vendoring. Add jobs only when
something the gate cannot run needs proving (e2e with a browser, a second
platform) — and name in `CLAUDE.md` what CI does *not* cover.

## Step 6 — Environments, secrets, deploy

Default: the hosting provider's environment is the source of truth for
secrets; the repo holds `.env.example` (names, never values); `.env.local` is
ignored; `lane-setup.sh` pulls env into each new worktree. Choose the deploy
target now even if the answer is "none yet", and if the project deploys,
build a version endpoint on day 0 so every later deploy can be *verified* by
SHA instead of assumed. Production and the host's env settings are
orchestrator/human-owned in the inventory. Details:
[references/envs-and-deploy.md](references/envs-and-deploy.md).

## Step 7 — CLAUDE.md, STATUS.md, decision log

Write these last, because they describe what steps 0–6 built. Templates in
[references/claude-md-template.md](references/claude-md-template.md) and
[references/status-and-decisions.md](references/status-and-decisions.md).

- `CLAUDE.md`: purpose and stakes, the gate command, the rules (worktree per
  task via `lane.sh new`, never build or commit in the primary checkout, never
  copy files between branches, look before discarding), the shared-state
  inventory, what CI does not cover, and a pointer to the vendored
  parallel-agents skill for any fan-out.
- `STATUS.md`: workstreams, their claim, state and next step; pending setup
  (e.g. merge settings the user must apply); known gaps.
- `docs/decisions/YYYY-MM-DD-<slug>.md`: step 0's answers and the stack choice
  first, each with the options considered and why.

## Step 8 — Prove it, then hand off

The day-0 setup is itself a change, so it gets the same proof as any other:

1. The gate passes in the primary checkout's first commit *and* in a fresh
   lane: `lane.sh new chore/day0-proof` then run the gate there. This proves
   lane setup, dependency install and the port resolver actually work. Do this
   after `main` is pushed; if the user has deferred creating the remote, pass
   `--base main`, and retire the proof lane by hand (`git worktree remove`,
   `git branch -d`, delete its claim row) because `lane.sh tidy` needs a
   remote. Never invent a stand-in remote to satisfy a script.
2. `check-vendored.sh` reports in sync.
3. If a subagent tool is available, launch one throwaway writing subagent
   without a `Lane:` line and confirm agent-guard refuses it — the hook is
   wired only if it fires. Then retire the proof lane with `lane.sh tidy`.
4. Tell the user, briefly: what exists, what they must do by hand (merge
   settings, host env values), what was not verified, and where the next
   session starts (`CLAUDE.md` → `STATUS.md`).

## Earned tier — add when the trigger fires, not before

| Trigger | Add | Where the guidance is |
|---|---|---|
| First migration | Lock around reset/seed; migration ordering check in CI | default-stack.md |
| Two workstreams that run concurrently *and* have an ordering between them (one consumes the other's output) | Grow `STATUS.md` into a master doc + one brief per workstream, with the gate between them | status-and-decisions.md |
| First fan-out of ≥3 writing lanes | parallel-agents full path; a combine check before PRs open | parallel-agents |
| First unattended merge | A merge policy with held paths (CI, hooks, settings, deps, migrations, deploy) and a kill switch | parallel-agents guardrails reference |
| Fleets of 10+ PRs become routine | Reconsider the up-to-date rule vs fleet mode | ci-and-merge.md |
| A rule broken twice | Turn it into a script or hook (parallel-agents' ratchet) | parallel-agents |

When a trigger fires in a later session, that session should find this table
in `CLAUDE.md` (the template carries it) — the point of deferring is that the
work still happens, at the moment it is cheapest.
