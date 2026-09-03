# W0 — Backend read foundation

**Machine:** Linux · **Depends on:** — · **Unblocks:** W2 (and every later Swift workstream)
**Status:** ready

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
- `scripts/ci-guards.sh`: `.js`-specifier import-graph guard from `api/*.ts` into `src/`.
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
- (none yet)
