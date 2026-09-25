# A04 · Rich confirm cards

## Goal
When the coach proposes a tool call, the confirm card shows what will actually change — a
structured before/after preview computed from the typed tool input and the live context —
instead of a one-line label alone. Pure preview logic in a new module, rendering in the
existing `ConfirmCard`, CSS in a new file. Labels, the queue, and the confirm flow are
untouched.

Why: today the athlete confirms "Update Thursday's workout" without seeing which fields
change. That is the cheapest large trust win in the coach UI, and it is independent of every
other lane.

## Context you need
- The card: `ConfirmCard` in `src/components/sidebar/ChatSidebar.tsx` (around lines 53–83):
  one-line label, "N more after this", Cancel / Confirm. The label is recomputed from live
  state with `findCoachTool(name)?.displayLabel(input, ctx)` (around line 169). Confirm posts
  to `/api/coach-tool`. Keep every existing prop, class name and `data-testid`.
- Tool inputs: schemas in `src/lib/coach/schemas.ts`; the tools and
  `CoachToolContext { definitions, events, meals }` in `src/lib/coach/tools.ts`. Chat tools
  are `delete_event`, `create_event`, `update_event`, `set_event_exercises`,
  `update_exercise_definition`, `log_meal`, `update_meal`, `delete_meal`.
- Types: `src/types/workout.ts` (`WorkoutEvent`, `Exercise`, `ExerciseDefinition`),
  `src/types/nutrition.ts` (`Meal`), `src/lib/nutrition/mapping.ts` (`mealCalories`).
- Styling rules: `src/styles/app.css` is off limits. Put CSS in a new
  `src/components/sidebar/confirm-preview.css` and import it from `ChatSidebar.tsx`, the way
  `src/components/onboarding/tips.css` is imported by its component. Use tokens from
  `src/styles/tokens.css` (`var(--…)`); the chat styles you sit inside are `.chat-confirm-card`
  (app.css ~L1961). Phone width first: the sidebar is the Coach tab on phones.
- Pending actions and the queue: `src/lib/coach/actionQueue.ts`, `src/hooks/useChat.ts`
  (`pendingActions`, `confirmAction`). Do not change them.
- Test conventions: vitest; component tests if the repo has them for the sidebar (look under
  `src/components/**/__tests__` or `src/**/*.test.tsx`); otherwise unit-test the pure module
  and cover rendering with the mock e2e only if an existing spec already opens the coach.

## Interface contract
`src/lib/coach/preview.ts` exports:
- `type ToolPreview =`
  `| { kind: 'event-create'; title: string; date: string; time?: string; durationMinutes?: number; type?: string; exercises: string[] }`
  `| { kind: 'event-update'; title: string; changes: Array<{ field: string; before: string; after: string }> }`
  `| { kind: 'event-delete'; title: string; date: string; scope: 'one' | 'series' | 'unknown' }`
  `| { kind: 'exercises'; title: string; before: string[]; after: string[] }`
  `| { kind: 'definition-update'; name: string; changes: Array<{ field: string; before: string; after: string }> }`
  `| { kind: 'meal'; action: 'log' | 'update' | 'delete'; title: string; lines: string[] }`
- `previewForTool(name: string, input: Record<string, unknown>, ctx: CoachToolContext): ToolPreview | null`
  — pure, never throws (return `null` on anything it cannot read). For updates, diff only the
  fields present in the input against the live event/definition/meal found by id in `ctx`;
  format values for humans (dates as `EEE MMM d`, durations as `45 min`, exercise lists as
  `Name · sets × reps`). Recurring event ids contain `__`; for `delete_event` derive `scope`
  from the input's scope field if the schema has one, else `unknown`.
- `ConfirmCard` calls it and renders the preview between the label and the buttons: a
  compact table for `changes`, a list for `exercises`, a single line per meal fact. When it
  returns `null`, the card renders exactly as today.

## Ownership
- You own: new `src/lib/coach/preview.ts`, its tests (`src/lib/coach/__tests__/preview.test.ts`
  or the repo's pattern), `src/components/sidebar/ChatSidebar.tsx`, new
  `src/components/sidebar/confirm-preview.css`, and any existing `ChatSidebar` test file.
- Do not change: `src/lib/coach/{tools,schemas,prompt,wire,models,actionQueue}.ts`,
  `src/hooks/useChat.ts`, `src/styles/app.css`, `api/**`, `evals/**`. Shared state — never.

## Tests
- `previewForTool` for each tool: a create with exercises; an update changing two of five
  fields (only those two appear); an update whose id is not in `ctx` (returns a preview with
  no `before` values or `null` — pick one and test it); `set_event_exercises` before/after;
  `delete_event` on a recurring id; `log_meal` with macros; garbage input → `null`.
- `ChatSidebar` still renders the label, the "N more" line and both buttons when the preview
  is `null` (existing tests stay green; add one if none exist).
