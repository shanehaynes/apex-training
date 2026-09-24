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
