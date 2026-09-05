# W4 — Tracker UI + write queue

**Machine:** Mac · **Depends on:** W3 · **Unblocks:** W12
**Status:** in review (A #117, B #118, C) — code complete; TestFlight build 2 and the device run outstanding

## Goal
The gym-floor screen — the surface where native must beat the web most. TestFlight build 2.

## Scope
In:
- `ApexCore.TrackerEditor`: in-memory groups from `bootstrap`, dirty keys, shadow commit (row
  for sets, per-field for cardio), extra sets (numbering continues), remove extra, swap
  exercise (relabel + note + per-side warning), `collectUntouchedPlanned`, `setToRow/cardioToRow`.
- `ApexCore.WriteQueue` + `ApexPersistence` store: coalescing, merge of consecutive saves,
  ordering, retry classes, cancel purge, flush triggers (network, `.active`, `.background`
  with background task, `BGAppRefreshTask`).
- UI: header (back, title, date · elapsed timer from `started_at`, Finish), section groups,
  set rows with mono inputs, numeric pad + accessory bar (Next/Done, "use last"), duration
  digit-buffer input, cardio row, climbing pitch rows, Add set, swap picker (via
  `/api/query search_exercises` + definitions cache), keep-awake, haptics.
- Finish gate: unlogged confirm bar → score sheet → summary overlay (streaming recap via
  `coach-summary`, PR trophies, full log, Back). Cancel workout (destructive confirm).
- Offline: whole session works from the cached bootstrap; "N sets pending sync" chip; finish
  offline shows "PRs pending sync" and fills in when the flush returns.
- Finished sessions reopen editable (bootstrap `prs` populated).
Out: Live Activity (W12), rest timer (Backlog).

## Backend contract consumed
`POST /api/workout-sessions` (`bootstrap`, `start`, `save`, `finish`, `cancel`, `swap-exercise`),
`POST /api/coach-summary`, `POST /api/query search_exercises`.

## Acceptance
- `swift test`: editor rules (mirror the edit-related cases of `src/lib/tracking/__tests__/`),
  queue coalescing/ordering/retry/purge, duration buffer vectors.
- Snapshots: set row × 5 states, cardio row, confirm bar, score sheet, summary.
- Device test: log a full workout in airplane mode, background the app, come online → server
  rows match; `started_at` equals the offline start time.
- Keyboard never covers the focused field or the confirm bar (iPhone SE + Pro Max).
- TestFlight build 2.

## Session log
- 2026-09-05 · Mac · Plan and PR A. Landing as three PRs: A ApexCore editor + queue +
  endpoints + backend peek + fixtures (this PR, Linux-provable); B GRDB store + tracker UI +
  model + event-sheet wiring + snapshots; C flush driver + background keys + UI smoke +
  TestFlight build 2. Plan of record: `~/.claude/plans/from-w3-yes-start-cheeky-dusk.md` on
  Shane's Mac.
  - **Corrections to the brief and hand-offs found on the way in:** `bootstrap` creates the
    session before building the model, so an offline start needed a non-creating read —
    `bootstrap { peek: true }` (backend-changes.md, W3 addendum; D-024). `finish` does not flip
    the occurrence's completion (the web posts `/api/completions` after it), so the queue has a
    `completion` op. `search_exercises` returns no definition id, so the swap picker will read
    the cached `definitions` and use the tool only to decorate. `ScheduleModel.toggleCompletion`
    carries no "marked for `WriteQueue.enqueue`" marker and keeps its rollback contract (D-024).
    `CardioLog.shadow` was typed as the set shadow; it is now `CardioShadow` (four metrics).
    `ApexClient` mapped an offline token fetch to `.unauthorized`; a `URLError` is `.network`.
  - **ApexCore (Linux-provable):** `Tracker/` — `TrackerKeys` (`SessionKey`, `SetKey`,
    `CardioKey`, `SetField`, `FieldID`), `TrackerRows` (`SetLogRow`/`CardioLogRow` with the
    allowlisted columns and explicit nulls, `SavePayload.merging`, `FinishPayload`,
    `ScoreSubmission`, `SwapPayload`), `TrackerEditor` (setValue, commitShadow row / per-field
    cardio, `commitAllShadows` for U28, add/remove extra, swap with `substitutedFrom` lifecycle,
    `apply` replay, `replaceGroupsIfClean`, `collectUntouchedPlanned`, `takeSavePayload`,
    `inputFields`, `needsPerSideWarning`, `fieldOrder`), `DurationBuffer` + `DurationEntry`
    (the digit buffer without the refocus hack — U29), `CountSpec`, `SessionScore`. `Cache/` —
    `WriteQueueStore` protocol + `TrackerOp`/`TrackerOpPayload`, `MemoryWriteQueueStore`,
    `RetryPolicy`, `WriteQueue` actor. `API/` — `Endpoint.trackerBootstrap(peek:)`,
    `.tracker(_:session:)`, `.coachSummary`; `HTTPTransport.stream` (default = one chunk) and
    `ApexClient.stream` / `wireEvents(for:)` with the 401 policy on the response head. Tracker
    models are `var` with public inits; `ExerciseDefinition` gained `default*` and `archivedAt`.
    170 `swift test` cases (editor, duration vectors verbatim, count-spec vectors, score, merge
    invariant, retry policy, 18 queue cases incl. backoff `[1,2,4,8]`, 401 pause/resume, cancel
    mid-flight, relaunch replay).
  - **Backend:** `bootstrap { peek: true }` in `handlers/workoutSessions.ts`; `buildBootstrap`
    accepts a null session. Integration test emits `bootstrap-peek.json` and, through the
    suite's Anthropic mock, `coach-summary.ndjson` (and asserts the 409 for an unfinished
    session). Handler unit tests untouched and green.
  - **Not done here (PR B/C):** everything Apple-side — GRDB `tracker_ops`, the tracker views
    and model, event-sheet wiring, the flush driver, UI smoke, TestFlight build 2.
- 2026-09-05 · Mac · PR B — the tracker.
  - **ApexPersistence:** migration `v2_tracker_ops` (with `owner`), `GRDBWriteQueueStore`
    scoped per owner so another account never sees or flushes an earlier one's unsynced work.
    `AppModel.ensureQueue(owner:)` builds the queue when the root learns who is signed in;
    sign-out drops the instance and keeps the rows.
  - **TrackerModel** (`ApexFeatures/Tracker/`): open = cached bootstrap → render → replay queued
    saves/swaps/start/finish → flush → network bootstrap carrying any queued start stamp →
    `replaceGroupsIfClean`. Offline with a cached peek and no session: stamp now, queue `start`,
    cache the synthesised session. Nothing cached → "open once online". Edits: 800 ms debounce
    (`ApexClock`, so tests are instant) → `takeSavePayload` → queued `save` → flush. Shadow
    commits on focus (row) / per field (cardio); U28 "Use last" per exercise and in the
    keyboard accessory. Finish gate = web's outcome order; finishing queues `finish` (autofill
    rows, `finishedAt`, score) then `completion(true)` and flips the calendar locally
    (`ScheduleModel.applyCompletionLocally`); `.finished` from the queue fills PRs and streams
    the coach; offline the summary says "PRs pending sync" until then. Cancel purges the session's
    ops, queues `cancel`, flips completion back if finished. Swap flushes first, relabels
    locally, queues `swap-exercise`; candidates come from the cached definitions (same logged
    shape, never archived). Coach summary: 409 → "available once the workout syncs", 402 /
    in-band `error` / empty → the web's unavailable copy; the text is cached on the session.
  - **Views:** `TrackerHost` (`fullScreenCover`, keeps the screen awake — U15), `TrackerScreen`
    (header with the title on its own line and `date · elapsed` — U27; sync strip; sections;
    Cancel workout; bottom inset for ConfirmBar / ScoreCard / failure bar so the keyboard lifts
    them — U3; keyboard accessory Use last · Abc/123 · Next · Done with reading-order focus
    advance — U2; haptics via `.sensoryFeedback` — U16), `TrackedExerciseView` + `SetRowView` +
    `CardioRowView` (ghost placeholders, extra rows removable, 44pt controls), `DurationField`
    over `DurationEntry` (decimal pad, programmatic refocus on mode change — U29), `ScoreCard`,
    `SummaryOverlay`, `SwapPickerSheet`. `ApexUI.ConfirmBar`; eight new icons.
  - **Schedule wiring:** `EventSheet` shows Start Workout / View · Edit Workout for every event
    (web parity) and peeks the bootstrap on open; `ScheduleTab` presents the cover after the sheet
    dismisses; `ScheduleModel.prefetchTrackerBootstraps` peeks today's and tomorrow's workouts
    after each refresh (`prefetchesTracker: false` in the request-counting tests).
  - **Mock:** `bootstrap` (+ `peek`), `finish`, `coach-summary` routes from the new fixtures.
  - **Tests:** `WriteQueueStoreTests` (GRDB round trip, ordering, owner scoping, relaunch
    replay), `TrackerModelTests` (15: open online / offline-cached / offline-uncached, debounce,
    offline pending chip, finish gate, scored + skip, offline finish → PRs later, cancel, swap,
    reopen finished, summary degrade ×4, focus walk), `TrackerSnapshotTests` (14 recorded and
    reviewed: tracker, 16e / Pro Max / XXL, finished, confirm bars, score cards, summary ×3,
    exercise cards, pending sync). Full `xcodebuild test` green (62 unit incl. the W2 smoke's 5
    UI tests).
  - **Verified live** (signed Local build, this worktree's vite on 127.0.0.1, local stack):
    sign in → today's seeded weights event → Start Workout → bootstrap creates the session →
    185 / Next / 5 → debounced `save` lands (`actual_weight: "185"`) → Finish → confirm bar above
    the keyboard → Finish anyway → server: `finished_at`, `total_duration_seconds: 105`, set 2
    and the plank zero-filled `is_autofilled`, completion row `is_completed: true` → summary
    overlay (coach 402 → unavailable copy, log correct) → Back to calendar.
  - **Not done here (PR C):** the flush driver (network / scene / background task), the
    Info.plist background keys, the UI smoke through the tracker, TestFlight build 2, the device
    airplane-mode test.
- 2026-09-05 · Mac · PR C — the flush triggers and the smoke.
  - **`WriteQueueDriver`** (app target — nothing in it is unit-testable): `NWPathMonitor`
    satisfied → `queue.resume()`; scene `.active` → resume; scene `.background` →
    `beginBackgroundTask` + `flush()` + `BGAppRefreshTask` request (15 min earliest);
    `registerBackgroundTask()` from `ApexApp.init` (must precede launch completion).
    `Info.plist`: `UIBackgroundModes: [fetch]`, `BGTaskSchedulerPermittedIdentifiers`.
    `AppModel.ensureQueue` builds the driver with the queue; sign-out stops it. The queue's
    backoff runs on `SystemClock` even under the mock, or every retry would be instant.
  - **Mock:** a non-peek `bootstrap` answers a session started 7 min before the fixed clock (the
    committed `bootstrap.json` is a *finished* session — a reopen, not a start);
    `-apexMockFailOnce save 3` fails the first three saves; `-apexMockFail` matches an action too.
  - **Smoke:** `testTrackerOnFixtures` — sign in → Fixture Push Day → "View / Edit Workout"
    (the fixture occurrence is completed) → tracker → focus on set 2 commits the ghost (110 lb)
    → "1 set pending sync" while the saves are refused → clears on the retry → Finish → "1 planned
    set unlogged — recorded as 0." → Finish anyway → summary streams the fixture coach text and
    the PR → Back. Screenshots 07–10 via `ios/scripts/screenshots.sh`.
  - **Found on the way:** an `accessibilityIdentifier` on a container replaces every child's in
    the accessibility tree unless the container is `.accessibilityElement(children: .contain)`.
    Every tracker container now is; `tracker.title` and friends resolve.
  - **Outstanding (Shane):** TestFlight build 2 (bump `MARKETING_VERSION` in `project.yml`, then
    `ios/scripts/testflight.sh`; `--check` passes from this worktree) and the device run — open
    today's workout once online (or wait for the peek prefetch), airplane mode, log sets, Finish,
    background, Wi-Fi on → the server's rows and completion match and `started_at` /
    `finished_at` are the phone's stamps.
