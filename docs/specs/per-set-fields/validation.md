# Per-set fields — validation

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it).

## Requirement proofs

| Req | Proof | Kind | Status |
|---|---|---|---|
| R1 | `src/lib/builder/__tests__/plannedSets.test.ts` "shows rest when the base or a row names it", "carries a row's rest like any other override", "presets on rows that follow the base"; `PlannedSetsTests.swift` `testFieldsShowRestWhenTheBaseOrARowNamesIt`, `testSettingWritesOnlyTheOverrideOnABlankRow`; `e2e/mock/planned-sets.spec.ts` (Rest column, PATCH carries `targetRest`) | unit · e2e | proven (this branch; e2e and Swift in CI) |
| R2 | `plannedSets.test.ts` "adds the columns asked for, in table order", `addableFields`; `PlannedSetsTests.swift` `testFieldsAddTheColumnsAskedForInTableOrder`, `testAddableIsEveryColumnNotShown`; `planned-sets.spec.ts` ("+ Rest", reopened header keeps Rest) | unit · e2e | proven (this branch; e2e and Swift in CI) |
| R3 | `plannedSets.test.ts` `inheritedTarget`, `blankSets`, `storedSets`, "writes only the override on a blank row"; `src/lib/tracking/__tests__/plan.test.ts` "fills what an authored row leaves empty…"; `PlannedSetsTests.swift` `testStoredKeepsRowsWhileAnyOverridesSomething`; `planned-sets.spec.ts` (placeholder follows a base edit, PATCH holds overrides only, tracker plans "× 5") | unit · e2e | proven (this branch; e2e and Swift in CI) |
| R4 | `src/hooks/__tests__/useRestTimer.test.ts` "a set with its own rest starts that rest…", "a set rest authored in the editor reaches the timer…"; `rest.test.ts` `restFor`; `PlannedSetsTests.swift` `testRestIsTheSetsOwnElseTheExercises` (`TrackerModel.restCommitted` calls it) | unit | proven (this branch; Swift in CI) |
| R5 | `rest.test.ts` `restSummary`, `restLine`; `PlannedSetsTests.swift` `testRestSummaryReadsOneValueOrRunsInSetOrder`, `testRestLineSummarizesPlannedSetsAndLeavesExtrasOut`; `planned-sets.spec.ts` ("Rest none ×4 · 3 min") | unit · e2e | proven (this branch; e2e and Swift in CI) |
| R6 | `PlannedSetsTests.swift` `testResolvedFillsWhatARowLeavesEmptyButNotRest` (`ExerciseRow` renders `PlannedSets.resolved`) | unit | proven (this branch; Swift in CI) |

## Beyond the gate
- CI's `ios` job builds ApexFeatures (the editor, tracker and sheet views have no Linux build).
- Shane: on his phone, add Reps and Rest to the Overhead Squat's table, save, and start the session.

## Done means
Every milestone box in `plan.md` checked, every proof above proven, every PR
merged, `scripts/git-tidy.sh --yes` run, the Next brief filled in, and the
replan opened (`docs/workflow-essentials.md`, "Replanning").
