# W9 — Analytics tab

**Machine:** Mac · **Depends on:** W8, W6 · **Unblocks:** —
**Status:** done — #153, #154, #155, #156; TestFlight build 6 (0.7.0/324) uploaded 2026-09-14; device run is Shane's

## Goal
The dashboard and tile builder, readable on a phone, with editable layout (D-011).

## Scope
In:
- Dashboard: tiles from `/api/analytics-tiles` rows (`spec` + layout), results from
  `/api/analytics-compute`, cache kinds `analytics_tiles` and `analytics_result:<id>`;
  kebab (Edit / Duplicate / Delete two-tap); excluded-entries footnote.
- Edit mode: reorder (`.onMove`) and S/M/L height; persist via `PATCH /api/analytics-tiles
  { layouts }` mapping order → `y`, height → `h ∈ {2,4,6}`, `x = 0`, `w = 12`.
- Renderers in Swift Charts (line, area, bar, stacked-bar) + KPI row + table view; scrub
  overlay; grade-scale labels; house style.
- Tile builder sheet: full spec editor (title, type, range, bucket, unit, series with measure
  groups / aggregation / split / top-N / grade scale / filters incl. day-offset), live preview
  via single-spec compute (300ms debounce), visible reasons for dimmed pairings.
- Analytics coach drawer: `ChatSession(mode: .analytics)` over the chart draft JSON.
Out: new chart types.

## Acceptance
- Snapshots: each chart type, KPI row wrapping on SE, table tile, edit mode.
- Device: reorder + resize persists and the web dashboard reflects the new `y/h`.
- Builder: a spec the web considers invalid is rejected with the server's message.

## Session log
- 2026-09-12 · Mac · PR A — backend + ApexCore. Plan `~/.claude/plans/lets-get-a-plan-starry-llama.md`
  (Shane's decisions: `GET /api/analytics-tiles` for the phone; draft logic server-side like W7's
  `/api/workout-draft`; the catalog generated from `spec.ts`). `GET` lists tiles with the draft
  each spec unfolds to plus picker options; `POST { id, draft, layout }` and
  `POST /api/analytics-compute { drafts }` run the web's own `draft.ts` and answer `200
  { ok:false, problem }` (blank title moved server-side); the limiter is per method. The
  builder's option labels moved to `src/lib/analytics/labels.ts` so
  `ios/scripts/gen-analytics-catalog.mjs` can load them → `AnalyticsCatalog.swift` (`--check` in
  `ci:guards`). ApexCore: `ChartDraft` mirror (constructors only), `AnalyticsTile`/`TileLayout`,
  `TileHeight`, `TileLayoutPlan` (order → cumulative `y`, x 0, w 12), `SeriesColors` (vectors
  from a new `palette.test.ts` — none existed), `TileFormat`, `AnalyticsCacheKey` +
  `CachedTileResult`, six Endpoint cases, `Series.gradeLabels`; the analytics chat-session case.
  Fixtures: six seeded `ios-fixture-tile-*` rows, pitch rows on the crag (a climbing definition
  named without "Fixture" so `search_exercises` keeps its fixture) and two cardio rows (one
  unreadable) → `analytics-tiles.json`, `analytics-compute.json` (7 slots), preview, empty
  draft, chart-draft reduce, save, `chat-stream-analytics.ndjson`; `query-get_prs.json` gains
  the run's distance/elevation records. Found on the way in: `tiles.ts` needed a `.js` specifier
  once the API graph reached it; the stack must be reset from a checkout that has phase41.
  - **Not done here:** the dashboard (B), the builder sheet (C), smoke/0.7.0/docs/D-029 (D).
- 2026-09-13 · Mac · PR B — the dashboard. `AnalyticsModel` (cache-first, one compute per refresh
  chunked at 24, results cached per tile and trusted only for a matching spec on the same day
  and only on launch/realtime; edit mode → `TileLayoutPlan` → PATCH of the changed rows,
  optimistic with rollback; duplicate reuses the source result; delete stands on a 404),
  `AnalyticsTab` (inline title — a large one does not survive the ScrollView↔List swap of edit
  mode; Edit/Done and "+"; the builder route lands as a placeholder for C), `TileCardView`
  (kebab → Edit/Duplicate/Delete → "Confirm delete" dialog; stat tiles size to their content,
  charts take the grid height), `TileChartView` in Swift Charts (categorical buckets keyed by
  `bucket.key`, gaps at nils via per-run series, workout-type colours through
  `ChartPalette.color(for:)`, right-axis series on an overlaid chart, grade charts hide the
  y-axis), `KPIRowView`, `TileTableView` (sticky header), `AnalyticsEditList` (S/M/L segmented
  per row, `.onMove`), `ApexIcon` +5, `Chip(isDimmed:)`. Mock: the four analytics routes with
  saves, layouts and deletes replayed into later reads; compute answers by matching a spec to a
  seeded tile (the fixture is index-aligned). 16 model tests, 13 snapshots.
  - **Found on the simulator:** any drag gesture on a chart — zero-distance or hold-then-drag —
    swallows the page's vertical flick, and `chartXSelection` never fired on the iOS 26 runtime;
    value inspection is a tap that pins the bucket's card (U13). A KPI at the grid height was
    two-thirds empty, so stat tiles size to content.
  - **Not done here:** the builder sheet (C), smoke/0.7.0/docs/D-029 (D).
- 2026-09-13 · Mac · PR C — the tile builder. `TileBuilderModel` (the `ChartDraft` mirror as form
  state; every edit → the coach's draft + a debounced preview through `POST /api/analytics-compute
  { drafts }`, one in flight, stale answers dropped; the catalog's dimming reasons both ways;
  `setMeasure` resets aggregation and split like the web's `onPatch`; Save through
  `POST /api/analytics-tiles { draft }` — `ok:false` toasts the server's text, `ok:true` hands the
  tile and the preview's result to `AnalyticsModel.saved`), `TileBuilderSheet` (title, chart, range
  with rolling/preset/fixed, bucket hidden for a stat, display unit for length measures, one
  `SeriesEditorView` per series with the grouped measure picker, aggregation `Auto (…)`, split
  `None`, top groups, grade scale, a Filters disclosure with type-coloured chips, dimmed sports and
  their reason, the "other" workouts or the hint, exercises, categories, meal types, the day filter
  and its mode; `Add series`; the preview pinned under the form; Cancel + Save tile / Save changes
  in the keyboard-lifting bar; Discard confirm while dirty). The builder's coach drawer became
  `DraftCoachDrawer(coach:copy:)` in `Coach/` and `VSplit` moved to ApexUI; `Chip(tint:)` and
  `MultiChipRow` are new. Mock: `/api/chat` analytics mode streams `chat-stream-analytics.ndjson`
  with its own follow-up, `/api/coach-tool update_chart_draft` → `coach-tool-chart-draft.json`
  keeping the caller's title. 10 model tests, 5 snapshots. Driven on the iPhone 17 Pro: "+" →
  Tonnage → the preview → the coach fills title and Bar → Save → seven tiles.
  - **Not done here:** smoke/0.7.0/docs/D-029/TestFlight dry-run (D).
- 2026-09-13 · Mac · PR D — release. `MARKETING_VERSION` 0.7.0; D-029 (W11 had taken D-028
  meanwhile — every reference renumbered); architecture §10 (tap-to-pin, gaps, one-chart dual
  axis) and §13 (the fourth generator); `design-spec.md` §5 (`TileCardView`, the KPI/table/
  problem views, `ScrubCard`, `Chip(isDimmed:tint:)`, `MultiChipRow`, `VSplit`,
  `DraftCoachDrawer`) and §7; the board. U13 and U26 ticked by B/C. Three smoke legs:
  `testAnalyticsDashboardOnFixtures` (six tiles → a tap pins "830 lb" → Edit → L on the tonnage
  tile, the KPI dragged down → Done → the order survives a tab switch; 29–32),
  `testTileBuilderOnFixtures` (`-apexMockHasKey`: "+" → Tonnage → the preview → the coach fills
  the title and Bar → Save → seven tiles; 33–36), `testTileKebabOnFixtures` (Duplicate →
  "(copy)"; Delete → Confirm delete → six tiles; 37–38). Every opening tap goes through a
  retrying helper, and every tap-then-type waits for keyboard focus — the board's
  `testCoachKeySetupOnFixtures` flake was the same race. `testflight.sh --check` and
  `--dry-run` from this worktree; the upload is Shane's call.
  - **Left for Shane:** merges in order (A → B → C → D, rebasing each onto main after the lower
    squash), the TestFlight upload, and the device run from Acceptance: reorder + resize on the
    phone → the web shows the new `y/h`; a spec the web rejects is rejected with the server's
    message; the coach drawer on a real key.
- 2026-09-14 · Mac · D merged (#156) after three rebases past W11's #157 and #158 (both
  sides of `STATUS.md`, D-029 kept next to D-030). `testflight.sh` from the W9 worktree: build
  324 uploaded. Device run outstanding.
- 2026-09-15 · Mac · Device-run finding: Save with a blank title was refused by the server as
  designed, but the toast rendered under the sheet. `TileBuilderModel.saveProblem` now carries
  every refusal into an `InlineError` above the action bar (the workout builder got the same);
  the smoke's builder leg saves once without a title first.
