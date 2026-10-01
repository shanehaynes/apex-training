# Integration: from N green lanes to one green main

Every lane passing its own gate proves each lane against *its base*. It says
nothing about the lanes against each other, or about the tree main will hold
after they all land. Integration is its own phase, and it is serial no matter
how parallel the lanes were — plan for it.

## 0. Pin what you prove

Pass `combine-check.sh` the **SHAs you checked** in Collect, not branch names:
a branch can move between your check and the proof. It prints the base and
every ref as full SHAs before running anything —

```
   base origin/main = 68d9afd…
   ref  a1b2c3d = a1b2c3d4…
   ref  feat/api (origin/feat/api) = 9c78f1a…     # local feat/api differs: origin was tested
```

— and those pins are exactly what was proven. Quote them in the PR.

## 1. Textual: pairwise merge-tree

```bash
scripts/combine-check.sh <sha-a> <sha-b> <sha-c>
```

`git merge-tree --write-tree A B` is a three-way merge that touches no working
tree. `CONFLICT a × b` means the pair collides; `ERROR a × b: <git's message>`
means git could not merge them at all (e.g. unrelated histories) — both exit 1,
and every remaining pair still runs. Run this on every pair **before the PRs
open**; otherwise the conflict appears only after the first PR merges.

**A dependency merging mid-fleet** (a lane that others will consume, landing
while unrelated lanes still run): check it against the live lanes' current
pushed heads with `--against` — N pairs, not N²/2 — and fold only base + the
dependency for its gate:

```bash
scripts/combine-check.sh --against <dep-sha> <live-sha-1> <live-sha-2> --check "<gate>"
```

### When a pair conflicts: move a hunk, do not stack

- Put one side's new line on the other side of an unchanged line.
- Split an import (type import in one lane, value import in the other).
- Move one lane's addition to a new file the hot file imports.
- Or sequence: land A, then B merges main in and resolves once.

Do **not** base B on A's branch. A stacked PR retargets to main only if A's
branch is deleted in the right order; get it wrong and B merges into A's dead
branch — this took production down once.

## 2. Semantic: fold everything and run the gate

```bash
scripts/combine-check.sh --check "npm ci && npm test" <sha-a> <sha-b> <verify-sha>
```

Folds every ref onto the latest default branch in the order given, in a
throwaway detached worktree under `.claude/worktrees/_combine-*`, and runs the
command there in a fresh shell (no inherited `set -e`/`-u`/`pipefail`, stdin
from `/dev/null`, its own process group). This is the only check that sees
"A tightens a lint rule, B adds code the rule rejects". Install dependencies
in the command (`npm ci && …`): the throwaway has none.

**Fold the verifier's branch in last**, with its acceptance suite in the
command. An implementation that passes its own tests but fails the verifier's
has not been proven; resolve by reading both, never by editing the
verifier's tests.

**Know where the proof stops.** It runs exactly the command you give it. In
the source project, the fold ran the web gate and main went uncompilable for
iOS for days, because nothing in the fold compiled Swift. Name what the fold
did not cover in the PR.

### When the fold fails: the lanes, or main? (`--baseline`)

```bash
scripts/combine-check.sh --baseline --check "<gate>" <sha-a> <sha-b>
```

If the fold fails, the same command runs on the base commit:

| Result | Exit | Meaning |
|---|---|---|
| fold passes | 0 | proven for what the command runs |
| fold fails, base passes | 1 | the combination breaks it |
| fold fails, base fails too | 3 | main is already failing (flaky or broken) — **the lanes may still have broken it too; compare the failures** |
| the check cannot run on base (126/127, e.g. it runs test files the lanes add) | 1 | baseline inconclusive |
| the check cannot run on the fold (126/127) | 1 | fix the command, not the lanes |
| internal failure | 2 | `combine-check: error: <step>: …` (1 if a conflict was already found) |
| usage | 64 | |

**Flaky tests.** Before blaming a lane for a fold failure, see whether it fails
on base (`--baseline`). Keep known-flaky tests in an orchestrator-owned,
gate-protected quarantine list that CI retries or reports without blocking,
and fix them as their own concern — never by loosening them inside a lane.

## 3. The verifier's branch lands with the winner

`verify/<slug>` never gets its own PR: its tests fail until the feature
exists, so it would fail required checks or turn main red. Merge it (a real
merge, not a copy) into the winning implementation branch at the pinned SHA
before that PR opens — the author does this in the FIX step — and confirm
`git diff <verify-sha> <impl-sha> -- <verification path>` is empty, so "the
author didn't touch the verifier's tests" is a checked fact.

## 4. Opening PRs

The orchestrator opens them, not the workers: one place knows the merge order,
the cross-lane notes, and the NOT VERIFIED lists to carry forward. Base every
PR on the default branch. Open PRs under a bot or app identity if a human must
approve them: GitHub does not let an author approve their own PR.

## 5. Merging N PRs

**If the repo requires branches to be up to date before merging**: each merge
puts every other PR behind, so N PRs cost N serial rounds of update → CI →
merge. Update only the *next* PR after each merge, and update by **merging**
the default branch into it (`git merge --no-edit origin/main && git push`, or
the update-branch API) — never rebase a pushed branch.

**Fleet mode** (up-to-date rule off): every green PR is mergeable however far
behind, so a whole fleet can land in one cycle — only if you replace what the
rule guaranteed: fold all ready PRs in merge order, run the gate on the fold,
then merge in that same order, and verify main's CI after.

**A merge queue** does this server-side. Use it when available. Every required
workflow then needs an `on: merge_group` trigger, or the queue stalls.

## 6. CI mechanisms to ratchet into

Prose rules become mechanisms (see [guardrails.md](guardrails.md)); these are
the CI-level ones, set up per project (the new-dev-project skill wires them):

- **CODEOWNERS** on gate-protected paths, verification paths and CI config,
  with "require review from code owners". Nothing an agent does alone can
  change the gate.
- **A gate-diff job**: fails when a PR changes gate-protected paths without a
  label only humans can apply.
- **A verify-integrity job**: the PR's verification files equal the pinned
  `verify/<slug>` commit.
- **Trigger CI on `pull_request` and `merge_group`, not on every push** to
  lane, race or verify branches — race lanes push WIP and verify branches fail
  by design.
- **Never give a required check a `paths:` filter**: on PRs it skips, it never
  reports, and the PR waits "Expected" forever. Use an always-running job that
  skips internally.

## 7. After merging

- Main's CI on the merge commit is green — not assumed.
- If main deploys: poll the deployed version endpoint until it reports the
  merged SHA. "It probably deployed" is not a check.
- `lane.sh release` any lane whose worker is still marked active, then
  `lane.sh tidy`, and record merges in the ledger.

## Detecting "merged" when the repo squash-merges

A squash rewrites the commit, so a merged branch is never an ancestor of main.
`lane.sh tidy` tests content instead (merge the branch into main in memory;
an unchanged tree means it contributes nothing new), treats a lane released
as `done` whose tip is an ancestor of main as landed (merge commits and
fast-forwards), and reports "upstream deleted" only as evidence for review —
a PR closed without merging looks the same.

## Tool gotchas that cost real time

- `gh pr list` defaults to `--limit 30` and truncates silently; a 39-PR fleet
  was once "checked" as 30. Pass a high limit and refuse to continue if you hit it.
- `git merge-tree --write-tree` needs git ≥ 2.38.
- A check that compiles one platform proves nothing about another.
- Hosting quotas (deploys per day) can stop a merge train midway; know the cap.
- A network step with no timeout hangs a whole fleet: `combine-check.sh`
  bounds fetch/ls-remote by `COMBINE_GIT_TIMEOUT` (default 60 s) and
  `fleet.mjs resume` by `FLEET_GIT_TIMEOUT_MS`.
