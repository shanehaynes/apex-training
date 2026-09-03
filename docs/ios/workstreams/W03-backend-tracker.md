# W3 — Backend: tracker consolidation

**Machine:** Linux · **Depends on:** W0 · **Unblocks:** W4
**Status:** in review (PR pending)

## Goal
One tracker model on the server so Swift receives a fully-resolved session and only owns edits.
The web switches to the same endpoint in this PR.

## Scope
In (all in `api/_lib/handlers/workoutSessions.ts` + new `api/_lib/trackerSession.ts`):
- `bootstrap { eventId, eventDate }` → `{ session, event, groups, scored, prs?, scoreRecord? }`
  (port of `sessionRepo.loadSession` on the admin client with `fetchAllPages`, then
  `buildTrackerModel`).
- `start { startedAt? }`, `finish { finishedAt? }` with bounded client timestamps.
- `finish` returns `{ ok, totalDurationSeconds, prs (with descriptions), scoreRecord, recap }`
  via `computeSessionPRs`, `computeWorkoutScorePR`, `buildSessionRecap` (moved into the API graph).
- `POST /api/coach-summary { eventId, eventDate }`: server rebuilds the recap, streams NDJSON
  (lift `streamToWireEvents` into `api/_lib/wire.ts`), persists `coach_summary`. Legacy
  `{ recap }` accepted.
- Web: `useWorkoutSession` uses `bootstrap`; delete `sessionRepo.loadSession` and client PR
  computation; keep edit-time serializers.
- Fixtures: `ios/Fixtures/bootstrap.json`, `finish.json`, `coach-summary.ndjson`.
Out: any Swift.

## Acceptance
- Integration tests: bootstrap equals the web's former client model for the seeded user
  (shadow values, substitution, extra sets, scored flag); timestamps outside the bound are
  clamped/rejected; finish returns PRs identical to `computeSessionPRs` on the same rows;
  cross-user isolation on every action.
- Playwright mock tracker specs still green after the web switch (`e2e/mock/tracker.spec.ts`).
- Local gate green; fixtures committed.

## Session log
- 2026-09-03 · Linux · Implemented in `api/_lib/trackerSession.ts` (`loadSavedRows`,
  `loadTrackerHistory` with alias-widened, paged history, `buildBootstrap`, `buildFinishSummary`,
  `loadMealsForDate`) and `handlers/workoutSessions.ts` (`bootstrap`; `start{startedAt}` /
  `finish{finishedAt}` bounded to [now−7d, now+5min] and finish ≥ start; `finish` returns
  `{ prs (with description), scoreRecord (with description), recap }`). `coach-summary` v2
  `{ eventId, eventDate }` rebuilds the recap, streams NDJSON via the lifted `api/_lib/wire.ts`,
  and persists; the legacy `{ recap }` JSON path and the `summary` action stay for stale bundles.
  Web: `sessionRepo.loadSession` → bootstrap, `finishSession` returns the records,
  `generateCoachSummary` streams; `useWorkoutSession` drops history refs, local PR detection
  and the meals dependency; `quickCompleteSession` sends no rows (W0). `src/lib/coach/summary.ts`
  is now pure (`.js` specifiers). Mock e2e: `e2e/lib/intercept.mjs` builds the bootstrap model
  with the real `buildTrackerModel` (Playwright resolves the TS), shared by the two specs that
  stub sessions. Fixtures added: `bootstrap.json`, `finish.json`.
