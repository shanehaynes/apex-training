# Fleet state: the ledger, and resuming a fleet

An orchestrator that keeps the fleet only in its context window is a single
point of failure. When the session compacts or ends, the successor sees two
worktrees claiming the same files and cannot tell a losing BEST-OF-N attempt
from a real lane, which edges are satisfied, which facts were checked, or what
the judge ruled. `scripts/fleet.mjs` is the orchestrator's durable memory:
an append-only JSONL ledger under `<primary>/.claude/state/fleet/`, written
only by the orchestrator, from which every view is derived.

The ledger is **not** a channel to workers. Workers never read it; what they
need comes in their brief or a relay (the channel rule).

## What to record, and when

| Moment | Command |
|---|---|
| Starting a fleet | `fleet.mjs init "<name>" --goal "<goal>"` (archives the previous ledger) |
| Planning a lane — before launch | `fleet.mjs lane <slug> --role impl --shape ALL --tier T1 --deps a,b --branch <b> --path <abs wt>` |
| The brief is written | `fleet.mjs set <slug> brief=<abs path>` (use absolute paths; `set` stores them absolute, `lane --brief` stores what you give) |
| Rival attempts / race lanes | same, with `--shape BEST-OF-N` or `FIRST-SUFFICIENT` and a shared `--group <g>` |
| Launching it | `fleet.mjs set <slug> state=running agent=<agent id>` |
| It reported | `fleet.mjs set <slug> state=reported sha=<sha> report=<file>` |
| You checked it | `fleet.mjs set <slug> state=checked` |
| A fix round | `fleet.mjs set <slug> round=<n>` |
| Reviewer results | `fleet.mjs set <reviewer> findings=<n> confirmed=<m>` |
| Disputed verifier tests | `fleet.mjs set <verifier> disputed=<n>` |
| A fact you checked (for relays) | `fleet.mjs fact "<fact>" --evidence "<command/sha>" --from <slug>` |
| A judge ruling | `fleet.mjs decide "<why>" --kind judge --lane <winner>` |
| A race win checks out | `fleet.mjs decide "<win evidence>" --lane <winner>` (without it, `check` warns "race ended with no win" once the racers are stopped or retired) |
| A merge | `fleet.mjs decide "<PR, pins>" --kind merge --lane <slug>` and `set <slug> state=merged` |
| Adjudication, escalation, a plan change | `fleet.mjs decide "<what>" --kind adjudication|escalation|plan [--lane <slug>]` |
| Merged / retired / stopped | `fleet.mjs set <slug> state=merged` (or `retired`, `stopped`, `failed`) |
| A defect found after merge | `fleet.mjs defect <slug> "<what>"` |

Save every brief and every report to a file (e.g. under
`<primary>/.claude/state/fleet/briefs/` and `…/reports/`) and record the path:
the continuation brief for a respawned worker is "the original brief,
verbatim", which only exists if you saved it.

## Views

- `show [--json]` — every lane's current state, plus facts, decisions, defects.
- `ready` — planned lanes whose dependencies have all merged, most
  dependents first (critical path first). Drops rivals of a group that has
  already merged a winner.
- `check` — ERROR on undeclared dependencies, dependency cycles, more than one
  merged lane in a BEST-OF-N group, or a merged lane that is not the group's
  standing judge winner; WARN on fix rounds at the escalation threshold, a race
  that ended with no win, a running lane with no agent id, a lane blocked
  forever by a retired/stopped dependency, and groups mixing shapes. Run it
  before every merge.
- `metrics [--json]` — see [assurance.md](assurance.md#measure-whether-the-checks-pay).

## Resuming a fleet (what a successor session does first)

1. `node <skill>/scripts/fleet.mjs resume` — the state table, then for every
   running/reported/checked lane: does its path exist and is it a worktree,
   how dirty, is its recorded SHA what origin has (MATCH / DIFFERS / NOT
   PUSHED / UNKNOWN; `DIFFERS (no sha recorded)` just means you never
   recorded one), and is HEAD ahead of **origin/<its branch>** (`AHEAD n`,
   `AHEAD ?`). Not the same as `lane.sh list`'s `ahead=`, which counts commits
   ahead of origin/main — pushed work shows there too. Read-only; bounded by
   timeouts; never prompts for credentials.
2. `<skill>/scripts/lane.sh list` — claims, ports, active/done status.
3. `node <skill>/scripts/fleet.mjs check` — anything inconsistent.
4. Reconcile before acting:
   - **Treat a recorded agent as alive until shown otherwise.** Background
     agents can outlive your context. Check the agent list, or send the agent
     a FOLLOW-UP asking for its status. Re-launch (continuation brief) only
     once it is confirmed gone — two writers must never share a worktree.
   - `AHEAD n` or dirty means unpushed work: never retire it; read the diff
     and put it in the continuation brief's summary.
   - `DIFFERS` (with a recorded sha) means someone pushed after your record:
     re-check before merging.
5. `fleet.mjs ready` for what to launch next.

## Handing off the orchestrator itself

The "respawn heavy workers" rule applies to you. When your context is heavy
and your decisions are slowing or slipping, make sure the ledger is current
(every lane, fact and ruling recorded, briefs and reports on disk), then hand
off: the next session starts from `resume`, not from a summary of your
conversation.

Cap width by what one ledger-driven orchestrator can resume: if `show` is too
long to take in at once, the fleet needs sub-orchestrators.

## Limits

- One writer. Writes are locked, but the design assumes one orchestrator
  appends; two orchestrators on one fleet will produce a valid but confusing
  history.
- A lock held longer than `FLEET_LOCK_MAX_AGE_MS` (default 60 s) is reaped;
  writes take milliseconds, so this only matters for a stopped process.
- When a git call in `resume` times out, its grandchildren (e.g. ssh) may
  outlive it.
