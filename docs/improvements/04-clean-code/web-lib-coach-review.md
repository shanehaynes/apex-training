# Clean Code review — src/lib/coach, src/lib/review, src/lib/db, src/lib/*.ts (at 7c0fcae2)

### `src/lib/coach/notebook.ts`
- [ ] **P1** · *Duplication / misleading names (G5, N2)* · `src/lib/coach/notebook.ts:32` — `CONTRACT_MAX`, `ReflectionResolution` and `CoachReflection` (lines 32–49) are second copies of the same names in `src/lib/coach/contract.ts:16-73`, written "against" lane D01 before it merged. The copies have already drifted. Here `status` is a plain `string` and `error`/`completed_at` are missing. The "waiting on the athlete" rule is also defined twice, with different meanings: `isPendingReflection` (notebook.ts:108, `resolved_at === null && resolution === null`) and `reflectionAwaitsAthlete` (contract.ts:76, `status === 'done' && contract_after !== null && resolved_at === null`). `reflectionAwaitsAthlete` has no non-test caller (dead code, G9); the live rule, `isPendingReflection`, also counts running, failed and memory-only rows as pending. Pick one rule. **Fix:** delete the notebook copies and import `CONTRACT_MAX`, `ReflectionResolution` and `CoachReflection` from `contract.ts`. Keep one pending predicate in `contract.ts` and use it in `splitReflections`. Update `api.ts:379` re-exports to match.
- [ ] **P2** · *Classes — SRP / cohesion* · `src/lib/coach/notebook.ts:225` — One module holds unrelated concerns. It has the tab list (20–27), duck-typed HTTP error helpers (`statusOf`, `isNotAvailable`, `messageOf`, 66–79 and 195–198), reflection list operations, memory list operations, a generic LCS line diff (`diffLines`, 225–265) and a markdown-ish doctrine parser (`doctrineBlocks`, 283–307). **Fix:** move `diffLines`/`splitContract` to `coach/lineDiff.ts` and `doctrineBlocks` to `coach/doctrine/blocks.ts`. Move `statusOf`/`messageOf`/`isNotAvailable` to a small `apiErrors.ts` that does not import the API client. Notebook keeps only the list transitions.

### `src/lib/coach/tools.ts`
- [ ] **P1** · *Duplication (G5), shotgun surgery* · `src/lib/coach/tools.ts:482` — The snake_case tool input to camelCase domain field mapping is written separately in the executor and in the preview, once per entity. Events: `updateEventTool.execute` spreads at 473–475 and 482–491, and `EVENT_FIELDS` sits at preview.ts:172. Definitions: `DEFINITION_CHANGE_FIELDS` at 392–404 and `DEFINITION_FIELDS` at preview.ts:220. Meals: `mealFieldsFromInput` at 541–554 plus `MEAL_NUMERIC_KEYS` at 517, and `MEAL_FIELDS` at preview.ts:277. Adding one editable field means 3–4 coordinated edits (plus the schema), and nothing fails if one is missed. **Fix:** keep one table per entity, `{ inputKey, field, label, show }`, in a shared module such as `coach/fieldMaps.ts`. Use it in three places: the executor maps through it (one generic `pickMapped(changes, table)`), the preview renders from it, and a test pins it to the schema's `changes.properties`.
- [ ] **P1** · *Duplication (G5)* · `src/lib/coach/tools.ts:99` — `resolveEvent` and `resolveMeal` (99–113) are copied verbatim in `preview.ts:104-117`, and preview.ts:103 says so in its comment ("Same rule as tools.ts resolveEvent"). The card label and the preview must resolve an id the same way, but nothing keeps the two copies in step. **Fix:** export one `resolveEvent(events, id, date?)` / `resolveMeal(meals, id)` from a tiny pure module (e.g. `coach/resolveTarget.ts`) and import it in both files.
- [ ] **P2** · *Duplication (G5)* · `src/lib/coach/tools.ts:250` — Five `displayLabel`s repeat the same three-way fallback: a resolved row, then `unresolvedTarget(id)` when there is ctx, then the model-supplied title. The copies are at 250–253, 450–452, 599–601, 630–632 and 721–723. **Fix:** add a helper `targetText(resolved, ctx, id, describe, modelFallback)` so each label is one line and the trust rule ("never show the model's title when live context exists") lives in one place.
- [ ] **P2** · *Functions — do one thing (G30), duplication (G5)* · `src/lib/coach/tools.ts:183` — `buildExerciseEntries` validates unilateral counts, creates library rows and builds entries. It also calls `matchDefinitionByName` twice per input (189 and 208) and re-lists the same 11 override fields in the fallback entry (221–230) that `overrides` already holds (202–207). **Fix:** split it into `unilateralViolations(inputs, defs)` and `resolveEntry(input, index, deps)`. Build the fallback entry as `{ id, definitionId, name, category, ...overrides }`.
- [ ] **P2** · *Duplication (G5), magic numbers (G25)* · `src/lib/coach/tools.ts:128` — Four truncate-with-ellipsis helpers exist, each with its own bound and its own length rule:
  - `describeChanges` (128–137, `CHANGE_VALUE_MAX` 40)
  - `cut` (668–672, 60, measures `raw.trim().length`)
  - `memory.ts:183` `cut` (80)
  - `preview.ts:58` `text` (60, measures `raw.length`)

  Inline widths 80/20/40 are also scattered through labels (374, 375, 377, 691, 723, 725, 727). **Fix:** add one `truncateInline(value, max)` beside the sanitizers and give the widths names (`LABEL_NAME_MAX`, `LABEL_SIDE_MAX`).
- [ ] **P2** · *Boundaries / inconsistency (G11)* · `src/lib/coach/tools.ts:285` — Model input crosses the boundary inconsistently. Most executors cast `input as { … }` and trust the types: 256, 285–291, 349, 421, 455–461, 573, 604, 635 (e.g. `difficulty as 1|2|3|4|5` at 311 and 490). `leaveNoteTool.execute` (733–738) and `create_exercise_definition` (via `parseNewDefinition`) validate first. **Fix:** give every tool a `parseInput(input): Typed | { error }` like `parseNewDefinition` and have `execute` take the parsed value. Then the cast exists in one audited place per tool.

### `src/lib/coach/preview.ts`
- [ ] **P2** · *Artificial coupling (G13), inconsistency (G11)* · `src/lib/coach/preview.ts:433` — `PREVIEWS` is a second string-keyed per-tool table running parallel to `COACH_TOOLS`. tools.ts:29-31 says the registry exists to avoid exactly this kind of "string-coupled switch site". A new tool can ship with a label and no preview (or a typo'd key), and nothing notices. **Fix:** add an optional `preview(input, ctx)` to `CoachToolDef` and register it in tools.ts. If the import direction matters, at least key `PREVIEWS` by `xxxSchema.name` and add a test that every `COACH_TOOLS` name has an entry.
- [ ] **P2** · *Error handling — swallowed exception* · `src/lib/coach/preview.ts:458` — `previewForTool` catches every exception and returns `null`, so a real bug in a preview builder looks exactly like "malformed input". It degrades silently to a label-only card. **Fix:** keep the fallback, but `console.warn('[apex] preview failed', name, err)` (or report it) before returning `null`.
- [ ] **P2** · *Duplication (G5)* · `src/lib/coach/preview.ts:301` — Protein/carbs/fat are rendered four separate ways:
  - `macroLine` (301–308)
  - `tools.ts:558` `mealMacroSummary`
  - `prompt.ts:393-398`
  - `summary.ts:34-39` (identical to prompt.ts, including the kcal entry)

  **Fix:** add one `formatMacros(meal, { kcal, unit })` in `src/lib/nutrition/mapping.ts` and call it from all four places.

### `src/lib/coach/prompt.ts`
- [ ] **P1** · *Functions — too many arguments (F1), swap-prone signature* · `src/lib/coach/prompt.ts:336` — `buildVolatileContext` takes 9 positional params, `buildSystemPrompt` (440) 10, and `buildPlannerVolatile` (498) 8. Their trailing optionals come in different orders: `physiology, memories, contract` vs `contract, memories, physiology`. `physiology` and `contract` are both `string`, so a swapped call compiles and silently puts the contract in the physiology slot. **Fix:** use one `LiveContextInput` object (`{ today, athlete, block, meals, physiology, memories, contract, … }`) shared by the three builders, destructured with defaults.
- [ ] **P2** · *Functions — do one thing / one level of abstraction (G30, G34)* · `src/lib/coach/prompt.ts:347` — `buildVolatileContext` formats today's events (350–356), filters and formats this week (358–371), computes the 4-week completion rate (373–386), formats meals plus totals (388–403), and assembles the document. The week-window filter is written twice (358–363 and 376–381). **Fix:** extract `eventsInIsoWeek(events, ref)`, `completionRate(allEvents, today, weeks)`, `todayList`, `weekList` and `mealsList`. The builder then reads as section assembly only.
- [ ] **P2** · *Duplication (G5)* · `src/lib/coach/prompt.ts:177` — The exercise-library name list (filter archived, sanitize at 80, sort) is duplicated between `buildBuilderPrompt` (177–180) and `buildStablePrompt` (281–284). A change to one would quietly break the byte-stability assumption of the other. **Fix:** add `libraryNames(definitions)` and call it from both.
- [ ] **P2** · *Artificial coupling (G13)* · `src/lib/coach/prompt.ts:32` — `sanitizeUserText` and `sanitizeInlineText` live in the prompt module. As a result `tools.ts`, `preview.ts`, `memory.ts` and `askContext.ts` import prompt.ts, with its date-fns/doctrine/nutrition graph, just to clean strings. **Fix:** move both to `coach/sanitize.ts` (dependency-free) and re-export from prompt.ts for existing callers.
- [ ] **P3** · *Magic numbers (G25)* · `src/lib/coach/prompt.ts:355` — Sanitize bounds are bare literals:
  - 80 (144, 150, 179, 190, 283, 543)
  - 120 (355, 370, 401)
  - 1000 (64–65)
  - 500 (148)
  - 8000 (203, 555)
  - 4000 (524)

  The date format `'EEEE, MMMM d, yyyy'` appears 4 times (199, 347, 527, 551). `askContext.ts:30` defines `TITLE_MAX = 120` as "the prompt's own inline cap", but no such named cap exists here to keep them in sync. **Fix:** export named constants (`INLINE_NAME_MAX`, `INLINE_TITLE_MAX`, `DRAFT_TEXT_MAX`, …) and a `todayLine(today)` helper. askContext imports the title cap.

### `src/lib/coach/schemas.ts`
- [ ] **P2** · *Duplication (G5)* · `src/lib/coach/schemas.ts:83` — Enum value lists are repeated as literals:
  - workout types at 83, 390, 478, 489
  - exercise categories at 21, 152, 182 (plus `newDefinition.ts:13` `CATEGORIES`)
  - weekday codes at 102, 409
  - meal types at 236, 483

  Adding a workout type takes four edits in this file alone. The file already uses the right pattern for chart enums (`CHART_SPORTS`, 429–437). **Fix:** hoist `WORKOUT_TYPES`, `EXERCISE_CATEGORIES`, `WEEKDAY_CODES` and `MEAL_TYPES` consts to the top (dependency-free) and reference them. Have `newDefinition.ts` import `EXERCISE_CATEGORIES`.
- [ ] **P2** · *Duplication / magic numbers (G5, G25)* · `src/lib/coach/schemas.ts:309` — Limits are restated as numbers inside description prose: "at most 2000 characters" (309) duplicates `CONTRACT_MAX`, and "at most 400 characters" (332) duplicates `ANNOTATION_BODY_MAX`. Both source modules (`contract.ts`, `annotations.ts`) already import nothing at runtime, so the dependency-free rule still holds. **Fix:** interpolate `${CONTRACT_MAX}` and `${ANNOTATION_BODY_MAX}` into the descriptions.

### `src/lib/coach/model.ts`
- [ ] **P2** · *Misleading comment (C2), redundant alias* · `src/lib/coach/model.ts:7` — The header calls this file "the default's single source of truth", but the value is `DEFAULT_COACH_MODEL` in `models.ts:123`. This file only re-exports it under a second name, `COACH_MODEL` (16). Two names for one constant invite someone to "bump" the wrong file. **Fix:** fix the comment to say models.ts owns the default. Better: migrate callers to `DEFAULT_COACH_MODEL`/`defaultCoachModel().badge` and delete model.ts.

### `src/lib/coach/summary.ts`
- [ ] **P2** · *Functions — do one thing (G30)* · `src/lib/coach/summary.ts:49` — `buildSessionRecap` (58 lines) mixes header lines, cardio formatting (65–74), set/skip counting with warm-up rules (75–88), the PR section (93–100) and nutrition. **Fix:** extract `cardioLine(tracked)`, `strengthLine(tracked)` (returns the done/skipped text) and `prSection(prs)`. The function then lists sections.
- [ ] **P3** · *Duplication (G5)* · `src/lib/coach/summary.ts:96` — `pr.kind === 'oneRM' ? 'strength' : pr.kind` re-implements `recordKindLabel` (`src/lib/review/formats.ts:47`). **Fix:** import and use `recordKindLabel`.

### `src/lib/coach/eventRepeat.ts`
- [ ] **P3** · *Error handling (swallowed), duplication (G5)* · `src/lib/coach/eventRepeat.ts:77` — The `try { … } catch { occurrences = null }` turns any `expandRecurrence`/`parseRRule` failure into "count unknown" with no trace. The error string at 48 is also duplicated verbatim at 68. **Fix:** log the caught error. Hoist the message into a `DAYS_ERROR` const.

### `src/lib/review/stats.ts`
- [ ] **P1** · *Duplication (G5), function size (G30)* · `src/lib/review/stats.ts:130` — `computePeriodPRs` (94–218, 125 lines) runs four near-identical loops. Each compares the day's best with the running best, pushes a PR if inside the period, and advances the best: oneRM 130–145, duration 146–159, reps 160–173, cardio quantity 198–212. A change to PR semantics (e.g. tie handling) has to be made four times. **Fix:** write one generic `advanceBests(dayBests, runningBests, date, period, valueOf, toPR)` and call it per kind. Optionally collapse `dayLift`/`dayDuration`/`dayReps` into one map keyed by `kind|name`.
- [ ] **P1** · *Functions — do one thing (G30), duplication (G5)* · `src/lib/review/stats.ts:441` — `computeYearlyStats` (110 lines) computes the monthly breakdown, best month, best category, most-improved halves, biggest PRs and the memorable shortlist. It re-filters completions and sessions exactly as `computeReviewStats` already did (446–448 vs 338–340). Its local `inMonth` (453) re-implements `inPeriod` (56). **Fix:** extract `monthlyBreakdown(inputs, base)`, `mostImprovedCategory(completions)` and `memorableCandidates(base, sessions)`. Have `computeReviewStats` return (or expose) the filtered rows, and use `inPeriod(date, monthPeriod)`.
- [ ] **P2** · *Duplication (G5)* · `src/lib/review/stats.ts:424` — The "half-open range → inclusive label" is implemented three times:
  - `isoMonth.ts:101` `rangeLabel`
  - `monthRangeLabel` here (424–429, mutating a `Date` with `setDate`)
  - `email.ts:27` `shortRange`

  `format(parseISO(x), 'MMM d')` is also inlined 5× (516, 521, 527, 532, 540) although `formats.ts:51` `shortDate` exists. **Fix:** give `rangeLabel` a `{ withYear }` option, use it in all three places, and replace the inline formats with `shortDate`.
- [ ] **P3** · *Magic numbers (G25)* · `src/lib/review/stats.ts:486` — Unnamed tuning and calendar constants:
  - top-N 5 (326, 499)
  - half split month 7 (486)
  - 8 multi-PR days (513)
  - 10 sampled notes (537)
  - 200-char excerpt (539)
  - 13 months (451)
  - in `isoMonth.ts`: 13/4/48/28 (34, 44, 52, 56, 58)

  **Fix:** add named consts (`TOP_EXERCISES`, `FIRST_HALF_LAST_MONTH`, `MEMORABLE_NOTES_MAX`, `MONTHS_PER_ISO_YEAR`, `WEEKS_PER_MONTH`, …).

### `src/lib/review/email.ts`
- [ ] **P1** · *Duplication (G5)* · `src/lib/review/email.ts:96` — `buildSections` (96–189) and `recap.ts` `statsBody`/`buildYearlyRecap` (33–157) build the same facts separately, and they have already drifted:
  - "Most-trained" renders `(n sets)` in recap.ts:72 but `(n)` in email.ts:130.
  - "Biggest climb" says "elevation" in recap.ts:92 but not in email.ts:146.
  - The month line is copied verbatim (recap.ts:129-130 and email.ts:161-162).

  `formats.ts:6-7` promises the two "always show identical figures". **Fix:** build one `reviewFacts(stats): Section[]` (label/value rows plus lists) in a shared module. Render it once to the recap's plain text and once to the email's HTML/text.
- [ ] **P2** · *Functions — do one thing (G30)* · `src/lib/review/email.ts:193` — `renderReviewEmail` (68 lines) builds subject/heading/subheading, stat tiles, commentary HTML, section HTML, the page shell and the plain-text body. **Fix:** extract `headerFor(stats)`, `tilesFor(stats)`, `commentaryHtml(text)`, `renderHtml(...)` and `renderText(...)`.

### `src/lib/review/weekly.ts`
- [ ] **P2** · *Duplication / inconsistency (G5, G11)* · `src/lib/review/weekly.ts:147` — "Is this a YYYY-MM-DD date" is answered differently across modules:
  - `isIsoDate` here (147–151) round-trips through date-fns.
  - `annotations.ts:69` `isDayId` round-trips through `Date.UTC`.
  - `eventRepeat.ts:28` `ISO_DATE` checks shape only, so it accepts `2026-02-31`.
  - `askContext.ts:34` checks shape only, then re-tests the same regex at 72 instead of reusing its own `safeDate`.

  **Fix:** add one exported `isIsoDate` in a dependency-free shared util and use it everywhere.
- [ ] **P3** · *Duplication (G5)* · `src/lib/review/weekly.ts:175` — `isRecord` is redefined in weekly.ts:175, notebook.ts:57, memory.ts:113 and preview.ts:99. `annotations.ts:186-192` and `tools.ts:826` inline the same check. **Fix:** export one `isRecord` from a dependency-free `guards.ts`.

### `src/lib/db/types.ts`
- [ ] **P2** · *Duplication (G5)* · `src/lib/db/types.ts:244` — Literal unions are retyped by hand instead of reusing the domain's source types:
  - `CoachMemoryRow.kind`/`source_kind` (244–245) duplicate `MemoryKind` and `CoachMemory['source_kind']` (memory.ts:28, 265).
  - `CoachAnnotationRow` (297–299) duplicates `AnnotationTargetKind`/`AnnotationSeverity`/`AnnotationAuthor` (annotations.ts:12-19).
  - `CoachReflectionRow` (310–311) duplicates contract.ts:58,19.
  - `TrainingBlockRow.phase` (226) duplicates the block phases.

  The comments admit the mirroring. **Fix:** `import type` those unions (type-only, so no runtime graph is added) and reference them in the `Row<>` overrides.

### `src/lib/api.ts`
- [ ] **P2** · *Inconsistency (G11), argument order* · `src/lib/api.ts:102` — `deleteJson(path, label, body?)` puts the body after the label and accepts no `opts`. `postJson`/`patchJson` take `(path, body, label, opts)`. Callers such as `deleteJson('/api/coach-memory', 'Forgetting memory', { id })` read backwards next to `postJson('/api/coach-memory', { id }, 'Confirming memory')`, and DELETE can never be quiet. **Fix:** make the signature `deleteJson(path, body, label, opts?)` to match, and update its callers (6 in api.ts).
- [ ] **P2** · *Error handling — lying return type* · `src/lib/api.ts:77` — `res.json().catch(() => undefined) as Promise<T>` resolves a non-JSON or empty 2xx to `undefined` while the type promises `T`. Callers then dereference fields of `undefined`. **Fix:** type the transport as `Promise<T | undefined>` (or special-case 204). Otherwise throw `ApiError('… returned invalid JSON', res.status)` on parse failure.
- [ ] **P2** · *Dead code (G9), misleading comment (C2)* · `src/lib/api.ts:359` — `createCoachAnnotation` has no callers. Its comment says the coach's `leave_note` tool "calls [it] once it exists". `leave_note` exists and inserts through `deps.createAnnotation` with the service role (tools.ts:739–746). **Fix:** delete the function and its comment.
- [ ] **P2** · *Classes — SRP (module too broad)* · `src/lib/api.ts:152` — At 412 lines, api.ts holds the transport, every endpoint wrapper (legal, MCP, conversations, memory, weekly review, annotations, notebook) and domain types/logic such as `McpAccess`/`mcpAccessOf` (155–159), `CoachConversation` and `StoredCoachMessage`. Its header says it is "Single JSON transport". **Fix:** keep `ApiError`/`requestJson`/verbs in api.ts. Move endpoint groups to `api/coach.ts`, `api/mcp.ts` and `api/account.ts`, and move `mcpAccessOf` beside the MCP types.
- [ ] **P3** · *Duplication (G5)* · `src/lib/api.ts:131` — `downloadAccountExport` re-implements `requestJson`'s failure branch (read detail, warn, toast, throw `ApiError`) at 131–136. **Fix:** extract `failResponse(res, label, opts)` and call it from both.

### `src/lib/climbing.ts`
- [ ] **P3** · *Duplication (G5), inconsistency (G11)* · `src/lib/climbing.ts:60` — The `+`/`-` modifier ternary is repeated 4× in `parseGrade` (53, 60, 64, 67). `sectionLabels` (129) re-tests `type === 'outdoor-climbing'` instead of calling `isOutdoorClimbing` (92). **Fix:** add a `nudge(sign, step)` helper and call `isOutdoorClimbing(type)`.

### `src/lib/time.ts`
- [ ] **P3** · *Duplication (G5)* · `src/lib/time.ts:44` — `toDisplayTime` (44–46) re-implements the 12-hour formatting of `minutesToDisplayTime` (35–37). **Fix:** `return parsed ? minutesToDisplayTime(parsed.h * 60 + parsed.m) : null;`.

## Not checked
The eight doctrine topic files (`src/lib/coach/doctrine/{principles,aerobicBase,periodization,strength,climbing,recovery,mobility,athleteIdeal}.ts`) were checked for code only. Each one is an import, a `DoctrineTopic` constant and a long prose template string with no logic. The prose was not reviewed line by line because it is curriculum text (eval-governed), not code. `src/lib/db/database.types.ts` was skipped as generated. Everything else in scope was read in full.
