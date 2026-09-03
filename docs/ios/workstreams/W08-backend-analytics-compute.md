# W8 — Backend: analytics compute

**Machine:** Linux · **Depends on:** W0 · **Unblocks:** W9
**Status:** in review (PR pending)

## Goal
`POST /api/analytics-compute { specs, today }` → `{ tiles }` so clients render charts from
`TileData` and never fetch raw logs.

## Scope
In:
- `api/_lib/analyticsData.ts`: server port of `loadAnalyticsInputs` with `fetchAllPages`;
  active block for the `current-block` preset; HR settings from `profiles`.
- Handler: cap 24 specs, per-spec `specProblem` validation, `computeTile` per spec, index-aligned
  results; bucket `reads`.
- Promote `specProblem` into `analyticsTiles.ts` (server-side validation on save).
- Fixture `ios/Fixtures/analytics-compute.json` for the seeded dashboard.
- Optional: switch `useAnalyticsData` on the web (gate on measured latency; note the 1000-row
  cap fix changes numbers for heavy users).
Out: Swift.

## Acceptance
- Integration: results equal the browser's `computeTile` on the same rows for every seeded tile;
  a spec with an incompatible measure/sport pairing is rejected with the same `specProblem`
  text; cross-user isolation.
- Latency for the seeded dashboard < 1.5s cold on Vercel preview (log it in the PR).

## Session log
- 2026-09-03 · Linux · `api/_lib/analyticsData.ts` (service-role port of `fetch.ts`, every table
  paged via `fetchAllPages`), `POST /api/analytics-compute { specs[1..24], today }` →
  `{ today, tiles: TileResult[] }` index-aligned (invalid spec = problem slot), HR settings from
  the profile, current-block preset via `blockCovering`, bucket `reads`. `analyticsTiles.ts` POST
  now runs `specProblem` after the shape check (server owns the spec contract). `engine.ts`,
  `window.ts`, `buckets.ts` switched to `.js` specifiers. Web keeps its browser path
  (`useAnalyticsData`) — switching it is a follow-up gated on measured latency. Tests:
  `analytics-compute.test.ts`; integration computes session-count / tonnage over the fixture rows
  (1 session, 1,190 lb) with cross-user isolation; fixture `analytics-compute.json`.
