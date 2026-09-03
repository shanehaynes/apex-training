# W0 — Backend read foundation

**Machine:** Linux · **Depends on:** — · **Unblocks:** W2 (and every later Swift workstream)
**Status:** in review (PR pending)

## Goal
Give a native client everything it needs to *read* without reimplementing recurrence, alias
resolution or stats, and put the three contract-sync guards in place before any Swift exists.

## Scope
In:
- `reads` rate-limit bucket in `api/_lib/rateLimit.ts` (`600s / 300`).
- `GET /api/schedule?start&end[&include=definitions,templates]` → `{ window, bases, occurrences, … }`
  wrapping `fetchExpandedSchedule` + `fetchCompletionsInRange` (`api/_lib/mcp/data.ts`);
  resolve exercises per base; cap 400 days. Handler `api/_lib/handlers/schedule.ts`.
- `POST /api/workout-sessions { action: 'quick-complete' }` builds rows server-side via
  `buildQuickCompleteLogs` when the body carries none.
- `POST /api/query { tool, args }` over `api/_lib/mcp/toolRegistry.ts` (JWT, bucket `reads`).
- ~~`.js`-specifier import-graph guard~~ — already exists as `api/__tests__/esm-imports.test.ts`
  (walks the api import graph and fails on extensionless relative imports). Nothing to add;
  `src/lib/tracking/plan.ts` needed its two runtime imports switched to `.js` once the API
  graph reached it, and the test caught exactly that.
- `scripts/db-types.sh`: also emit `ios/Packages/ApexCore/Sources/ApexCore/Generated/DatabaseTypes.swift`;
  `--check` covers it.
- `api/__tests__/fixtures/emitIosFixtures.test.ts` → `ios/Fixtures/{schedule,query-*,profile}.json`
  (`bootstrap`, `finish`, `chat-stream`, `analytics-compute` are added by W3/W5a/W8).
Out: any web UI change; the web keeps its in-browser schedule path.

## Touches
`api/_lib/app.ts`, `api/_lib/rateLimit.ts`, `api/_lib/handlers/schedule.ts` (new),
`api/_lib/handlers/query.ts` (new), `api/_lib/handlers/workoutSessions.ts`, `scripts/ci-guards.sh`,
`scripts/db-types.sh`, `api/__tests__/**`, `ios/Fixtures/**`, `ios/Packages/ApexCore/Sources/ApexCore/Generated/`.

## Acceptance
- Integration tests: `/api/schedule` returns the same occurrence set as the web's
  `expandRecurringEvents` for the seeded user over a 90-day window; cross-user isolation; 400 on
  >400 days; `include` variants.
- `/api/query` rejects unknown tools and passes `get_prs`, `search_exercises`, `get_period_stats`.
- `quick-complete` with no rows produces the same rows as the web's `buildQuickCompleteLogs`.
- The import guard fails on a deliberately extensionless import and passes on `main`.
- `scripts/db-types.sh --check` fails when the Swift file is stale.
- Fixtures committed; the emitter's check mode is green in the `full` CI job.
- The local gate (`agent:check`) is green.

## Session log
- 2026-09-03 · Linux · Implemented: `reads` bucket; `GET /api/schedule` (`api/_lib/handlers/schedule.ts`);
  `POST /api/query` (`api/_lib/handlers/query.ts`); server-built `quick-complete` via new
  `api/_lib/trackerSession.ts` `loadResolvedOccurrence` (also stamps the plan's estimated
  duration when the caller sends none); `scripts/db-types.sh` now emits and checks
  `ios/Packages/ApexCore/Sources/ApexCore/Generated/DatabaseTypes.swift`; fixture emitter lives in
  `api/__tests__/integration/ios-read.integration.test.ts` (checks by default, writes with
  `APEX_FIXTURES_WRITE=1`) and produced `ios/Fixtures/{schedule,query-search_exercises,query-get_prs,profile}.json`.
  Unit tests: `schedule.test.ts`, `query.test.ts`, quick-complete cases in `workout-sessions.test.ts`.
  Findings for later workstreams: account deletion already exists as `/api/account` (PR #93), so
  W11 drops `DELETE /api/profile`; `requireUser` gates every non-exempt route on terms acceptance
  (`403 terms-acceptance-required`), which the Swift `APIError` must map (added to architecture.md).
