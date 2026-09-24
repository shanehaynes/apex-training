# Shared-state inventory

Do this once per project; write the result into `CLAUDE.md` (or a
`PARALLEL.md` it links) so every future session inherits it.

## Discovery checklist

Walk the repository and answer each. Every "yes" is a row in the inventory.

**Version control**
- Is there a primary checkout sessions read from? (Always yes.) → orchestrator-owned; keep on the default branch, clean.
- Does the repo squash-merge? (Changes how "merged" is detected — see `lane.sh tidy`.)
- Does `main` require branches to be up to date? (Makes merges serial.)
- Git stash: one stack per repository, shared by every worktree. → treat as shared; tagged pushes, apply by SHA.

**Per-checkout build state** → partition
- Dependency dirs (`node_modules`, `.venv`, `target/`, `Pods/`, `DerivedData`): per worktree; install in each.
- Build/output/cache dirs *inside* the tree: fine. *Outside* it (`~/.cache/<tool>`, a global `DerivedData`, a fixed `/tmp/x`): shared — give each lane its own path (env var or flag).
- Git-ignored local config (`.env.local`, signing secrets, generated xcconfig): not copied into new worktrees, and deleted with them. Decide how lanes get them (a setup script that regenerates them) and never let a lane's only copy of something live there.

**Network ports** → partition
- Any fixed port in dev server config, test config, docker-compose, scripts?
- Does the test runner reuse an already-running server (Playwright's `reuseExistingServer`, similar)? With a fixed port, lane B's tests silently run against lane A's server and test A's code. Fix: derive the port from the worktree (`lane.sh port`), make every tool read the same resolver, turn on strict-port so a clash fails loudly instead of sliding to a port nothing else follows.

**Databases and services** → serialize (or partition if cheap)
- Is there one local database/stack for the machine? Which commands reset, seed, migrate or truncate it? Those need a machine-wide lock (`with-lock.sh`), and so does anything new that resets or seeds.
- Is the local schema kept current automatically? If not, lanes may be testing against a stale schema — make a check command, and make resetting it a human/orchestrator action.
- Can each lane get its own instance cheaply (per-lane schema/database name, containers on hashed ports)? Then partition instead; it removes the queue.
- Production or shared staging: orchestrator-owned at minimum; usually human-only.

**Global counters and registries** → orchestrator-owned, claimed late
- Sequentially numbered files (migrations `0042_*.sql`, ADRs, changelog entries), version/build numbers, enum values, error codes, feature-flag IDs.
- Two branches can both add `phase33_x.sql` and `phase33_y.sql`: no git conflict, both merge, and the apply order is now decided by filename. Claim the number when the PR opens, not when work starts; add a test that fails when two files share a number, so the second PR goes red *before* it merges.

**Hot files** → give to one lane, or sequence
- Files every feature edits: route tables, DI registries, barrel `index` files, navigation maps, the root README/CHANGELOG, lockfiles.
- Generated files (schema types, API clients, snapshots): regenerate them with the tool in the lane that changes the source, never hand-merge them, and have CI fail on drift.
- Lockfiles: one lane changes dependencies per wave; on conflict, regenerate from the merged manifest.

**Capacity** → set the wave width
- CPU/RAM for parallel builds and test runs; simulators/emulators/devices; GPU.
- External quotas: CI minutes, deploy caps (a hobby-tier host refused most deploys mid-fleet once), API rate limits, token budget.
- Contention shows up as flaky timeouts, not as errors that name the cause. If tests fail in parallel and pass alone, narrow the wave before debugging the code.

**Authority**
- Paths whose change expands what agents can do unattended: CI config, merge policy, permissions/settings, hooks, deploy config, dependency manifests, release/signing surface. → held for a human, never auto-merged by an agent.

## Mechanisms, by treatment

### Partition
- **Worktree per lane** under `<primary>/.claude/worktrees/<branch-with-dashes>` (`lane.sh new`). Not `/tmp`: gone after reboot, and invisible to other sessions and to the human looking for a branch.
- **Deterministic per-lane port**: hash the worktree directory name into a range (`lane.sh port`), default port for the primary checkout so the README stays true, env override for humans.
- **Per-lane env**: anything with a global default path gets a lane-local override in the brief.

### Serialize
- **Lock with `mkdir`**, not `flock`: `mkdir` is atomic everywhere and macOS ships no `flock`. Record the holder's PID and command; a contender reaps the lock only when that PID is provably gone. Wait with a bounded timeout and print who holds it. Nested calls must not deadlock (export a "locked" flag). `with-lock.sh` implements all of this.
- Put the lock *inside the command* (`npm run e2e:live` → wrapper), not in prose, so a worker cannot forget it.

### Orchestrator-owned
- Workers report the need; the orchestrator acts. The brief lists these explicitly under "do not change".
- **Claims registry**: `lane.sh` appends `branch, time, path, intent` to `<primary>/.claude/state/claims.tsv` and prints other claims when a lane starts. It is a hint, not a lock — sessions started by hand may not claim — so read it as "who might be here", not "who is here".

Ensure `.claude/state/` and `.claude/worktrees/` are git-ignored in the project.

## Inventory template

```markdown
## Parallel work: shared state
| Resource | Treatment | Mechanism | Notes |
|---|---|---|---|
| Primary checkout | orchestrator-owned | stays on main, clean; hook blocks builds/commits | |
| Working tree + deps | partition | `lane.sh new` (worktree + install) | |
| Dev/test port | partition | `lane.sh port`, strict port | test runner reuses servers |
| Local DB | serialize | `with-lock.sh db <reset cmd>` | schema can lag main |
| Migration numbers | orchestrator-owned | claimed at PR open; uniqueness test | |
| Generated types | partition + CI drift check | regenerate in lane | |
| Merge | orchestrator-owned | combine-check, then serial merge | |
| Wave width | — | N lanes code-only; 2 with simulators | |
| Held paths | human | CI, hooks, settings, deploy, deps | |
```
