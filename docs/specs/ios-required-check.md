# `ios` as a required check — spec

**Owns:**
- `.github/workflows/ci.yml`: the `ios` job, a new `changes` job, and the one comment on
  `coach-gate`'s skip step that says "Same reasoning as the ios job above". Nothing else.
- The `ios` job section of `docs/ios/testing-and-ci.md`.
- A new `scripts/__tests__/ci-ios-paths.test.ts`.
- `required_green` in `scripts/merge-babysit.sh`, and a new describe block in
  `scripts/__tests__/merge-babysit.test.ts`.
- The comment in `scripts/ios-ci-headroom.mjs` that says a web-only PR "finishes the job in
  seconds" (only if #506 has merged).
- The "always-running job that skips internally" rule in
  `.claude/skills/parallel-agents/references/integration.md`.
- This file.
- Branch protection on `main` (M3, which Shane runs).

**Forbidden:**
- every other `ci.yml` job or line (`coach-gate`'s in-job skip stays: it runs on ubuntu);
- `scripts/merge-policy.mjs`;
- hooks;
- tests this spec did not add, including #507's describe block in `merge-babysit.test.ts`.

**Depends on:**
- #503 (75-minute cap; `ci.yml` counts as an iOS path). It rewrites the same skip step, so M1
  starts from a `main` that has it.
- #507 (`required_green` waits for every check), which M2 edits.

**Status:** M1 merged 2026-10-29 as #515, and all of its boxes are checked.
M2 is in review as #517 (HELD for `shipit`). M3 waits only for M2: `main`'s push run with M1
in it (40868335083) is green.

## Goal

`ios` becomes a required status check on `main`. Then `gh pr merge` and the web UI refuse to
merge a PR whose iOS build and tests have not passed, whoever runs the merge. A web-only PR
still never waits for a macOS runner.

#507 closes the babysitter's hole. Fleet mode merged 12 of 16 iOS PRs in October while `ios`
was still running, and 9 of those runs ended red. It did so again today: #502 merged at
20:20Z with its `ios` cut off at 41 minutes.

#507 cannot close the rest. About three quarters of merges are by hand (75 of the 100 before
2026-10-28's fleet run), and of the last 64 iOS PRs, three hand merges went in past a red
`ios`: #350 and #392 failed, and #451 was cut off.

Requiring `ios` as it stands has a cost. Its skip step runs on `macos-26`, so every web PR
would wait for a macOS runner:
- in the 2026-09-21 fleet, #237's skip started 114 minutes after its other checks;
- a macOS outage would freeze every merge.

Deciding "does this PR touch iOS?" on ubuntu removes that coupling. The `ios` job is then
skipped at job level, and GitHub counts a skipped job as passing a required check.

What Shane accepts by flipping it (M3):
- A red `ios` blocks its PR until a re-run or a fix. Of the last 64 iOS PR heads, 13 ended red:
  9 failed, and 4 were cut off at the old 40-minute cap (#503 raises it to 75).
- Every PR that edits `ci.yml` now waits on a full `ios` run, even one that only touches
  `coach-gate`: about 34 min at p50, red about one time in five. #503 makes `ci.yml` an iOS
  path, and requiring `ios` makes that wait blocking. A macOS backlog then blocks those PRs too.
- The bypass stays deliberate. `enforce_admins` is off and every merge runs as Shane, an admin,
  so `gh pr merge --admin` or the web UI's bypass box still merges past a known flake. Sessions
  cannot: the guard hook blocks `gh pr merge`, and the babysitter never passes `--admin`.
  Turning `enforce_admins` on would close that too, but it is a separate decision.

## Scope
In:
- A `changes` job on ubuntu that says whether `ios` must run. It moves today's predicate over
  verbatim, as #503 leaves it: a PR or merge-group diff from the merge base that touches `ios/`
  or `.github/workflows/ci.yml`. Push, schedule and dispatch always run `ios`, as today. A test
  in the gate runs that exact script.
- `ios`: `needs: changes` and a job-level `if:` that fails closed. `ios` is skipped only when
  `changes` succeeded and said `false`. A `changes` that failed, was cancelled or timed out, or
  wrote nothing makes `ios` run and fail. It never skips, because a skipped job satisfies a
  required check.
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

### M1 — the iOS-path decision moves to ubuntu
- [x] A `changes` job: `runs-on: ubuntu-latest`, `timeout-minutes: 5`, checkout with
  `fetch-depth: 0`, one output `ios`. Its script sits between `# ios-paths:begin` and
  `# ios-paths:end` comment lines, and it writes `ios=true` or `ios=false` on every path:
  - on any event other than `pull_request` and `merge_group`, `true`;
  - on those two, `false` exactly when
    `git diff --quiet "$(git merge-base origin/main HEAD)" HEAD -- ios/ .github/workflows/ci.yml`
    succeeds;
  - anything else, including a failed merge-base, `true`.
- [x] `scripts/__tests__/ci-ios-paths.test.ts` reads `ci.yml` and extracts the script between
  the markers. It runs it in a temp git repo with `GITHUB_EVENT_NAME` and `GITHUB_OUTPUT` set,
  for five cases:

  | Case | Output |
  |---|---|
  | web-only change | `false` |
  | a file under `ios/` | `true` |
  | `.github/workflows/ci.yml` | `true` |
  | `push` event with an empty diff | `true` |
  | no merge base | `true` |

  The test fails if the markers are missing.
- [x] `ios` has `needs: changes` and
  `if: ${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.ios != 'false') }}`.
  Use `!= 'false'`, not `== 'true'`: an output that was never written reads as `''`, and
  `== 'true'` would skip the job.

  Its first step runs `if: needs.changes.result != 'success'` and exits 1 with an `::error::`
  naming the `changes` job.
- [x] The step "Skip when a pull request changes no iOS paths" and every `env.skip` condition
  are gone. Three conditions stay as they are:
  - the cache save keeps `github.ref == 'refs/heads/main' && steps.swiftpm.outputs.cache-hit != 'true'`;
  - the result upload keeps `if: always()`;
  - nothing else in the job changes.
- [x] The comments hold whether or not `ios` is required yet:
  - Say what the job-level skip and the fail-closed rule are for.
  - Drop #503's "ios is not a required check and nothing waits for it", which lives on the
    deleted step.
  - `coach-gate`'s "Same reasoning as the ios job above" stops pointing at a job that no longer
    skips internally. It states its own reason.
- [x] Before merge, evidence by run id in the PR body (#515: its own run 40790077183; the probe
  run ids are in the Session log):
  1. This PR's own run. It edits `ci.yml`, so `changes` says `ios=true` and `ios` builds and
     passes.
  2. Three pushes to one throwaway draft PR. In none of them may `ios` come out SKIPPED:
     - (a) the `changes` step forced to `exit 1`;
     - (b) `changes` with `timeout-minutes: 1` and a `sleep 120`. This proves `cancelled()` is
       false when a needed job times out.
     - (c) `changes` succeeding without writing `ios=`.

     For (a) and (b), `ios` ends FAILURE at the fail-closed step, with the `::error::` naming
     `changes`. For (c), `ios` gets past that step and builds.

  How to make the throwaway: from the M1 lane, run
  `git worktree add .claude/worktrees/throwaway-ios-skip -b throwaway/ios-skip HEAD`. Commit
  there, `git push -u origin throwaway/ios-skip`, then
  `gh pr create --draft --base main --head throwaway/ios-skip`. The babysitter skips drafts.

  Afterwards, `gh pr close <n> --delete-branch` and
  `git worktree remove .claude/worktrees/throwaway-ios-skip`. Then confirm `git log main..throwaway/ios-skip`
  shows only throwaway commits, and run
  `APEX_DESTRUCTIVE_OK=1 git branch -D throwaway/ios-skip`.

  Neither the web-only `false` path nor the `ios/` path can be proven on a PR before M1 merges.
  Any such PR carries M1's `ci.yml` change, which is itself an iOS path. The test above proves
  the script; the boxes below prove the wiring.
- [x] After merge, check three runs: the first `main` push run containing M1's merge commit, the
  first web-only PR, and the first PR touching only `ios/`. Record each run id in the session
  log. Read each `ios` job with
  `gh api repos/shanehaynes/apex-training/actions/runs/<id>/jobs --jq '.jobs[]|select(.name=="ios")|{conclusion,runner_name,steps:(.steps|length)}'`.

  | Run | Expected |
  |---|---|
  | main push | `changes` says `ios=true`; `ios` built and tested |
  | web-only PR | `skipped`, `null`, `0` |
  | `ios/`-only PR | `ios` built and tested |
- [x] `docs/ios/testing-and-ci.md`:
  - The job snippet and the "Why the early-exit instead of `on.paths`" paragraph describe the
    job-level skip and why it fails closed.
  - Drop #503's sentence that `merge-babysit.sh` does not count `cancelled` as red. #507 makes
    it false.
- [x] `.claude/skills/parallel-agents/references/integration.md`'s rule "Use an always-running
  job that skips internally" names the exception. When the job's runner is scarce (macOS),
  decide the paths on ubuntu and skip at job level, failing closed. If #506 has merged,
  `scripts/ios-ci-headroom.mjs`'s "finishes the job in seconds" comment says a web-only PR's
  `ios` is skipped at job level.

### M2 — the babysitter counts a skipped required check as passed
- [x] In `required_green` (`scripts/merge-babysit.sh`), a required context whose verdict is
  SKIPPED or NEUTRAL passes, like SUCCESS. An unknown verdict stays pending.
- [x] A new describe block in `scripts/__tests__/merge-babysit.test.ts`. It gets its own
  required list, `check e2e-mock full coach-gate ios`, and leaves #507's block and its
  `REQUIRED` alone. Cases:
  - a web-only PR whose `ios` is COMPLETED/SKIPPED folds in fleet mode and reads WOULD MERGE
    from a serial CLEAN;
  - an iOS PR whose required `ios` is IN_PROGRESS waits;
  - a newest required `ios` that is CANCELLED is SKIP "(required; cut off …)".
- [x] Run against the pre-M2 script, the skipped-required cases fail (named in the PR body).
- [x] The `required_green` comment reads true before and after M3: say what waiting only on
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
- [ ] The read-back
  `gh api repos/shanehaynes/apex-training/branches/main/protection/required_status_checks --jq '{strict, checks:[.checks[]|"\(.context):\(.app_id)"]}'`
  shows all five at 15368 and `strict` unchanged.
- [ ] The protection bites. On an iOS PR whose `ios` is IN_PROGRESS while the other required
  checks are green, `gh pr view <n> --json mergeStateStatus` reads BLOCKED (UNSTABLE before the
  flip). On a web-only PR with `ios` SKIPPED, it reads CLEAN. Both reads go in the session log.
- [ ] One web-only PR and one iOS PR merge through the babysitter after the flip, and the web
  one never WAITs on `ios`. Log lines go in the session log.
- [ ] Memory `apex-ios-ci-timing` says `ios` is required.

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it). It never runs `ci.yml`, so
`ci-ios-paths.test.ts` proves the predicate, and the real runs in M1's boxes prove the wiring.
M3's proof is the read-back, the two `mergeStateStatus` reads and the two merges. M1 and M2
touch held paths (`.github/`, the merge actor): each needs Shane's `shipit`.

## Done means
Every box above checked, every PR merged, `scripts/git-tidy.sh --yes` run,
and the Next brief section below filled in.

## Decisions
- 2026-10-28 · Fail closed inside `ios` rather than also requiring `changes`. That keeps one
  required check instead of two, and it costs a macOS runner only on the rare run where
  `changes` fails.
- 2026-10-28 · `outputs.ios != 'false'`, not `== 'true'`. A missing output must run the job,
  never skip it (found in review).
- 2026-10-28 · Keep the predicate in `git diff`, moved verbatim, rather than a paths-filter
  action. No new dependency, and exactly today's behaviour.
- 2026-10-28 · Test the predicate by extracting it from `ci.yml` between marker comments, not
  with a YAML parser. None is installed, and adding one is a held manifest change.
- 2026-10-28 · M3's flip uses PATCH with the full `checks` list (app 15368), not the `contexts`
  endpoint. That keeps the new check pinned to GitHub Actions like the other four.
- 2026-10-28 · This departs on purpose from the parallel-agents rule "always-running job that
  skips internally". The internal skip needs a runner of the job's own kind, and macOS runners
  are the scarce ones. M1 records the exception in the rule.
- 2026-10-28 · A whole-run cancel, by hand or by a newer push, leaves `ios` `cancelled` with no
  runner and 0 steps; it does not run `ios` to its fail-closed step (probe d). Scope's "a
  `changes` that … was cancelled makes `ios` run and fail" holds for a `changes` timeout, which
  GitHub reports as `cancelled` while `cancelled()` stays false (probe b). The property that
  matters, never SKIPPED, holds both ways, and `cancelled` fails a required check.
- 2026-10-28 · `ci-ios-paths.test.ts` also pins the wiring line by line: the step's whole `run:`
  block is the marked script, with keys `id` and `run` only; the `changes` checkout has
  `fetch-depth: 0`; and `ios` has its job-level `needs:`/`if:` and the fail-closed first step.
  Review showed that substring checks let a moved `if:` and a line above the begin marker
  through. GitHub's semantics are still proven only by real runs.
- 2026-10-28 · `ios` keeps its checkout's `fetch-depth: 0` ("nothing else in the job changes"),
  although only the deleted skip step needed full history. Nothing in the CI build reads it
  (`testflight.sh`'s `git rev-list --count` runs locally). Dropping it would save a full-history
  fetch on macOS: a one-line follow-up, and a `ci.yml` PR that runs `ios` in full.
- 2026-10-29 · M2: a required SKIPPED or NEUTRAL passes for every required check, and the newest
  run of a name decides, as before. So a newer SKIPPED replaces an older red run of the same
  check. That is needed: a `changes` flake fails `ios` closed, and once the re-run decides
  `false`, its SKIPPED must clear the PR. The cost (found in review) is that a CI run
  dispatched by hand on a PR branch skips the event-only `coach-gate`, and that SKIPPED would
  then replace a failed `coach-gate`. Accepted: one dispatch ever, on `main`, and branch
  protection is believed to read the newest run the same way (not probed).

## Session log
- 2026-10-28 · Spec drafted from the #507 investigation. Reviewed once (two major findings:
  M1's pre-merge web-only proof was impossible, and `== 'true'` failed open); both fixed here.
  Nothing implemented.
- 2026-10-28 · M1 implemented in #515 (`chore/ios-skip-on-ubuntu`, HELD for `shipit`).
  - Gate: `agent:check` green on every commit. The gate test kills 11 `ci.yml` mutants.
  - Reviewer (spec plus diff only): five minor findings, all fixed in e6879326. Three were test
    gaps (always-true events beyond push, lines outside the markers, unpinned indentation and
    `fetch-depth`), one was wording (whole-run cancel), and one a temp-dir leak.
  - Probes on throwaway draft #513 (`throwaway/ios-skip`, one push each; `ios` never SKIPPED):
    - (a) 18f6bec2, `exit 1`: run 40785822725. `changes` failure; `ios` FAILURE at step 2,
      "Fail when the changes job did not decide", `::error::The changes job ended 'failure', …`.
    - (b) d9e4dc1a, `timeout-minutes: 1` + `sleep 120`: run 40785944133. `changes` cancelled
      ("exceeded the maximum execution time of 1m0s"); `ios` ran and failed at step 2,
      "… ended 'cancelled' …".
    - (d, extra) d7c1aafc, run cancelled by hand while `changes` decided: run 40786328739.
      `ios` cancelled, runner null, 0 steps; check run 123161562358 completed/cancelled.
    - (c) 97d6f6c1, `changes` exits 0 without writing `ios=`: run 40786730850. Step 2 skipped;
      checkout, Xcode, xcodegen, cache and sync ran, and "Build and test" ran. Its conclusion
      is in #515's body.
  - Not yet: #515's own green run (its PR body), and the three after-merge run ids (main push,
    first web-only PR, first `ios/`-only PR). Their box stays open until someone reads them
    after the merge.
- 2026-10-29 · #510 and #515 merged (11:48–11:49Z). M2 implemented on
  `fix/babysit-skipped-required`, from a `main` with both.
  - `required_green`'s required loop passes `SUCCESS|SKIPPED|NEUTRAL`. Its comment now says what
    waiting only on required checks did, and why a required skip is trusted (CI fails it closed).
  - A new describe block has seven cases. On the pre-M2 script three fail: fleet web-only with
    `ios` SKIPPED, serial CLEAN web-only with `ios` SKIPPED, and NEUTRAL on `full`. Four
    near-miss mutants each fail exactly their own case: SKIPPED but not NEUTRAL, an unknown
    verdict passes, a skip passes only for `ios`, and a required FAILURE passes.
  - Reviewer (spec plus diff only): four minor findings. Two were test gaps, closed by the
    `full` NEUTRAL case and a required-FAILURE case. One was comment wording, fixed. The
    fourth, a newer SKIPPED replacing an older red run, is kept on purpose (Decisions).
  - M1 close-out (two of three read with the jobs-API command; both match the table):
    - main push: #515's merge commit 07aea30f got run 40868312181, which `main`'s concurrency
      group cancelled while it was still pending (no jobs). The first `main` run with M1 in it
      is #516's **40868335083** (head 47f4696e). `changes` logged `ios=true`, and `ios` read
      `{"conclusion":"success","runner_name":"GitHub Actions 1000008069","steps":13}`: built and
      tested in 29m26s. The whole run is green.
    - web-only PR: M2's own PR #517, run **40874065535** (head dc6aab9b). `changes` logged
      `ios=false`, and `ios` read `{"conclusion":"skipped","runner_name":null,"steps":0}`. Every
      other check is green, and the rollup shows `ios=SKIPPED`.
    - `ios/`-only PR: none had run since the merge, so Shane OK'd a throwaway draft, #518
      (`throwaway/ios-only` off 47f4696e). It changed one doc-comment line in
      `ApexCore/Nutrition/Nutrition.swift`. Run **40888121776**: `changes` logged `ios=true`.
      - Attempt 1 ran on image macos-26-arm64 20261021.0445. "Build and test" failed after 2
        minutes: `xcodebuild` saw no simulator devices at all, only placeholders, so the pinned
        `iPhone 17, OS=26.5` destination failed (exit 70). That was one bad machine, not M1
        or the image: #515's own run and probe (c) both found the destination on that same
        image the day before.
      - `gh run rerun --failed` gave attempt 2 (image 20261013.0424). The jobs-API command read
        `{"conclusion":"success","runner_name":"GitHub Actions 1000008090","steps":13}`, with
        `** TEST SUCCEEDED **` in 41 minutes.
      - Afterwards #518 was closed, the branch deleted on origin and locally (only the one
        THROWAWAY commit was its own), and the worktree removed without force.
    - All three rows match M1's table, so its last box is ticked.
  - Not M1's, but worth knowing for M3: once `ios` is required, a runner that comes up with no
    simulators makes `ios` red until it is re-run, and M3's "a red `ios` blocks its PR" includes
    that. If it recurs, give the destination step one retry after
    `xcrun simctl list devices available`.

## Next brief
**M3 — require `ios`.** Shane runs the flip; a session checks before it and verifies and logs
after it. It starts once M2's PR has merged.
- **Goal:** `ios` is a required status check on `main`, pinned to GitHub Actions (app 15368)
  like the other four. Then `gh pr merge` and the web UI refuse an iOS PR whose `ios` has not
  passed, while a web-only PR, whose `ios` is a job-level SKIPPED, merges without waiting.
- **Before the flip (session, read-only):**
  - M1 is closed: all three after-merge rows are read (Session log, 2026-10-29).
  - Confirm `main`'s newest push run is green on `changes` and `ios`, and log the current
    protection read-back (`strict` and the four checks).
  - If anything reads differently from M1's table, stop and report.
- **The flip (Shane):** the PATCH in M3's second box. It is reversible by re-sending the list
  without `ios`. Remind him what he accepts, from the Goal section: a red `ios` blocks its PR,
  and a `ci.yml` PR waits on a full `ios` run.
- **After the flip (session):** the read-back shows five checks at 15368 and `strict`
  unchanged. Then read `mergeStateStatus` twice: BLOCKED on an iOS PR with `ios` IN_PROGRESS
  and the other required checks green, and CLEAN on a web-only PR with `ios` SKIPPED. One
  web-only PR and one iOS PR merge through `scripts/merge-babysit.sh --yes`, and the web one
  never WAITs on `ios`. Log lines go in the Session log. Update memory `apex-ios-ci-timing` to
  say `ios` is required, set Status to done, and run `scripts/git-tidy.sh --yes`.
- **Lane:** docs only.
  `scripts/git-new.sh chore/ios-required-m3 "docs/specs/ios-required-check.md M3 + M1 close-out log"`.
  The `reviewer` agent runs before `gh pr create`. Never touch branch protection yourself.
