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
