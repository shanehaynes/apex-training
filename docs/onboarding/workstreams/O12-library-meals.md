# O12 — Library + meals tips

**Wave:** 2 · **Depends on:** O03 · **Unblocks:** —
**Status:** ready · branch `feat/help-library-meals` · port 5226 · lock slot e2e_slot_1

## Tips (`src/lib/onboarding/tips/library-meals.ts`)
| id | trigger | condition |
|---|---|---|
| library-first | `LibraryView` | first mount |
| meal-first | `AddMealView` | first mount |

The mock harness has no exercise definitions or meals; the tip spec stubs them with
`page.route` inside the spec (the library spec is an expected CI skip for this reason —
do not add a skip; stub instead).

## Ownership
`src/components/library/*`, `src/components/composer/*`, `src/lib/onboarding/tips/library-meals.ts`,
`e2e/mock/tips-library-meals.spec.ts`, this file. No help page.

## Session log

### 2026-09-24 — tips wired
- **library-first** → `LibraryView.tsx`, `useTip('library-first', !detail)`: offered while the
  list is on screen (its copy is about the list); a deep link into one exercise's detail
  waits until **Back**. 32 words.
- **meal-first** → `AddMealView.tsx`, `useTip('meal-first')` on first mount (add and edit). 28 words.
- Focus hold: the library search had `autoFocus`, which kept TipHost holding library-first
  until the user clicked away (and raised the phone keyboard over the list). Removed it. The
  meal form autofocuses nothing, so it needed no change.
- Copy: the library tip says what fills the list (adding exercises, copying the starter plan);
  the meal tip drops "macro" and names **Save to library**, which fills the empty
  "From library" row.
- e2e `e2e/mock/tips-library-meals.spec.ts`: stubs `exercise_definitions` (2 rows) and a
  profile with every other tip seen, so folded-in tips from other lanes cannot win the load.
- Found: on a 375 px phone the "Finish setting up" nudge covers the **+** menu's **Meal**
  item (the phone spec closes the nudge first). Outside this lane — follow-up.
- 2026-09-25 · orchestrator. Merged as #333; nudge bug fixed in #337; meal calories label reworded in #338.
