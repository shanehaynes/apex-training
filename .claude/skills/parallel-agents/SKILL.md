---
name: parallel-agents
description: Orchestrate subagents and parallel Claude sessions so they never corrupt each other's work — isolated worktree per writing lane, a shared-resource inventory, self-contained briefs, structured reports, a proof that lanes combine before anything merges, and cleanup. Use this skill EVERY time you are about to use the Agent/Task tool, a Workflow, a fleet of sessions, or any fan-out — including read-only research fan-outs (light path) — and whenever the user says "in parallel", "spin up agents", "fan out", "several sessions", "worker agents", "one agent per issue", or asks you to coordinate, merge or clean up work that other agents produced. Also use it when another session may be working in the same repository at the same time.
---

# Parallel Agents

Parallel agents are fast because their contexts are separate. They go wrong
at exactly the places where their contexts are *not* separate: the working
tree, the stash, the dev port, the database, a global counter, the merge
queue, the orchestrator's own context window. So this skill is less about
agents than about **shared state** — find every piece of it, and give each one
exactly one of three treatments before the first agent launches.

The shape copies what makes hosted agent platforms (Anthropic's Managed
Agents, the orchestrator–worker research system) reliable, and maps each
piece onto a local repository:

| Hosted-platform concept | Here | Why it matters |
|---|---|---|
| **Agent** — a reusable definition: goal, tools, limits | The **lane brief** | A worker has no memory of your conversation; the brief is all it knows. |
| **Environment** — an isolated sandbox per session | A **git worktree** with its own deps, port, env | Nothing one worker does can be seen by, or destroy, another's work. |
| **Session** — a durable, inspectable record | The **branch + claim + commits + report** | State lives in git and files, not in a context window that ends. |
| **Events** — a typed stream the host consumes | The **structured lane report** | The orchestrator reads 20 lines per lane, not 2,000. |
| **Orchestrator** — plans, delegates, integrates | **You** | You alone touch shared resources, integrate, and merge. |

## Pick the path

Fan-out has a real price — Anthropic reported its multi-agent research
system used roughly 15× the tokens of a chat, against roughly 4× for a single
agent — and the merge at the end is serial whatever you do. It pays when the work is broad and
separable. It does not pay when lanes would edit the same files, when each
step needs the previous step's result, or when the whole job is smaller than
the overhead of briefing it. Say so and do it in one lane when that is the
case.

- **Light path — read-only subagents** (search, research, review, planning).
  No worktrees or claims needed. A verifier that only reads but runs builds or
  servers gets pointed at the lane it verifies, never at the primary checkout. Do
  [Brief](#4-brief) and [Collect](#6-collect) properly and skip the rest.
  The failure modes here are vague briefs, duplicated effort, and reports that
  flood your context.
- **Full path — any subagent that writes files, runs builds, starts servers,
  touches a database, or commits.** Do every step below.

If you are unsure, it is the full path. "Just a one-line fix" is how the
primary checkout became a scratchpad in the incident that started all this
([references/lessons.md](references/lessons.md)).

`<skill>` below means this skill's base directory. If the project already has
its own equivalents (a worktree script, a lock wrapper, a combine check — look
in its `CLAUDE.md`/`CONTRIBUTING.md`), use the project's; they encode local
knowledge these portable versions lack.

## 1. Inventory shared state (once per project, then reuse)

Before the first fan-out in a project, list everything two lanes could both
touch and assign each one a treatment:

| Treatment | Meaning | Typical examples |
|---|---|---|
| **Partition** | Each lane gets its own copy | working tree, `node_modules`/venv, dev port, build/output dirs, simulators, scratch files |
| **Serialize** | One lane at a time, enforced by a lock | the local database, a fixture reset, a device, a rate-limited API, a deploy slot |
| **Orchestrator-owned** | Workers never touch it; they report and you act | the primary checkout, the merge, PR creation, global counters (migration numbers, version codes), generated/shared files, production anything |

Anything not in the table is a collision you have not found yet. Look for:
fixed ports, `reuseExistingServer`-style test settings, databases and their
reset scripts, files in the repo that every feature edits (routers, registries,
lockfiles, generated types, changelogs), sequential numbering, caches outside
the worktree, CI/deploy quotas, and CPU/RAM/devices that bound how many lanes
can actually run at once.

Write the result down where every future session will read it — the project's
`CLAUDE.md` or a `PARALLEL.md` it links — so the inventory is done once, not
per fan-out. [references/shared-resources.md](references/shared-resources.md)
has the discovery checklist and the proven mechanism for each treatment.

## 2. Plan lanes and waves

- **One lane = one worktree = one branch = one concern = one PR.** A worker
  that finds a second problem reports it; it does not fix it in the same lane.
- **Partition by file ownership, not by topic.** Name the files each lane
  owns. If two lanes must edit the same file, either sequence them, or give the
  shared edit to one lane (or to yourself) and have the others consume it.
- **Waves for dependencies.** Anything that consumes another lane's output
  (a client of a new API, a migration's reader) goes in a later wave, started
  only after the first has merged — not stacked on its branch.
- **Width = the scarcest resource, not the number of tasks.** Code-only lanes
  scale wide (a 37-lane review fleet ran fine on one Linux box); lanes that
  each need a simulator or a heavy build ran two at a time, because CPU
  contention made tests fail for reasons that were not in the code.

## 3. Provision environments (you, not the workers)

For every writing lane, you create the environment before the worker starts:

```bash
<skill>/scripts/lane.sh new feat/short-slug "files this lane owns"
```

That branches from a freshly fetched default branch, puts the worktree under
`<repo>/.claude/worktrees/` (never `/tmp`: it does not survive a reboot, and
other sessions cannot find it), installs dependencies (they are per-worktree —
nothing runs without them), records a **claim**, prints the lane's port, and
shows every other session's claim so overlap is caught before a line is
written. `lane.sh list` shows every lane and its state. If the project already
has its own equivalent (for example `scripts/git-new.sh`), use that instead.

Keep the **primary checkout** — the clone that owns `.git` — on the default
branch and clean. Read there; never build or commit there. It is the one
directory every session and every subagent shares, and a subagent's shell
often *starts* there.

## 4. Brief

Each worker gets a self-contained brief. The worker cannot see this
conversation, so everything it needs is in the brief, and anything that
matters but is missing will be guessed. Use
[references/lane-brief.md](references/lane-brief.md); its load-bearing parts:

1. **Goal and why** — the outcome and the reason, so the worker can make
   judgment calls you did not foresee.
2. **Ownership** — the files and directories it may change, and the ones it
   must not (because another lane owns them).
3. **Environment** — a `Lane: <absolute worktree path>` line (or
   `Lane: read-only` for the light path), and the rule that *every*
   shell command runs there: `cd <worktree> && …` or `git -C <worktree> …`.
   A subagent's working directory is not guaranteed to be its worktree.
4. **Allowed shared-state actions** — by default none. Serialized resources go
   through their lock; orchestrator-owned ones are reported, never done.
5. **Gate** — the exact commands that prove the lane (build, tests, lint), all
   of which must be safe to run in parallel.
6. **Done** — commit, push its own branch, and report. Do not open the PR, do
   not merge (unless you have deliberately delegated that).
7. **Report** — the schema from the brief template, as the final message.
8. **When blocked** — stop and report. A refused permission, a hook block or a
   held lock is information for you, not an obstacle to route around.

Launch all independent lanes in **one message** so they run concurrently, in
the background, and do not poll them — you are notified when each finishes.

## 5. While lanes run

Stay useful but stay out of their way: do not edit files a lane owns, do not
touch its worktree, and do not run anything that resets a serialized resource
without taking its lock. This is the time to prepare integration — draft PR
descriptions, pre-compute which lanes might collide.

## 6. Collect

Treat each report as a claim to check, not a fact:

- The SHA exists and is on the remote branch (`git ls-remote origin <branch>`).
- The worktree is clean — nothing left uncommitted that would die with it,
  including git-ignored outputs like screenshots or local config you still
  need. Copy those somewhere durable or regenerate them later on purpose.
- The "not verified" section is read and carried forward into the PR, not
  dropped. A green gate proves only what the gate runs.

Keep your own context lean: take the report, not the transcript. When you need
more, read the diff (`git -C <worktree> diff origin/main...`) rather than
asking the worker to paste it.

## 7. Integrate — prove the lanes combine before anything merges

Two branches can each merge cleanly into main and conflict with *each other*;
you find out after the first one lands unless you look first. And two branches
can merge textually and still break the build together (one tightens a lint
rule, the other adds code it rejects).

```bash
<skill>/scripts/combine-check.sh feat/a feat/b feat/c           # pairwise, textual
<skill>/scripts/combine-check.sh --check "npm test" feat/a feat/b # + fold all into one tree and run the gate
```

When a pair conflicts, **move a hunk; do not stack PRs.** Put one side's line
on the far side of an unchanged line, split an import, whatever keeps each
change off the other's lines — then re-check. Stacking (basing B on A) retargets
correctly only if A's branch is deleted in the right order; get it wrong and B
merges into A instead of main.

Then open the PRs (you, not the workers) and merge. If the repo requires
branches to be up to date, N PRs are N serial rounds of update → CI → merge;
update by merging main into the branch, never by rebasing a pushed branch.
The details, the "fleet" alternative, and where each proof stops are in
[references/integration.md](references/integration.md).

## 8. Retire and ratchet

- `lane.sh tidy` (dry run) then `lane.sh tidy --yes` once PRs merge: removes
  merged worktrees and branches, prunes claims. It never removes a dirty
  worktree or one with no commits yet (that is a lane that just started).
- Update whatever status board the project keeps, so the next session
  inherits the state rather than rediscovering it.
- **Ratchet every surprise into a mechanism.** A lesson kept as prose gets
  broken again by the next session that did not read it. The progression that
  worked: incident → written rule → script that makes the right way the easy
  way → hook that blocks the wrong way. See
  [references/guardrails.md](references/guardrails.md) for what to block and
  how to write the hook so it does not block the legitimate neighbours.

## Rules that hold on every path

- **Never throw away work you have not looked at.** In a shared repository,
  `git status` may be showing another session's only copy of something. Look
  before `reset --hard`, `clean -f`, `checkout -- .`, `restore`, `branch -D`,
  `worktree remove --force`, `push --force`. The stash is one stack shared by
  every worktree: push it only with a unique message and apply it by SHA,
  never `pop`. Prefer a WIP commit.
- **Never copy files between branches or worktrees.** Merge or rebase. Copied
  files carry no ancestry, so nothing can tell you that you just silently
  reverted someone's refactor.
- **Never kill processes by name** (`pkill -f vite`) — that is every lane's
  server. Kill the PID on your own port.
- **Workers never expand their own authority.** No agent merges changes to CI,
  merge policy, permissions, hooks, or the automation itself; those wait for a
  human.
- **Declare every lane.** When `hooks/agent-guard.mjs` is wired (see
  [references/guardrails.md](references/guardrails.md)), a subagent that can
  write is refused unless its brief has a line `Lane: <abs worktree path>`,
  `Lane: read-only`, or `Lane: none — <reason>`, or it launches with
  `isolation: "worktree"`. Put the line in every brief even where the hook is
  not installed; it forces the one decision that matters most.
- **Say what was not proven.** Every report and PR names what its gate does
  not cover. The worst failures in the source project were merges that every
  check passed, because no check compiled the thing that broke.
