---
name: parallel-agents
description: Orchestrate subagents and parallel Claude sessions so they never corrupt each other's work — isolated worktree per writing lane, a shared-resource inventory, self-contained briefs, structured reports, a proof that lanes combine before anything merges, and cleanup. Use this skill EVERY time you are about to use the Agent/Task tool, a Workflow, a fleet of sessions, or any fan-out — including read-only research fan-outs (light path) — and whenever the user says "in parallel", "spin up agents", "fan out", "several sessions", "worker agents", "one agent per issue", or asks you to coordinate, merge or clean up work that other agents produced. Also use it when another session may be working in the same repository at the same time.
---

# Parallel Agents

Parallel agents are fast because their contexts are separate. They go wrong
where their contexts are *not* separate: the working tree, the stash, the dev
port, the database, a global counter, the merge, and your own context window.
So this skill is mostly about **shared state**, plus one rule about how
information moves: **you are the only channel between lanes, and nothing
crosses it unchecked.**

`<skill>` below is this skill's base directory. If the project has its own
equivalents (a worktree script, a lock wrapper — see its `CLAUDE.md`), use
those.

**Resuming?** If `<primary>/.claude/state/fleet/ledger.jsonl` exists, a fleet
may be in flight: run `node <skill>/scripts/fleet.mjs resume` and follow
[references/fleet-state.md](references/fleet-state.md#resuming-a-fleet-what-a-successor-session-does-first)
before planning anything.

## Pick the path

Fan-out costs tokens (a multi-agent system can use ~15× a chat) and the merge
is serial whatever you do. It pays when work is broad and separable; it does
not when lanes would edit the same files, when each step needs the previous
one's result, or when the job is smaller than briefing it. Say so and do it in
one lane.

### Light path: every worker only reads (search, research, review, planning)

This is complete on its own — if no worker writes files, builds, starts
servers, touches a database or commits, **skip from here to "Rules that hold
on every path" at the end.**

1. **Disjoint scopes.** Split by directory, source or hypothesis, never by
   "look into X" twice. Overlap is the main waste: three workers find the same
   file and report it three times.
2. **One brief per worker**, launched together in one message:
   ```markdown
   Lane: read-only
   ## Question
   {{QUESTION: the specific thing to find out, and why it matters}}
   ## Scope
   Look in: {{SCOPE}}. Do not edit files, build, or start servers.
   Depth: {{DEPTH: quick scan | thorough}}. Stop when: {{STOP_WHEN}}.
   ## Already known (do not re-derive)
   {{KNOWN}}
   ## Report
   Summary first, at most {{N}} lines: conclusions first, each with file:line
   or URL evidence. Separate what you verified from what you infer. Say what
   you did not check. You may be asked follow-up questions: keep your notes.
   ```
   Fill every `{{SLOT}}`; the guard hook refuses a brief with one left.
3. **Collect in two phases.** Read each short report; when you need more, ask
   *that worker* one precise question (continue it, e.g. SendMessage) instead of
   asking everyone for long reports up front. Your context should grow with
   what you need to know, not with the number of workers.
4. **Reports are claims.** Check the ones your answer depends on before you
   repeat them, and never forward one worker's finding to another as fact.

A verifier that only reads but runs builds or servers is **not** light path:
it needs its own worktree (full path, step 3).

### Full path: any worker writes, builds, serves, touches a database, or commits

Do every step below. If unsure, it is the full path — "just a one-line fix" is
how the primary checkout became a scratchpad in the incident that started all
this ([references/lessons.md](references/lessons.md)).

## The channel rule (independence)

Workers never message each other, read each other's branches, worktrees or
reports, or build on each other's unmerged output. Everything that will become
another agent's premise passes through you, and you check it first — logging
a claim is not checking it. Concretely:

- **Relay** only facts you have checked, only to the live lanes they affect,
  with their source. Never broadcast.
- **Independent lanes** — verifier, reviewer, judge, spec, adjudicator, and
  every BEST-OF-N attempt — get only the material their row of the table in
  [references/briefs.md](references/briefs.md) lists: never an author's
  reasoning, report or transcript, never a sibling attempt, never a relay.
  (Results you produced and checked yourself, like a judge's results table,
  are material, not relays.) They may receive a FOLLOW-UP question about
  their own output. An attempt gets no FIX until it has been judged.
- If two lanes need to talk while they run, the partition is wrong: re-cut it,
  write a contract (step 2), or merge them into one lane.

Why not peer-to-peer, when message-passing agents beat fork-join on some
benchmarks: [references/lessons.md](references/lessons.md#design-note-why-the-hub-stays-the-gate).
The short version: those wins came from tasks whose messages are derived
facts; a lane's report is a claim, and a claim passed peer-to-peer becomes a
premise before anyone checks it. Independence is also what makes redundant
attempts and checks worth anything.

## 0. Keep fleet state in files, not in your context

Record the fleet in the ledger **before** every launch and every decision, so
a new session can resume if yours compacts or ends:

```bash
node <skill>/scripts/fleet.mjs init "<fleet name>" --goal "<goal>"
node <skill>/scripts/fleet.mjs lane api --tier T2 --deps contract-api --branch feat/api --path <wt> --brief <file>
node <skill>/scripts/fleet.mjs set api state=running agent=<agent id>
node <skill>/scripts/fleet.mjs ready    # lanes whose dependencies have merged
node <skill>/scripts/fleet.mjs check    # cycles, wrong merges, orphaned or blocked lanes, escalations
node <skill>/scripts/fleet.mjs resume   # what a successor runs first
```

Save each brief and report to a file and record it (`set <lane> brief=<abs
path> report=<abs path>`; use absolute paths). Details, the
lifecycle and the resume protocol: [references/fleet-state.md](references/fleet-state.md).

## 1. Inventory shared state (once per project, then reuse)

List everything two lanes could both touch and give each one treatment:
**partition** (each lane its own copy: worktree, deps, port, build dirs),
**serialize** (a lock: local database, fixture reset, device, rate-limited
API), or **orchestrator-owned** (workers report, you act: primary checkout,
merge, PRs, global counters, generated files, production, and **the gate
itself**).

- **The gate is shared state.** Tests, fixtures, snapshots, thresholds,
  runner and CI config, skip lists and verification paths are
  **gate-protected**: no lane changes them unless that is its stated concern,
  reviewed by someone else. Nothing is proven if the same agent wrote the work
  and the check that passed it.
- **External side effects** are shared state too. Reversible ones can be
  serialized; irreversible ones are proposed by lanes and carried out by you or
  a human.

Write the inventory into the project's `CLAUDE.md` (or a `PARALLEL.md`).
Discovery checklist and mechanisms: [references/shared-resources.md](references/shared-resources.md).

## 2. Plan lanes, shapes, dependencies and tiers

- **One lane = one worktree = one branch = one concern = one PR.** Partition by
  **file ownership**, not topic; a file in two lanes' ownership is a planned
  conflict.
- **Name each fan-out's shape.** **ALL** (every lane lands). **FIRST-SUFFICIENT**
  (a race — rival hypotheses or repros; you write the win condition as a
  command you can re-run; you stop the rest once a win checks out). **BEST-OF-N**
  (2–3 independent attempts at one hard concern; a judge ranks them; one merges).
- **Dependencies are edges, not waves.** A lane that consumes another's output
  starts when *those* lanes merge (`fleet.mjs ready`), never stacked on their
  branches. **Contract-first** deletes edges: when B needs only A's interface,
  put the types/schema, fail-loudly stubs and a shape-pinning test in a
  `contract/<slug>` lane, merge it, then run A and B together.
- **Tier every lane (T0–T3)** by blast radius and how judgment-heavy it is.
  The tier decides its checks — verifier, adversarial reviewer, BEST-OF-N,
  judges, mutation checks, human sign-off. Resolve spec ambiguities before
  implementation launches. Table and protocols:
  [references/assurance.md](references/assurance.md).
- **Width = the scarcest resource**: CPU/RAM/devices (contention looks like
  flakiness), and your judgment — reviewer lanes can do the reading, only you
  can do the deciding. Checkable work goes wide; judgment-heavy work gets
  redundancy and review, not width; irreversible work stays narrow.
- **Hierarchy has a cost.** Sub-orchestrators follow this skill, never merge to
  the default branch, and return the *union* of their NOT VERIFIED lists. Say
  in the PR how many layers sat between the work and the final review.

## 3. Provision environments (you, not the workers)

```bash
<skill>/scripts/lane.sh new feat/short-slug "files this lane owns"      # writing lane
<skill>/scripts/lane.sh new --detach api --base <sha> "review"   # reviewer at a fixed commit → .claude/worktrees/review-api
```

A fresh branch from the fetched default branch, a worktree under
`<primary>/.claude/worktrees/` (never `/tmp`), per-worktree dependencies, a
recorded port, and a claim that shows other sessions' claims so overlap is
caught early. Keep the **primary checkout** on the default branch and clean:
read there, never build or commit there — every subagent's shell may start there.

## 4. Brief

**Before writing any full-path brief, read
[references/briefs.md](references/briefs.md) and build from its template**
(writing, race, verifier, reviewer, judge, spec, adjudicator; messages to live
lanes; continuation briefs; report schemas, including JSON for Workflows).
Every brief has a `Lane:` line, a goal with the reason, owned and forbidden
files (gate-protected paths always forbidden), the gate commands, "done means",
"if blocked, stop and report", and its report schema **pasted in** — the
worker cannot see this skill. Fill every `{{SLOT}}`; the hook denies a launch
with one left. Launch independent lanes in one message; don't poll.

## 5. While lanes run

- **Schedule on edges**: when a lane merges, launch what `fleet.mjs ready` lists.
- **Relay checked facts** to the lanes they affect (channel rule). A relay
  that changes what a lane *builds* means a missing edge or contract — fix the
  plan instead.
- **Stop races** once a win checks out: record it
  (`fleet.mjs decide "<win evidence>" --lane <winner>`), then send the others
  a STOP message (commit, push, release locks, reply `STOPPED <sha>`); hard
  stop only if unanswered, then inspect its worktree, locks and port.
- **Respawn** a worker whose context is heavy: confirm it has finished and
  pushed, then start a fresh one with a continuation brief.
- **`lane.sh release <lane>`** when a worker finishes. A lane still `active` is
  never removed by tidy or retire.

## 6. Collect — every report is a claim

- The SHA is on the remote; the worktree is clean (list git-ignored outputs
  that matter; they die with the worktree).
- **The gate was not moved.** Diff it yourself against the pinned commit —
  `git diff <BASE>..<SHA> -- <protected paths>` with `<BASE>` =
  `git merge-base origin/main <SHA>` — and look inside owned files for
  weakening: skipped or `.only` tests, loosened assertions, broader catches,
  snapshot updates, lowered thresholds, disable comments, mocks replacing the
  unit under test, special cases keyed on test inputs.
- External actions match the report; NOT VERIFIED is carried into the PR.
- **Audit beyond the report** — at least one lane per fleet, weighted to the
  riskiest, and every T2+ lane. Reading full diffs and transcripts costs your
  context, so give it to an audit lane with fixed questions (checks weakened?
  blocks routed around? does the report match the diff?); you read its report,
  the hunks it flags, and the gate-path diff yourself.
- **Reviewer findings are claims too**: reproduce the critical ones yourself
  before acting.
- **Code fixes go back to the author; existing and verifier tests never do.**
  A needed acceptance test comes from the verifier lane or from you; the
  author merges it at a pinned SHA and changes code only (it may add its own
  new tests, which must fail on the old code). Disputed tests go to an adjudicator; fix loops are capped
  (see [references/assurance.md](references/assurance.md)).

## 7. Integrate — prove the lanes combine before anything merges

```bash
<skill>/scripts/combine-check.sh <sha-a> <sha-b> <sha-c>                     # pairwise, textual
<skill>/scripts/combine-check.sh --check "npm ci && npm test" <sha-a> <sha-b> # + fold all, run the gate
<skill>/scripts/combine-check.sh --against <dep-sha> <live-sha>…             # a dependency merging mid-fleet
<skill>/scripts/combine-check.sh --baseline --check "<gate>" …               # fold fails: lanes, or main?
```

Pass the SHAs you checked, not branch names; the printed pin lines are what
was proven. A verifier branch is folded in last and **merged into the lane
whose PR delivers the behaviour it tests** (the BEST-OF-N winner; in an ALL
fleet, the last of the lanes it covers to merge) before that PR opens — never
its own PR (its tests fail until the feature exists). On conflict, move a hunk; don't stack PRs. You open the PRs
and merge. Exit codes, baseline semantics, merge queues and the CI mechanisms
to ratchet into: [references/integration.md](references/integration.md).

## 8. Retire and ratchet

- `lane.sh tidy` (dry run), then `lane.sh tidy --yes`: removes landed, released
  lanes; never active, locked, dirty or unreachable-commit ones.
- `lane.sh retire <lane>` for lanes that will never merge (losing attempts,
  stopped racers, reviewer worktrees): refuses anything that would lose work;
  `--discard-unreachable` only after you have looked at the commits it lists.
- Record outcomes (`fleet.mjs decide`, `defect`) and read `fleet.mjs metrics`:
  it is how you learn whether the extra checks paid for themselves.
- **Ratchet every surprise into a mechanism**: incident → rule → script that
  makes the right way easy → hook that blocks the wrong way
  ([references/guardrails.md](references/guardrails.md)).

## Rules that hold on every path

- **Never throw away work you have not looked at.** Look before
  `reset --hard`, `clean -f`, `checkout -- .`, `restore`, `branch -D`,
  `worktree remove --force`, `push --force`. The stash is shared by every
  worktree: unique message, apply by SHA, never `pop`; prefer a WIP commit.
- **Never copy files between branches or worktrees** — merge. Copies carry no
  ancestry and silently revert other work.
- **Never kill processes by name** — kill the PID on your own port.
- **Workers never expand their own authority**: no agent merges changes to CI,
  merge policy, permissions, hooks or automation; those wait for a human.
- **Declare every lane** (`Lane: <abs worktree path>`, `Lane: read-only`, or
  `Lane: none — <reason>`), even where the hook is not installed.
- **No lane grades itself**, and **irreversible means proposed, not performed.**
- **Say what was not proven** in every report and PR.
- **Know what the guardrails are for.** Worktrees, claims, locks and the hook
  catch *accidents*. They do not stop an agent optimizing to pass; independent
  authorship of checks, gate-diff review and spot audits do.

## Scripts and self-test

| File | What it does |
|---|---|
| `scripts/lane.sh` | worktrees + claims + ports: `new`, `new --detach`, `list`, `port`, `release`, `retire`, `tidy`, `root` |
| `scripts/combine-check.sh` | pairwise + fold proof, `--against`, `--baseline`, pinned SHAs |
| `scripts/with-lock.sh` | machine-wide lock for serialized resources |
| `scripts/fleet.mjs` | the fleet ledger: `init lane set fact decide defect show ready check resume metrics` |
| `hooks/agent-guard.mjs` | PreToolUse guard: lane declaration, unfilled slots, lane validation |

Each file's header documents its interface. Self-test after changing any of
them: `bash tests/acceptance/run.sh` (independent acceptance suite), plus
`bash tests/<name>.test.sh` and `node --test tests/*.test.mjs`. Targets macOS
bash 3.2 and Node ≥ 18.
