# Runaway sessions stopped at Finish — validation

How each requirement is proven, decided before the code.

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it). M2 adds
the iOS suite (`xcodebuild … test` on a Mac, CI's `ios` job) and the Linux
ApexCore gate (`swift test --package-path ios/Packages/ApexCore`).

## Requirement proofs

| Req | Proof | Kind | Status |
|---|---|---|---|
| R1 | `src/lib/tracking/__tests__/runawayFinish.test.ts` › "isRunaway / detectRunaway: <case>" over every case in the shared vectors (the bounds at exactly 4× and exactly 2 h, no / zero / negative plan, the four measured runaways flagged, the longest normal sessions at 2.31× and 1.57 h not) and › "a non-finite plan or elapsed time is never a runaway" | unit | proven (#555) |
| R2 | same file › "suggestFinish and the labels: <case>" over every vector (last logged inside the span wins; at the start, before it, after now or null falls back to start + plan, clamped to now; no plan → now) and › "a non-finite last log falls back to the plan" | unit | proven (#555) |
| R3 | `api/__tests__/workout-sessions-runaway-finish.test.ts` › "bootstrap — lastLoggedAt (R3)": "is the latest updated_at among the set and cardio rows the athlete logged" (an autofilled row ignored; a later cardio row wins) and "is null with nothing logged"; `runawayFinish.test.ts` › "latestLoggedAt"; the regenerated `ios/Fixtures/bootstrap*.json` carry the key and the emitter passes in compare mode | unit + fixture | proven (#555) |
| R4 | same handler file › "finish — the window reaches back to the session start (R4)": "accepts a finishedAt older than a week when it is inside the session", "accepts a finishedAt exactly at a start older than a week", "400s timestamp-out-of-window for a finishedAt before both the week and the start", "400s a finishedAt inside the week but before the start, as before", "still 400s a finishedAt in the future, however old the start", "keeps the week for a session whose start does not parse"; the existing window tests in `workout-sessions.test.ts` pass unchanged | unit | proven (#555) |
| R5 | `e2e/mock/tracker-runaway-finish.spec.ts` › "a runaway finish asks when it ended, defaulting to the last logged set" (no finish sent while the prompt is up; the text names elapsed and plan; the field holds `lastLoggedAt`), › "with nothing logged the default is the start plus the plan", › "a set logged this sitting moves the default to now", › "Finish tapped again while the prompt is up offers the set just logged", › "the unlogged-sets confirm comes first, then the prompt"; the bootstrap stamp is served in PostgREST's `+00:00` shape, and the vector file has a case in it | e2e (mock) | proven (#555) |
| R6 | same spec › the first test (an empty field, a time before the start and a time after now each disable the action; a chosen time is sent as that minute; the header shows the length it makes, at phone width), › "accepting the default sends the last logged instant to the millisecond" (header 25:30, summary 26 min), › "a finish that fails keeps the chosen end for the next Finish" | e2e (mock) | proven (#555) |
| R7 | same spec › "It ran … finishes as before; Keep going records nothing": no `finish` request after Keep going; no `finishedAt` key after It ran | e2e (mock) | proven (#555) |
| R8 | same spec › "a session under the threshold finishes with no prompt and no finishedAt" | e2e (mock) | proven (#555) |
| R9 | same spec › "a For Time score after a corrected finish prefills the corrected length" (24:30, sent as 1470 s with the chosen `finishedAt`) | e2e (mock) | proven (#555) |
| R10 | `ios/Packages/ApexCore/Tests/ApexCoreTests/RunawayFinishTests.swift` › `testEverySharedVector` and `testTheVectorsStateTheRuleThePortHolds` read `Fixtures/runaway-finish.json` (the file R1's vitest reads), plus `testTheBootstrapCarriesLastLoggedAt`; run on macOS and Linux (`swift:6.1`); D-061 in `docs/ios/decisions.md` | unit (Linux + Mac) | proven (feat/tracker-runaway-finish-ios, M2 PR) |
| R11 | `ios/ApexTests/TrackerModelTests.swift` › `testARunawayFinishAsksWhenItEndedBeforeAnythingIsQueued` (PostgREST-shaped stamp), `testTheUnloggedConfirmComesBeforeTheRunawayCard`, `testASetLoggedThisSittingMovesTheSuggestion`, `testFinishAgainWhileTheCardIsUpOffersTheSetJustLogged` (the header's unforced call), `testRemovingASetDoesNotMoveTheSuggestion`, `testAFreshBootstrapLandingUnderTheCardRedetects`, `testTheChosenEndIsQueuedAndEverythingElseUsesIt` (queue, summary, cache, activity end, Health draft), `testAChosenEndOutsideTheSessionIsClampedToIt` (a `.001` start sent as itself; `IsoTimestampTests` round-trips every millisecond), `testAForTimeScoreAfterACorrectedFinishPrefillsTheCorrectedLength`; `ios/ApexUITests/SmokeUITests.swift` › `testRunawayFinishAsksWhenItEnded` (the card on fixtures, screenshot `11-tracker-runaway-card`) | unit + UI (simulator) | proven (feat/tracker-runaway-finish-ios, M2 PR) |
| R12 | same file › `testItRanThisLongFinishesNowAsBefore`, `testKeepGoingQueuesNothingAndTheNextFinishAsksAgain`, `testASessionAtTheThresholdFinishesWithNoCard`; every pre-existing finish test passes unchanged (30 minutes in, never a runaway) | unit (simulator) | proven (feat/tracker-runaway-finish-ios, M2 PR) |

## Beyond the gate
- A screenshot of each client's prompt for the PR (the e2e `shot`, and
  `ios/scripts/screenshots.sh` or a simulator capture). The session proves it.
- Production: after M1 deploys, the next runaway Shane finishes is the live
  proof; `list_sessions` should show no new session over 4× its plan and
  2 hours that he did not choose. Shane, by use, not a scheduled check.

## Done means
Both milestone boxes checked, every proof above proven, both PRs merged,
`scripts/git-tidy.sh --yes` run, the Next brief filled in, and the replan
opened (`docs/workflow-essentials.md`, "Replanning").
