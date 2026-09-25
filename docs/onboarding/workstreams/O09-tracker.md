# O09 — Tracker tips + `logging-a-workout` page

**Wave:** 2 · **Depends on:** O03, O04 · **Unblocks:** —
**Status:** ready · branch `feat/help-tracker` · port 5223 · lock slot e2e_slot_1

## Tips (`src/lib/onboarding/tips/tracker.ts`)
| id | trigger | condition |
|---|---|---|
| tracker-first | `TrackerView` | first mount |
| tracker-shadow | `TrackerView` | any set or cardio row has a `shadow` (last-session) value |
| tracker-unlogged | `ConfirmBar` | first render of the unlogged-sets bar |
| summary-first | `WorkoutSummary` | first mount |

The tip must never cover **Finish** or the active set's inputs on a phone; if the card's
default placement does, report it (TipCard is O03's) rather than restyling locally.

## Help page `help/logging-a-workout.md`
Problem: Start vs Mark as Complete, what the grey numbers are, what trophies mean. Shots
(mock): 01 workout modal buttons, 02 grey last-time numbers, 03 one set typed and one still
grey, 04 the unlogged bar after Finish, 05 summary with a trophy (stub `prs` non-empty via
`page.route` — check `e2e/mock/tracker.spec.ts` for the shape), 06 desktop tracker. Mention
swap exercise, add set, editing a finished workout.

## Ownership
`src/components/tracker/*`, `src/lib/onboarding/tips/tracker.ts`, `help/logging-a-workout.md`,
`public/help/logging-a-workout/`, `e2e/shots/logging-a-workout.shots.ts`,
`src/styles/help/logging-a-workout.css`, `e2e/mock/tips-tracker.spec.ts`, this file.

## Session log

### 2026-09-24 — tips wired, page + shots written
- Sites: `tracker-first` / `tracker-shadow` in `TrackerTips` (a null-rendering child of
  `TrackerView`), rendered only while the session is loaded, unfinished and uncovered (no
  confirm bar, score step or summary) — so both register in one commit and the conditioned
  shadow tip wins, and neither rides along behind the calendar, where `TrackerView` stays
  mounted. `tracker-unlogged` via a new optional `tip` prop on `ConfirmBar` — only the
  unlogged-sets bar passes it; the cancel confirm shares the component and stays silent.
  `summary-first` on `WorkoutSummary` mount.
- Focus hold: nothing in the tracker autofocuses on open (only `ExercisePicker` and
  `ScorePrompt` do, and no tip is offered while those are up), so the 600 ms settle lands
  before a user can be typing; tap a box inside that window and the card waits for blur.
- Phone placement (TipCard is O03's, unchanged): the sheet sits well below **Finish**. It
  covers the lower set rows, but only while no input has focus. Over the unlogged bar the
  sheet overlaps the bar's message line by ~16px; **Keep going** / **Finish anyway** stay
  visible (dimmed) below it.
- Shots: one stubbed "Upper Body" workout (bench, pull-ups, row) with believable last-time
  numbers replaces the seed, whose warm-ups bury the main lifts. 01–05 phone, 06 desktop.
- `e2e/mock/tips-tracker.spec.ts`: one load per tip, profile stub marks every other tip seen.
- 2026-09-25 · orchestrator. Merged as #330; summary record line reworded in #338.
