# Per-set fields — plan

How `requirements.md` gets built, in what order. One PR per milestone, the
babysitter between milestones.

**Owns:** `src/lib/builder/plannedSets.ts`, `src/components/modal/PlannedSetsEditor.tsx`,
`src/styles/planned-sets.css`, `resolvePlannedSets` in `src/lib/tracking/plan.ts`,
the per-set rest helpers in `src/lib/tracking/rest.ts`, `claimRest` in
`src/hooks/useRestTimer.ts`, the rest line in `src/components/tracker/TrackerExercise.tsx`,
`PlannedSet` in `src/types/workout.ts`, `ApexCore/Schedule/PlannedSets.swift`,
`PlannedSet` in `ApexCore/Models/Tracker.swift`, `Builder/PlannedSetsEditor.swift`,
the rest line in `Tracker/TrackedExerciseView.swift`, `restCommitted` in
`Tracker/TrackerModel.swift`, `ExerciseRow` in `Schedule/EventSheet.swift`,
`e2e/mock/planned-sets.spec.ts`.
**Forbidden:** gate-protected paths, `src/styles/app.css`, the coach and MCP tools (M2).
**Depends on:** none
**Status:** in review (M1)

## Approach
Extend the existing Per-set targets table instead of adding a second
mechanism. `PlannedSet` gains `targetRest`; the stored exercises are JSONB,
so no migration. A row now holds overrides only: the editor starts from
blank rows whose cells show the set-level value as their placeholder, and
writes `plannedSets` only while some row overrides something
(`storedSets`). `resolvePlannedSets` fills an authored row's empty weight,
reps and duration from the exercise, the one place every consumer (tracker
model, Finish zero-fill, MCP `log_workout`, `fields.ts`, `%1RM`) reads
through. Rest is not filled there, since no set log records it and the
bootstrap fixtures stay as they are: `restFor` reads the row's rest, else
`restPeriod`, for the timer and the card's rest line. The editor offers
"+ Reps", "+ Duration", "+ Rest" for the columns not shown. iOS mirrors
each pure function in `PlannedSets.swift` with the same vectors; its
tracker reads the server-resolved rows from the bootstrap. No
`TECHSTACK.md` row is touched.

## Milestones

### M1 — Every field per set, planned and timed
Delivers: R1, R2, R3, R4, R5, R6
- [x] `targetRest` exists on both models and the Rest column edits it in both editors.
- [x] Both editors offer every column not shown, and an empty cell shows what it follows.
- [x] `resolvePlannedSets` fills empty fields; the editor stores no all-blank table.
- [x] The rest timer and the card's rest line read each set's rest, web and iOS.
- [x] The iOS event sheet shows resolved per-set values.

### M2 — The coach and MCP carry per-set targets
Delivers: (a new requirement set, drafted in Next brief)
- [ ] Not started.

## Decisions
- Extend Per-set targets rather than make each base field editable per set inline: the table, presets and storage already exist, and the card stays one row for a uniform plan (Article I).
- Overrides, not copies: an empty cell follows the base, so "Apply to all sets" did the same as "Remove per-set targets" and was removed.
- Rest is resolved at the consumer (`restFor`), not merged into planned rows: set logs have no rest column and the iOS bootstrap fixtures keep their shape.
- Added columns live in the editor's state until a cell holds a value; an empty added column is not stored (nothing to store).
- The rest line runs use "×n" and "none" for a set without rest; it is the athlete's text, never parsed or recomputed.
- Column order is fixed (weight, reps, duration, rest), matching the card.
- A rest preset writes seconds ("90s") when neither the input nor the base names a unit, and steps by 5 s or half minutes, because the timer reads no bare number (ruling R2.5 stays strict). A rest cell typed without a unit gets a one-line note under the table that no timer starts for that set, rather than a silent rewrite of the athlete's text.
- A set-count change that leaves no override stores no table, on both platforms (review finding).
- The iOS event sheet's per-set line shows a row's rest, so a table that varies only rest does not read as identical sets.

## Session log
- 2026-11-17 · M1 built on `feat/per-set-fields`. Not verified here: Playwright (the sandbox cannot download a browser; CI runs `e2e/mock/planned-sets.spec.ts`) and Swift (no toolchain on this Linux box; CI's `swift test` and the iOS job build it).
- 2026-11-17 · Reviewer findings fixed on the same branch: rest presets and unitless rest, empty table after a shorter count, rest step, rest on the iOS event sheet. Not fixed: the iOS tracker and event-sheet wiring have no test of their own (helpers are tested; a TrackerModel test is in the next brief), and retyping Sets passes through intermediate counts (older than this branch).

## Learned

## Next brief
M2, the coach and MCP carry per-set targets. Today `EXERCISE_INPUT_SCHEMA`
(`src/lib/coach/schemas.ts`) has no per-set field, `buildExerciseEntries`
(`src/lib/coach/tools.ts`) builds entries without `plannedSets`, so a
coach or MCP `set_event_exercises` call drops any table the athlete
authored, and `get_schedule` (`api/_lib/mcp/tools/schedule.ts`) and the
coach's schedule context never show one. Write requirements for: (1) an
optional `planned_sets` array on the exercise input (`set_number`,
`weight`, `reps`, `duration`, `rest`, each an override of the entry's own
field), validated the way the editor stores it (`storedSets`, set numbers
1..n); (2) `set_event_exercises` keeping an existing entry's `plannedSets`
when the call names the same exercise and sends no `planned_sets`, resized
to the new `sets`; (3) `get_schedule` and the coach context listing each
set's resolved targets when a table exists. It is a coach tool change, so
the `eval-analyst` agent runs the coach evals before it ships, and the
confirmation card must show the per-set values the athlete is approving
(Mission VII).

Also in M2 (iOS proof gap from review): a `TrackerModel` test that commits
a set whose row rests "3 min" under an exercise resting "90s" and expects a
180 s timer, and an event-sheet test over rows that leave weight empty.
