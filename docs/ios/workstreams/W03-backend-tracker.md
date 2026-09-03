# W3 — Backend: tracker consolidation

**Machine:** Linux · **Depends on:** W0 · **Unblocks:** W4
**Status:** blocked on W0

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
- (none yet)
