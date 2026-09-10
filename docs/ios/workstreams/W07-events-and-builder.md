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
- 2026-09-10 · Mac · PR B — the event sheet's edit paths, the "+", the route, the mock.
  - **EventSheet:** tap the title to rename (submit commits, empty/unchanged is a no-op); tap
    the day or the time for the schedule panel — native compact date/time pickers pinned to
    UTC (U9), the start drags the end along, an end at or before the start is refused with the
    web's toast before any request; the difficulty dots are 44pt targets (U1); Edit exercises /
    Edit workout buttons; Delete unfolds into the web's confirm (one-off "Delete workout";
    series "This day only" / "Whole series" / Keep). Delete this day = skip; the sheet closes
    on success.
  - **`ScheduleModel+Edits`:** `commit(_:)` (optimistic → request → rollback + toast → window
    write-back → `refresh(.afterEdit)`), `applyDraft(_:action:)` (create inserts the returned
    base + stub, update replaces, detach swaps; `ok:false` handed back; nil on transport
    failure), `archiveTemplate`, `createDefinition` (both rewrite their cache entries),
    `templates()`. `index` is `internal(set)` for the extension.
  - **`ApexFeatures/Builder/`:** `ExerciseSectionsEditor` (one `List`, three sections, edit
    mode on for real drag handles — U10 — every move/link/remove re-letters through
    `Supersets`, a prescription edit clears `plannedSets`, Add exercise / Add pitch),
    `ExerciseEditorRow` (sets/reps/weight · duration/rest, or style/grade/ascent for a pitch),
    `ExercisePickerSheet` (search over the cached library, category chips, exact-match-or-create
    with the inline category + unilateral form; the definition is created immediately, as the
    web does), `EditExercisesSheet` (series-wide; Save sends only the changed sections),
    `Entries` (the `definitions.ts` entry rules + `climbing.ts` vocab), `BuilderSheet` stub.
  - **`ScheduleTab`:** "+" in the navigation bar, "Add workout" on an empty day, long-press a
    month cell → `.builder(.create(date:))`; "Edit workout" / "Edit exercises" replace the
    event sheet (`pendingSheet`, the `pendingTracker` rule); `/app/event/<id>/<date>` consumed
    through `EventRouteResolver` (a miss is a toast, D-026).
  - **ApexUI:** `FormField` + `apexFieldChrome()`, `ChipRow`, `DateField`, `TimeField`,
    `FlowLayout` public, ten icons. **ApexCore:** `Exercise` prescription fields are `var` and
    it is `Identifiable`; `DayKey.fromUTCMidnight`.
  - **Mock:** `PATCH`/`DELETE /api/events`, `POST /api/event-instances`, `POST /api/workout-draft`
    (the fixture reshaped around the caller's draft, a fresh `ai-mock-N` id, one extra stub a
    week out for a series), `PATCH /api/workout-templates`, `POST /api/exercise-definitions`,
    coach-tool's draft reduce — every write replayed into later schedule reads.
  - **Tests:** 12 `ScheduleModelTests` edit cases; 5 new snapshots + the 3 event-sheet
    references re-recorded (the sheet gained the edit row and the delete link);
    `SmokeUITests.testEventEditsOnFixtures` (rename → delete the one-off → "This day only" on
    the series with next week still there → link the plank into the circuit's superset → the
    "+"; screenshots 17–22) green on the iPhone 17 Pro simulator.
  - **Found on the way in:** a deleted snapshot reference breaks the generated project's build
    (the PNGs are listed individually) — re-record with the file present or regenerate first.
    `repeat` is a Swift keyword (the draft property is `repeatRule`, coding key `repeat`).
  - **Not done here:** the builder itself (C), the builder smokes and 0.6.0 (D).
- 2026-09-10 · Mac · PR C — the builder sheet.
  - **`BuilderModel`:** one `WorkoutDraft` every input writes into (`update`), the search
    step (`filteredTemplates`: unarchived, the type chip, a substring over title and tags,
    newest save first; `pick` / `startBlank`), `setType` through `withType`, the scope
    question for a series, `apply(scope:)` — the instant `problem` toast, the per-entry
    unilateral check, then `create` / `update(eventId)` / `detach(eventId, keyDate)` with the
    repeat forced off for a detached day; the server's `ok:false` lands as `errors` + a toast.
    `isDirty` is draft ≠ baseline (a picked template is not dirty). A builder-mode `CoachModel`
    is created in `start()` when services exist; every form edit is pushed to the session
    (`updateDraft`) and every reduce comes back through `onDraft` → `apply(reduced:)`.
  - **Views:** `BuilderSheet` (title / date / back-to-search / the sparkle / close with a
    Discard dialog when dirty; `.large`, `interactiveDismissDisabled` while dirty; the action
    bar in `safeAreaInset(.bottom)`: Cancel + Apply / Save changes, or the scope bar with the
    web's copy), `TemplateSearchView` (search, `All` + seven type chips, rows with the type
    chip, scoring badge and exercise count, swipe to archive, `Build "<q>"`),
    `BuilderFormView` (type chips, sport hidden for climbing types, scoring + AMRAP cap,
    title, date, duration, start/end `TimeField`s, `RepeatPickerView`, outdoor-climbing and
    cardio targets, location, tags, description, difficulty, the sections editor),
    `RepeatPickerView` (On/Off hidden for a series, Monday-first day chips, every N weeks,
    Ends never / on a date, a custom rule read-only), `BuilderCoachDrawer` (a split under the
    form: thread + composer reused from the Coach tab, "Updating the draft…" while the reduce
    runs, no card, the key sheet on a 402).
  - **`CoachModel`:** `init(services:mode:draft:onDraft:placeholder:)` — the draft modes are
    store-less (never listed under Conversations) and forward `.draft`; `updateDraft(_:)`.
    `AppModel` keeps `coachServices` and hands them to `ScheduleTab` for the drawer. The mock
    serves `chat-stream-builder.ndjson` in builder mode.
  - **Tests:** `BuilderModelTests` (8: search filter/sort + build from the query, template
    pick, `withType`, create sends the draft, invalid drafts refused before any request and
    the server's refusal lands as errors, series scope routing with the repeat forced off on
    detach, one-off saves without a scope, the coach's reduce lands on the form and a form edit
    reaches the session), `BuilderSnapshotTests` (search, form from the template, outdoor +
    repeat, scope bar, coach drawer, XXL), `SmokeUITests.testBuilderOnFixtures` ("+" → the
    library → the template → the coach fills the form from the recorded stream → Apply → the
    card on the day; screenshots 23–26) and `testBuilderScopeOnFixtures` (Edit workout on the
    series → Save changes → This event only → the detached, renamed card; 27–28).
  - **Not done here:** 0.6.0, D-027, screens/design-spec updates, the TestFlight dry-run (D).
