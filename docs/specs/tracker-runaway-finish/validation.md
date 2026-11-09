# Runaway sessions stopped at Finish — validation

How each requirement is proven, decided before the code.

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it). M2 adds
the iOS suite (`xcodebuild … test` on a Mac, CI's `ios` job) and the Linux
ApexCore gate (`swift test --package-path ios/Packages/ApexCore`).

## Requirement proofs

| Req | Proof | Kind | Status |
|---|---|---|---|
| R1 | `src/lib/tracking/__tests__/runawayFinish.test.ts` › "isRunaway matches every shared vector": the bounds (exactly 4×, exactly 2 h), no / zero / negative / NaN plan, the four measured runaways flagged, the longest normal sessions (2.31×, 1.57 h) not | unit | not proven |
| R2 | same file › "suggestFinish matches every shared vector": last logged inside the span wins; before the start, after now or null falls back to start + plan | unit | not proven |
| R3 | `api/__tests__/workout-sessions-runaway-finish.test.ts` › "bootstrap carries the latest non-autofilled set or cardio updated_at as lastLoggedAt" and "… null with nothing logged"; the regenerated `ios/Fixtures/bootstrap*.json` carry the key | unit + fixture | not proven |
| R4 | same file › "finish accepts a finishedAt older than a week when it is inside the session", "… 400s timestamp-out-of-window before both the week and the start", "… 400s a finishedAt inside the week but before the start"; the existing window tests in `workout-sessions.test.ts` pass unchanged | unit | not proven |
| R5 | `e2e/mock/tracker-runaway-finish.spec.ts` › "a runaway finish asks when it ended, defaulting to the last logged set" (prompt text names elapsed and plan; the field holds `lastLoggedAt`; a set logged this sitting moves the default) and › "the unlogged-sets confirm comes first" | e2e (mock) | not proven |
| R6 | same spec › the first test: the `finish` body's `finishedAt` equals the field; the header and summary show the corrected length; the action is disabled for a time before the start | e2e (mock) | not proven |
| R7 | same spec › "It ran … finishes as before; Keep going records nothing": no `finishedAt` in the body; no `finish` request after Keep going | e2e (mock) | not proven |
| R8 | same spec › "a session under the threshold finishes with no prompt and no finishedAt" | e2e (mock) | not proven |
| R9 | same spec › "a For Time score after a corrected finish prefills the corrected length" | e2e (mock) | not proven |
| R10 | `ios/Packages/ApexCore/Tests/ApexCoreTests/RunawayFinishTests.swift` reads `Fixtures/runaway-finish.json` (the file R1's vitest reads); D-061 in `docs/ios/decisions.md` | unit (Linux + Mac) | not proven |
| R11 | `ios/ApexTests/TrackerModelTests.swift` › new cases: a runaway Finish gates on `.needsFinishTime` with the suggestion; the choice queues `finishedAt` = chosen and the summary, cache, activity end and Health draft use it; `lastLoggedAt` and a set edit this sitting move the suggestion | unit (simulator) | not proven |
| R12 | same file › new cases: "It ran" queues `finishedAt` = now; Keep going queues nothing; a session under the threshold queues the same payload as before with no gate | unit (simulator) | not proven |

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
