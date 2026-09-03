# W10 — Library, Blocks, Meals (under You)

**Machine:** both (small backend part on Linux) · **Depends on:** W2 · **Unblocks:** —
**Status:** blocked on W2

## Goal
The three data-management areas as pushed screens from the You tab, with the phone-hidden stats
restored (U11, U12).

## Scope
In:
- Backend (Linux): `POST /api/blocks?resource=cycle { spec } → { blocks }` over
  `blocks/cadence.ts`; run `normalizeSupersets` in the events/templates services; web cycle
  preview switches to the endpoint.
- Library: search + category chips, rows with last-performed / in-N-workouts
  (`/api/query search_exercises` + `last_performed_by_name`), archived section; detail (tags,
  aliases, notes, PR card, trend chart via `get_exercise_history`, recent sessions); editor
  sheet (rename keeps alias, category, unilateral, muscle groups, equipment, notes, defaults,
  archive/restore with blast-radius note). Workout-template library (archive/restore).
- Blocks: list + objectives; detail (block-to-date, this-week, by-week table with attainment,
  PRs this block via `get_training_blocks` / `get_prs`); editor (Monday/Sunday snap, six
  weekly targets with unit pickers); cycle generator with live preview from the endpoint;
  inline objective creation.
- Meals: day list; composer sheet (favorites chips, title/date/time, type row, macro fields
  with decimal pad, derived-kcal placeholder, fat-split validation, notes, save to library);
  delete; day macro rollup on the Day sheet.
Out: nothing deferred.

## Backend contract consumed
`/api/query`, `/api/exercise-definitions`, `/api/workout-templates`, `/api/blocks`,
`/api/objectives`, `/api/meals`, `/api/meal-favorites`; direct reads of `meals`, `meal_favorites`,
`training_blocks`, `objectives`, `exercise_definitions`.

## Acceptance
- Integration test for `resource=cycle` equals the web's `cadence.ts` preview.
- Snapshots: library row/detail/editor, block detail, cycle preview, meal composer.
- Device: rename an exercise → history follows (alias); create a cycle → blocks appear on web.

## Session log
- (none yet)
