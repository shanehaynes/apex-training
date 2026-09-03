# W7 — Event CRUD + workout builder

**Machine:** Mac · **Depends on:** W5b, W2 · **Unblocks:** —
**Status:** blocked on W5b, W2

## Goal
Everything the web's `WorkoutBuilderView`, `BuilderForm`, `RepeatPicker`, `EventExerciseEditor`
and `WorkoutModal` edit paths do, as sheets with native pickers and a real drag reorder.

## Scope
In:
- Event sheet edit paths: inline title/date/time, difficulty, Edit exercises, Edit workout,
  Delete (occurrence vs series), reschedule instance.
- Builder sheet: template search (substring only, type chips, archive, "Build '<q>'"), form
  (type/sport/scoring chips, title, date, duration, start/end, repeat, climbing/cardio fields,
  location, tags, description, difficulty), scope bar for recurring edits.
- `ApexCore.Repeat` (port of `builder/repeat.ts` with its test vectors).
- Exercise sections editor: `List` + `.onMove`, prescription row, superset toggle
  (server re-letters), remove; exercise picker (exact-match-or-create, inline create).
- Builder coach drawer: `ChatSession(mode: .builder)`; the draft lives as JSON and is reduced
  by `/api/coach-tool`; Apply is the gate.
- Templates: apply from search; "save as template" (`/api/workout-templates`).
Out: meals composer (W10).

## Backend contract consumed
`/api/events`, `/api/event-instances`, `/api/workout-templates`, `/api/exercise-definitions`
(create from picker), `/api/coach-tool` (draft reduce), `/api/chat` builder mode.

## Acceptance
- `swift test`: `Repeat` vectors; draft JSON round-trips through the server reducer fixture.
- Snapshots: builder form, exercise editor with superset, picker create state, scope bar.
- Device: create a recurring workout, edit one occurrence, edit the series, delete an
  occurrence — web shows the same result each time.

## Session log
- (none yet)
