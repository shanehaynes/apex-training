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

### 2026-09-24 — tips wired
- Copy refined in `blocks-analytics.ts` (ids unchanged, all P1, no help link): each body
  opens on one imperative and names the on-screen button in bold — **New cycle**,
  **New tile**, then **Measure** / **Preview** / **Save tile** in the builder.
- `useTip('blocks-first')` in `BlocksView`, `useTip('analytics-first')` in `AnalyticsView`,
  both above the mode early-returns, so they ride the overlay's mount.
  `useTip('tile-builder-first', tile === null)` in `TileBuilder`: new tiles only, conditioned.
- Focus hold: the builder autofocuses nothing, so the card lands on open, 600 ms before a
  first keystroke is likely. A user who clicks into a field inside that window holds it until
  the field loses focus (TipHost's focusout recheck); the spec proves both.
- `e2e/mock/tips-blocks-analytics.spec.ts` marks every other catalog tip seen through the
  profile GET, so a calendar-lane tip can never win the one-per-load slot in these tests.
- 2026-09-25 · orchestrator. Merged as #334; blocks-first now explains a cycle (#338).
