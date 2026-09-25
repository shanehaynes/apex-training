# O08 — Workout detail tips + `repeating-workouts` page

**Wave:** 2 · **Depends on:** O03, O04 · **Unblocks:** —
**Status:** ready · branch `feat/help-workout` · port 5222 · lock slot e2e_slot_3

## Tips (`src/lib/onboarding/tips/workout.ts`)
| id | trigger | condition |
|---|---|---|
| workout-first-open | `WorkoutModal` | first mount |
| workout-recurring | `WorkoutModal` | `live.isRecurring` (beats workout-first-open by the conditioned rule) |
| workout-sync-metrics | `SyncMetrics` | first render with a streams row |

## Help page `help/repeating-workouts.md`
Problem: "I changed Tuesday and it changed every Tuesday." Shots (mock):
01 RepeatPicker On + days + Ends Never (drive the builder UI; do not edit `builder/`),
02 a recurring seed workout open with **Edit exercises** / **Edit workout**,
03 the exercise editor's "applies to every occurrence" note,
04 **This event only** / **Whole series**, 05 delete scope. Close with a small table: what
changes where.

## Ownership
`src/components/modal/*` except `DayModal.tsx`, `src/lib/onboarding/tips/workout.ts`,
`help/repeating-workouts.md`, `public/help/repeating-workouts/`,
`e2e/shots/repeating-workouts.shots.ts`, `src/styles/help/repeating-workouts.css`,
`e2e/mock/tips-workout.spec.ts`, this file.

## Session log
- 2026-09-24 · feat/help-workout · Tips wired: `WorkoutModal` registers `workout-first-open`
  (unconditioned) and `workout-recurring` (`when` = the live event repeats) above its early
  return; `SyncMetrics` registers `workout-sync-metrics` once a streams row arrives. Copy
  rewritten to the rules (imperative first; the sync tip no longer claims watch numbers count
  toward records — they feed Analytics HR zones, not PRs). Page + 5 phone shots and one desktop
  (02, the modal over the month grid); e2e `tips-workout.spec.ts` stubs `activity_streams` for
  the P1 tip. Found: on a phone the "Finish setting up" nudge covers the **+** menu's items
  (the shots spec closes it first) — reported, not fixed (outside this lane).
- 2026-09-25 · orchestrator. Merged as #329; "This event only" → "This day only" and est. 1RM wording follow in #338.
