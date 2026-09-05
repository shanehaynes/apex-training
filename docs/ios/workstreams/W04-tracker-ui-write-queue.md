# W4 — Tracker UI + write queue

**Machine:** Mac · **Depends on:** W3 · **Unblocks:** W12
**Status:** in progress (feat/w4-tracker — PR A in review)

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
