# `ios` as a required check — spec

**Owns:** `.github/workflows/ci.yml` (the `ios` job and a new `changes` job, nothing else),
the `ios` job section of `docs/ios/testing-and-ci.md`, `required_green` in
`scripts/merge-babysit.sh` and its tests in `scripts/__tests__/merge-babysit.test.ts`, this
file. Branch protection on `main` (M3, which Shane runs).
**Forbidden:** every other `ci.yml` job (`coach-gate`'s in-job skip stays: it runs on
ubuntu), `scripts/merge-policy.mjs`, hooks, tests this spec did not add.
**Depends on:** #503 (75-minute cap; `ci.yml` counts as an iOS path). It rewrites the same skip
step, so M1 starts from a `main` that has it. #507 (`required_green` waits for every check),
which M2 edits.
**Status:** not started

## Goal

`ios` becomes a required status check on `main`. GitHub then refuses every merge of a PR whose
iOS build and tests have not passed: babysitter, `gh pr merge` and the web UI alike. A web-only
PR still never waits for a macOS runner.

#507 closes the babysitter's hole: fleet mode merged 12 of 16 iOS PRs in October while `ios`
was still running, and 9 of those runs ended red. It cannot close the rest. 75 of the last
100 merges were by hand, and three iOS PRs went in past a red `ios`: #350 and #392 failed,
#451 was cut off.

Requiring `ios` as it stands has a cost. Its skip step runs on `macos-26`, so every web PR
would wait for a macOS runner:
- in the 2026-09-21 fleet, #237's skip started 114 minutes after its other checks;
- a macOS outage would freeze every merge.

Deciding "does this PR touch iOS?" on ubuntu removes that coupling. The `ios` job is then
skipped at job level, and GitHub counts a skipped job as passing a required check.

What Shane accepts by flipping it (M3):
- A red `ios` blocks its PR until a re-run or a fix. Of the last 63 iOS PR heads, 12 ended red:
  9 failed, and 3 were cut off at the old 40-minute cap (#503 raises it to 75).
- The escape hatch stays: `enforce_admins` is off, so Shane can still `gh pr merge --admin`
  past a known flake. Sessions cannot, because the guard hook blocks `gh pr merge`.

## Scope
In:
- A `changes` job on ubuntu that says whether `ios` must run. It moves today's predicate over
  verbatim, as #503 leaves it: a PR or merge-group diff from the merge base that touches `ios/`
  or `.github/workflows/ci.yml`. Push, schedule and dispatch always run `ios`, as today.
- `ios`: `needs: changes` and a job-level `if:` that fails closed. A skipped job satisfies a
  required check, so a `changes` that did not succeed must make `ios` run and fail, never skip.
- The babysitter counts a required check that is SKIPPED or NEUTRAL as passed (GitHub's rule).
  Today it reads as pending forever, which would stall every web PR the moment `ios` is required.
- The branch-protection flip (Shane), and proof on real runs at each step.

Out:
- `coach-gate`'s and `apexcore-linux`'s gating. Neither needs a macOS runner; making
  `apexcore-linux` required is its own decision.
- Speeding up or sharding `ios`. `docs/ios/testing-and-ci.md` already holds that plan.
- The merge queue (off).
- A third-party paths-filter action: no new dependency in CI's supply chain for what `git diff`
  already does.

## Milestones
Each milestone is one PR, except M3, which is a protection change plus this file's log. M1 and
M2 touch different files and can run in parallel. M3 waits for both.

### M1 — the iOS-path decision moves to ubuntu (`ci.yml`, `docs/ios/testing-and-ci.md`)
- [ ] A `changes` job: `runs-on: ubuntu-latest`, `timeout-minutes: 5`, checkout with
  `fetch-depth: 0`, one output `ios` (`true`/`false`). On any event other than `pull_request`
  and `merge_group` the output is `true`. On those two it is `false` exactly when
  `git diff --quiet "$(git merge-base origin/main HEAD)" HEAD -- ios/ .github/workflows/ci.yml`
  succeeds.
- [ ] `ios` has `needs: changes` and
  `if: ${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.ios == 'true') }}`.
  Its first step runs `if: needs.changes.result != 'success'` and exits 1 with an
  `::error::` naming the `changes` job.
- [ ] The step "Skip when a pull request changes no iOS paths" and every `env.skip` condition
  are gone. Three conditions stay as they are:
  - the cache save keeps `github.ref == 'refs/heads/main' && steps.swiftpm.outputs.cache-hit != 'true'`;
  - the result upload keeps `if: always()`;
  - nothing else in the job changes.
- [ ] The comments hold whether or not `ios` is required yet. Say what the job-level skip and
  the fail-closed rule are for, and drop #503's "ios is not a required check and nothing waits
  for it", which lives on the deleted step.
- [ ] Evidence in the PR body, by run id:
  1. this PR's own run (it edits `ci.yml`, so `ios` builds and passes);
  2. a throwaway draft PR touching one web file: `changes` SUCCESS with `ios=false`, `ios`
     COMPLETED/SKIPPED, and no macOS job started;
  3. a throwaway draft PR whose `changes` step is forced to `exit 1`: `ios` runs and is
     FAILURE, not SKIPPED.

  Both throwaway PRs closed and their branches deleted.
- [ ] After merge: main's push run has `changes` with `ios=true` and an `ios` that built and
  tested. Record the run id in the session log.
- [ ] `docs/ios/testing-and-ci.md`: the job snippet and the "Why the early-exit instead of
  `on.paths`" paragraph describe the job-level skip and why it fails closed.

### M2 — the babysitter counts a skipped required check as passed (`scripts/merge-babysit.sh`)
- [ ] In `required_green`, a required context whose verdict is SKIPPED or NEUTRAL passes, like
  SUCCESS. An unknown verdict stays pending.
- [ ] `scripts/__tests__/merge-babysit.test.ts`, with `ios` added to the fixture's required
  contexts:
  - a web-only PR whose `ios` is COMPLETED/SKIPPED folds in fleet mode and reads WOULD MERGE
    from a serial CLEAN;
  - an iOS PR whose required `ios` is IN_PROGRESS waits;
  - a newest required `ios` that is CANCELLED is SKIP "(required; cut off …)".
- [ ] Run against `main`'s script, the skipped-required cases fail (named in the PR body).
- [ ] The `required_green` comment reads true before and after M3: say what waiting only on
  required checks did, not that `ios` is not required.

### M3 — require `ios` (Shane runs it; the session verifies and logs)
- [ ] M1 and M2 merged, and main's last push run is green on `changes` and `ios`.
- [ ] Shane adds `ios`, pinned to GitHub Actions like the other four. PATCH leaves `strict` as
  it is, and the command is reversible by re-sending the list without `ios`:
  ```bash
  gh api -X PATCH repos/shanehaynes/apex-training/branches/main/protection/required_status_checks --input - <<'JSON'
  {"checks":[{"context":"check","app_id":15368},{"context":"e2e-mock","app_id":15368},{"context":"full","app_id":15368},{"context":"coach-gate","app_id":15368},{"context":"ios","app_id":15368}]}
  JSON
  ```
- [ ] `gh api repos/shanehaynes/apex-training/branches/main/protection/required_status_checks --jq '[.checks[].context]'`
  lists all five.
- [ ] After the flip, one web-only PR and one iOS PR merge through the babysitter. The web one
  never WAITs on `ios`; the iOS one merges only after `ios` passed. Log lines go in the session
  log.
- [ ] Memory `apex-ios-ci-timing` updated: it says `ios` is not required and the babysitter
  ignores it.

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it). It never runs `ci.yml`, so
M1's proof is the real runs listed in its acceptance boxes, and M3's is the protection read-back
and the two merges. M1 and M2 touch held paths (`.github/`, the merge actor): each needs Shane's
`shipit`.

## Done means
Every box above checked, every PR merged, `scripts/git-tidy.sh --yes` run,
and the Next brief section below filled in.

## Decisions
- 2026-10-28 · Fail closed inside `ios` rather than also requiring `changes`. That keeps one
  required check instead of two, and it costs a macOS runner only on the rare run where
  `changes` fails.
- 2026-10-28 · Keep the predicate in `git diff`, moved verbatim, rather than a paths-filter
  action. No new dependency, and exactly today's behaviour.
- 2026-10-28 · M3's flip uses PATCH with the full `checks` list (app 15368), not the `contexts`
  endpoint. That keeps the new check pinned to GitHub Actions like the other four.

## Session log
- 2026-10-28 · Spec drafted from the #507 investigation; nothing implemented.

## Next brief
**M1 — the iOS-path decision moves to ubuntu.**
- **Goal:** a web-only PR's `ios` check is a job-level SKIPPED that never asks for a macOS
  runner. An iOS or `ci.yml` PR's `ios` builds and tests exactly as today. A broken path
  decision fails `ios` instead of skipping it.
- **Scope:** add the `changes` job, gate `ios` on it, delete the in-job skip step and its
  `env.skip` conditions, and update `docs/ios/testing-and-ci.md`. Nothing else in `ci.yml`.
- **Acceptance:** the M1 boxes above, including the three run ids and the two throwaway PRs
  closed.
- **Owns:** `.github/workflows/ci.yml` (the `ios` job and the new `changes` job) and the `ios`
  section of `docs/ios/testing-and-ci.md`.
- **Start only after #503 has merged** (same step):
  `scripts/git-new.sh chore/ios-skip-on-ubuntu ".github/workflows/ci.yml ios job + changes job, docs/ios/testing-and-ci.md ios section"`.
  Run the `reviewer` agent before `gh pr create`. The PR is HELD for `shipit` (`.github/`).
