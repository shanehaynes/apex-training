# W10 — Library, Blocks, Meals (under You)

**Machine:** both (small backend part on Linux) · **Depends on:** W2 · **Unblocks:** —
**Status:** in progress — PR A (backend + ApexCore) up; B Library, C Blocks, D Meals, E release to follow

## Goal
The three data-management areas as pushed screens from the You tab, with the phone-hidden stats
restored (U11, U12).

## Scope
In:
- Backend (Linux): `POST /api/blocks?resource=cycle { spec } → { blocks }` over
  `blocks/cadence.ts`; web cycle preview switches to the endpoint. (`normalizeSupersets` in the
  services landed with W7.) Reads stay API-only (Shane, 2026-09-16; D-033): the query tools grew
  ids, `block_id`, `today`, objectives, the meal fat split and reference counts, and
  `GET /api/meal-favorites` was added, rather than the phone reading the five tables over RLS.
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
`/api/query` (`get_training_blocks`, `get_exercise_history`, `search_exercises`, `get_meals`),
`/api/exercise-definitions`, `/api/workout-templates`, `/api/blocks` (+ `?resource=cycle`,
`?batch=1`), `/api/objectives`, `/api/meals`, `/api/meal-favorites`; definitions and templates
from the cached `/api/schedule?include=`. No direct table reads (D-033).

## Acceptance
- Integration test for `resource=cycle` equals the web's `cadence.ts` preview.
- Snapshots: library row/detail/editor, block detail, cycle preview, meal composer.
- Device: rename an exercise → history follows (alias); create a cycle → blocks appear on web.

## Session log
- 2026-09-16 · PR A (backend + ApexCore, Linux-provable): `POST /api/blocks?resource=cycle`
  (preview only; `blocks` + `rows` + `conflict`; `reads` bucket; router dispatch before the
  resource patch), `get_training_blocks` `block_id`/`today`/`include_objectives` + ids +
  `current_week`, `get_meals` ids + fat split, `search_exercises` ids + `references`,
  `GET /api/meal-favorites`, `/api/meals` macro + fat-split validation with the composer's own
  sentences (now shared from `src/lib/nutrition/mapping.ts`), the web `CycleEditor` switched to
  the endpoint (+ `e2e/lib/mock/blocks.mjs`), eight new fixtures + two regenerated, ApexCore
  models/forms/endpoints (`Blocks`, `BlockForm`, `Library` + `ExerciseHistoryResult`,
  `DefinitionForm`, `MealFavorite`, `MealForm`, `Nutrition` — the D-033 Atwater port pinned by
  `nutrition-derived.json`), 29 new `swift test` cases green natively and in `swift:6.1`.
  Decisions: D-033. Traps: `app.ts` rewrote `?resource=cycle` to `block` (dispatch first);
  `cadence.ts`/`validate.ts` lacked `.js` specifiers; `normalize()` collapses distinct uuids
  (rewrite seeded ids first); `blocks-cycle.spec.ts` counted the preview POSTs (filter on
  `batch=1`); the detail's attainment carries derived rows the planned calendar adds.
- 2026-09-16 · PR B (Library, Mac, stacked on A): `ApexFeatures/Library/` — `LibraryModel` +
  `LibraryDependencies` (closures over `ScheduleModel.definitions()/templates()/refresh/
  archiveTemplate`, built in `AppModel.ensureQueue`; no realtime subscription of its own — the
  hub's stream has one consumer, the schedule, which rewrites the cache these lists read),
  `LibraryView`, `ExerciseDetailView` (+ `StatCard`), `DefinitionEditorSheet`,
  `WorkoutLibraryView`; `YouRoute.library/.exercise(id:)/.workoutLibrary`, `YouServices.library`,
  `YouModel.library`, the two rows under Training, `YouTab(routes:)` consuming `.library` into a
  `NavigationStack(path:)`; mock `searchExercises`/`exerciseHistory`/`patchDefinition` over
  `currentDefinitions()`; `YouTransport` keyed by query tool; `LibrarySupport`,
  `LibraryModelTests` (11), `LibrarySnapshotTests` (8). U11 ticked. Traps: `XCTAssertNil(await …)`
  again (bind first); the model's static label helpers are MainActor-isolated under the package
  default, so a synchronous test that calls them is `@MainActor`; the detail's history is `@State`
  loaded in `.task`, so snapshots pass it in through the `history:` init.
- 2026-09-16 · PR C (Blocks, Mac, stacked on B): `ApexFeatures/Blocks/` — `BlocksModel` +
  `BlocksDependencies` (the AnalyticsDependencies shape, realtime `.blocks`), `BlocksView`,
  `BlockDetailView` (+ `AttainmentBars`, `BlockWeeksTable`), `BlockEditorSheet`,
  `CycleEditorSheet`; `ApexUI/Components/AttainmentBar` (design-spec §5's row, built);
  `YouRoute.blocks/.block(id:)`, `YouServices.blocks`, `YouModel.blocks` + `shutdown()` (sign-out
  stops the subscription), the Training-blocks row; mock `trainingBlocks`/`cyclePreview`/
  `rememberBlock` + objectives; `YouTransport` keyed by query string; `BlocksSupport`,
  `BlocksModelTests` (9), `BlocksSnapshotTests` (7). U9 and U12 ticked. Traps: a local
  `Decodable` struct inside a MainActor class is MainActor-isolated too (`nonisolated struct`);
  after merging main, `xcodegen generate` again — a file main added is not in the old project.
- 2026-09-16 · PR D (Meals, Mac, stacked on C): `ApexFeatures/Meals/` — `MealsModel` +
  `MealsDependencies` (`onMealsChanged` → `ScheduleModel.refreshMeals()`, now public), one
  instance built in `AppModel.ensureQueue` and handed to both `RootTabView(meals:)` → `ScheduleTab`
  and `YouServices.meals`; `MealComposerSheet`, `MealsDayListView`; `ScheduleSheet.mealComposer`,
  the "+" `Menu`, `DaySheet(onAddMeal:onOpenMeal:)`, `DayView(onAddMeal:)`;
  `MealsQueryResult.Item: Hashable` (a sheet route carries it); mock `mealsQuery`/favorites/
  `mealProblem`; `MealsSupport`, `MealsModelTests` (7), `MealsSnapshotTests` (5); the builder
  smoke legs tap "Add workout" after "+". Traps: a `Menu`'s items are found by label in XCUITest,
  not by identifier; `UIApplication.sendAction(resignFirstResponder)` is the keyboard Done for a
  sheet of decimal-pad fields.
