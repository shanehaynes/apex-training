# W9 — Analytics tab

**Machine:** Mac · **Depends on:** W8, W6 · **Unblocks:** —
**Status:** blocked on W8, W6

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
- (none yet)
