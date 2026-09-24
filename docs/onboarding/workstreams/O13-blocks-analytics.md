# O13 — Blocks + analytics tips

**Wave:** 2 · **Depends on:** O03 · **Unblocks:** —
**Status:** ready · branch `feat/help-blocks-analytics` · port 5227 · lock slot e2e_slot_2

## Tips (`src/lib/onboarding/tips/blocks-analytics.ts`)
| id | trigger | condition |
|---|---|---|
| blocks-first | `BlocksView` | first mount |
| analytics-first | `AnalyticsView` | first mount |
| tile-builder-first | `TileBuilder` | `tile === null` (a new tile, not an edit) |

## Ownership
`src/components/blocks/*`, `src/components/analytics/*`,
`src/lib/onboarding/tips/blocks-analytics.ts`, `e2e/mock/tips-blocks-analytics.spec.ts`,
this file. No help page (the empty-state copy and the live preview teach these).

## Session log
