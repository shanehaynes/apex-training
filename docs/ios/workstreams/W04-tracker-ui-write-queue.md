# W4 — Tracker UI + write queue

**Machine:** Mac · **Depends on:** W3 · **Unblocks:** W12
**Status:** blocked on W3

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
- (none yet)
