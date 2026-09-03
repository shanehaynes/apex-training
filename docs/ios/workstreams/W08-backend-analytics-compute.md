# W8 — Backend: analytics compute

**Machine:** Linux · **Depends on:** W0 · **Unblocks:** W9
**Status:** blocked on W0

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
- (none yet)
