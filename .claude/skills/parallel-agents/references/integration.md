# Integration: from N green lanes to one green main

Every lane passing its own gate proves each lane against *its base*. It says
nothing about the lanes against each other, or about the tree main will hold
after they all land. Integration is its own phase, and it is serial no matter
how parallel the lanes were — plan for it.

## 1. Textual: pairwise merge-tree

```bash
scripts/combine-check.sh feat/a feat/b feat/c
```

`git merge-tree --write-tree A B` is a three-way merge that touches no working
tree; exit 1 with `CONFLICT` lines means the pair collides. Run it on every
pair *before the PRs open*. Otherwise the conflict appears only after the first
PR merges, when the second one suddenly needs a rebuild.

### When a pair conflicts: move a hunk, do not stack

- Put one side's new line on the other side of an unchanged line.
- Split an import (type import in one lane, value import in the other).
- Move one lane's addition to a new file the hot file imports.
- Or sequence: land A, then B merges main in and resolves once.

Do **not** base B on A's branch. A stacked PR retargets to main only if A's
branch is deleted in the right order; get it wrong and B merges into A's dead
branch — this took production down once, because the "merged" PR never
reached main while its dependents did.

## 2. Semantic: fold everything and run the gate

```bash
scripts/combine-check.sh --check "npm ci && npm test" feat/a feat/b feat/c
```

Folds every branch onto the latest default branch in the order given, builds
a throwaway detached worktree from the result, and runs the command there.
This is the only check that sees "A tightens a lint rule, B adds code the rule
rejects" before the last PR merges.

**Know where the proof stops.** It runs exactly the command you give it. In
the source project, the fold ran the web gate, and main went uncompilable for
iOS for days, because nothing in the fold compiled Swift. Name the platforms
and suites the fold did not cover in the PR, and cover them another way
(a nightly full run, a platform CI job) if they matter.

## 3. Opening PRs

The orchestrator opens them, not the workers: one place knows the merge order,
the cross-lane notes, and the "not verified" lists to carry forward. Base every
PR on the default branch.

## 4. Merging N PRs

**If the repo requires branches to be up to date before merging** (GitHub
branch protection "strict" status checks): each merge puts every other PR
behind, so N PRs cost N serial rounds of update → CI → merge. Order does not
change the total. Two things keep it cheap:

- Update only the *next* PR after each merge, not all of them — updating all
  buys no wall-clock (the next merge puts them behind again) and costs a CI
  run per PR per merge (435 runs instead of 29 for a 29-PR fleet).
- Update by **merging** the default branch into the PR branch
  (`git merge --no-edit origin/main && git push`, or GitHub's update-branch
  API). Never rebase a pushed branch for this: a force-push is how one session
  ends up reassembling another's work by hand. The merge commit disappears in
  the squash anyway.

**Fleet mode** (up-to-date rule off): every green PR is mergeable however far
behind it is, so a whole fleet can land in one cycle — but only if you replace
what the rule guaranteed. Fold all ready PRs in merge order, run the gate on
the fold (`combine-check.sh --check`), then merge in that same order. Main's
own CI now runs *after* the merges, so verify the deploy.

**A merge queue** (GitHub, for organization-owned repos and Enterprise) does
all of this server-side. Use it when available; it is not available to
personal-account repositories.

## 5. After merging

- Main's CI on the merge commit is green — not assumed.
- If main deploys: poll the deployed version endpoint until it reports the
  merged SHA. "Vercel/Netlify probably deployed" is not a check; a routing
  change once 404'd every API route and only a post-deploy probe could see it.
- Retire the lanes: `lane.sh tidy --yes`.

## Detecting "merged" when the repo squash-merges

A squash rewrites the commit, so a merged branch is never an ancestor of main
and `git branch --merged` reports nothing. Test content instead: merge the
branch into main in memory (`git merge-tree --write-tree origin/main br`) and
compare the tree with main's — identical means the branch contributes nothing
new. If main has since changed the same lines that merge conflicts and reports
"not merged", so also use "upstream branch deleted" as *evidence* (auto-delete
on merge), reported for review, never auto-deleted: a PR closed without merging
looks the same. `lane.sh tidy` implements both.

## Tool gotchas that cost real time

- `gh pr list` defaults to `--limit 30` and truncates silently; a 39-PR fleet
  was once "checked" as 30. Pass a high limit and refuse to continue if you hit it.
- `git merge-tree --write-tree` needs git ≥ 2.38.
- A check that compiles one platform proves nothing about another.
- Hosting quotas (deploys per day on hobby tiers) can stop a merge train
  midway; know the cap before a 30-PR landing.
