# W7 — Event CRUD + workout builder

**Machine:** Mac · **Depends on:** W5b, W2 · **Unblocks:** —
**Status:** in progress (PR A `feat/w7-draft-endpoint`; B/C/D follow from the same worktree)

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
- 2026-09-10 · Mac · Plan and PR A. Landing as four stacked PRs from one worktree: **A** backend
  + Linux-provable ApexCore (this PR); **B** event-sheet edit paths, the "+" entry, the
  `/app/event` route, mock CRUD routes; **C** the builder sheet (template search, form, repeat
  picker, exercise editor, picker, coach drawer); **D** smoke legs, 0.6.0, docs, TestFlight
  dry-run. Plan of record: `~/.claude/plans/lets-get-a-plan-starry-llama.md` on Shane's Mac.
  Shane decided (2026-09-09): a server endpoint applies the draft; the web keeps its
  client-side Apply for now (#136); four PRs; TestFlight build 5 on his go.
  - **Corrections to this brief found on the way in:** "server re-letters supersets" was only
    true for the draft reducer and the coach executors — a direct `/api/events` or
    `/api/workout-templates` write stored whatever labels arrived (the fix was filed under
    W10; taken here). The schedule response could not key an occurrence write for a moved
    series anchor (bases are built from the first in-window occurrence, so no field carried
    the row date) — stubs now carry `originalDate`. `WorkoutTemplate` in ApexCore was a stub
    with a `name` the server never sends (never caught: `schedule.json` had `templates: []`).
    The web's builder coach auto-applies `update_workout_draft` with no confirmation card; the
    Swift session only knew the card path. `validateUnilateral` lived in a React component
    the API could not import. The web's `eventFieldsFromDraft` omits an unset end time rather
    than clearing it — mirrored, not fixed.
  - **Backend:** `POST /api/workout-draft` (`handlers/workoutDraft.ts` + `services/
    workoutDraft.ts`): validate (the web's toasts back as `ok:false` on 200, unilateral
    violations keyed by entry id) → template identity (draft id › case-insensitive title ›
    minted `wt-`) → upsert → create with the retro-log rule, or PATCH (one-off with schedule,
    series without) or detach (REPEAT_OFF, standalone row). `services/templates.ts`
    extracted; `services/supersets.ts` normalises sections on events insert/patch, templates
    upsert and detach; `originalDate` on `/api/schedule` stubs; `eventFromCreateInput` shared
    with serverDeps. 18 + 7 handler tests, superset cases on the events/instances suites,
    `originalDate` on the schedule suite.
  - **Fixtures (regenerated, never hand-edited):** a seeded template in `schedule.json`,
    `originalDate` on every stub, new `coach-tool-draft.json`, `workout-draft-{create,edit,
    detach}.json`, `chat-stream-builder.ndjson`.
  - **ApexCore (Linux-provable, 302 `swift test` cases):** `Schedule/Repeat` (12 vectors),
    `Supersets` (9), `Slug`, `Models/WorkoutDraft` (constructors, `withType`, the instant
    `problem`, the reducer-fixture round trip), `ScheduleIndex` mutators + `OccurrenceOverride`
    + `ScheduleEvent.keyDate`, `ScheduleEdit` (bodies + optimistic apply), `TimeLabel`
    `inputTime`/`stored`/`shiftedEnd` (no locale), `Endpoint` W7 writes + `coachTool(draft:)`,
    `CoachToolResponse.draft`, `ChatSession` builder path (`autoDraftTool`: reduce through
    coach-tool, `.draft` event, other tools auto-cancel; `.chat` unchanged), `WorkoutEventBase`
    / `Occurrence` fields now `var`, `WorkoutTemplate` real shape, `.afterEdit` reason.
    `Endpoint.json` no longer escapes slashes.
  - **Not done here:** everything Apple-side (B, C, D). No `xcodebuild` in this PR.
