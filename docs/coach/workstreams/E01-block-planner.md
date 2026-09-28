# E01 · Block planner mode: the coach drafts training blocks, the athlete applies them

## Goal
A fourth chat mode, `planner`, reached from the Training blocks overlay ("Plan with the
coach"). The coach reads the athlete's history and the doctrine, then edits a **block draft**
— one or more contiguous blocks with phases, dates and weekly targets — through a single
reducer tool, `update_block_draft`. Nothing is created until the athlete presses Apply, which
calls the existing `createBlocks` (atomic, ≤ 24) with `triggered_by: 'user'`. Decision D-C07.

Why: a block is the unit the coach reasons in ("92% of planned aerobic volume"), and today the
athlete lays blocks down by hand or from the fixed cycle generator. The builder proved the
shape — a mode whose only tool reduces onto a draft the user owns — and the sight loop proved
the coach can read before it speaks. The planner joins the two: a draft tool plus the read tools
plus `read_doctrine`, no calendar or memory writes.

## Context you need (all on `main`)
- **The builder mode is your template.** `api/_lib/coach/context.ts` `buildChatContext`
  (builder branch lines ~178–199: `requireDraftObject`, `describeDraft`, `buildBuilderPrompt`,
  returns `volatile: ''`); `src/lib/coach/prompt.ts` `buildBuilderPrompt` (role → `safetySection()`
  → Today → `<workout_draft>` → libraries → rules → STYLE); `schemas.ts` `updateWorkoutDraftSchema`
  + `builderToolSchemas()`; `src/lib/builder/draft.ts` `applyDraftUpdate` and — the contract
  to copy — `src/lib/analytics/draft.ts` lines ~286–290 (partial input, per-field guards, all
  violations collected into ONE instructive error returned as the tool_result, a summary of
  what landed); `src/components/builder/BuilderCoachPanel.tsx` (the settle pattern, lines
  62–81: `settledRef`, `confirmAction(async () => reducer…)`, `cancelAction` for any other
  tool). `api/_lib/handlers/coachTool.ts` `DRAFT_TOOLS` (line 32) and its draft branch (lines
  80–104) — iOS settles draft tools there; add yours.
- **Where the mode is pinned** (change every one): `context.ts:41` `ChatMode` + `isChatMode`;
  `src/lib/api.ts:194` `CoachMode`; `api/_lib/handlers/coachConversations.ts:46` `MODES` (and its
  400 message); `supabase/migrations/phase45_coach_runs.sql:54` and
  `phase46_coach_conversations.sql:63` CHECK constraints → a new migration
  `supabase/migrations/phaseXX_coach_planner_mode.sql` that drops and re-adds both constraints
  with `'planner'` (name it `phaseXX_…`; the orchestrator claims the number at PR open; header
  comment "Phase XX"); `ios/Packages/ApexCore/Sources/ApexCore/Coach/ChatMode.swift` (`case
  planner`; grep `ios/Packages` for `switch` over `ChatMode` and cover the case). The CHECK
  widening changes nothing in `database.types.ts` / `DatabaseTypes.swift` (the generator emits
  no enum for a CHECK) — confirm by reading the `coach_runs` block, and say so under DECISIONS.
- **Caching shape.** `api/chat.ts` injects `volatile` whenever it is non-empty and gives the
  prefix a 1h TTL (`prefixTtl = volatile ? '1h' : '5m'`, line ~542; `injectVolatile` line ~545)
  — independent of mode. Return a non-empty `volatile` from the planner branch and the chat
  prompt's cache shape applies. The server read loop is gated `serverLoop = toolMode === 'chat'`
  (line ~575): make it `toolMode === 'chat' || toolMode === 'planner'`. Everything downstream
  (reads executed server-side, `tool_read` / `tool_read_result` wire events, mixed rounds) is
  mode-agnostic; the one write in planner mode streams to the client like a builder update.
- **Prompt pieces to reuse** (`prompt.ts`): `safetySection()`, `doctrineSection()` (+ the
  `DOCTRINE_INDEX` block as `buildStablePrompt` places it), `athleteSection`, `contractSection`,
  `memorySection`, `sanitizeUserText`. `context.ts` already has `blockSummary(supabase, userId,
  todayIso, today, occurrences)` (lines ~80–108) and imports `rowToBlock`, `rowToObjective`,
  `blockCovering`, `blockPeriod`, `computeBlockProgress`, `buildBlockPromptSummary`. Physiology:
  `fetchPhysiologyInputs` → `computePhysiology` → `describePhysiology` as the chat branch does.
  Memory: `listConfirmed` → `toPromptEntries` as the chat branch does.
- **Blocks.** `src/types/blocks.ts` (`TrainingBlock`, `BLOCK_PHASES`, `WeeklyTargets`,
  `Objective`); `src/lib/blocks/validate.ts` `validateBlock` (Mondays, end after start, ≤ 52
  weeks, `parseWeeklyTargets`), `cadence.ts` `overlapsExisting`, `MAX_CYCLE_BLOCKS = 24`,
  `period.ts` `blockPeriod`/`blockWeeks`, `targets.ts` `WEEKLY_TARGET_KEYS`/`TARGET_META`;
  `src/context/blocks.ts` `useBlocks()` → `blocks`, `objectives`, `createBlocks(inputs)`,
  `updateBlock(id, fields)`, `refresh()`; `src/components/blocks/BlocksView.tsx` `Mode` union
  (`list | detail | edit | cycle`) and its header buttons; `BlockEditor.tsx` (its `toMonday` /
  `toExclusiveEnd` date rules are the ones your reducer enforces). `api/_lib/trainingBlocks.ts`
  says an AI write must gate the non-`'user'` path — the planner never writes blocks, so that
  comment stays true; say so under DECISIONS.
- **Read chips.** `useChat` exposes `streamingReads` and `msg.reads`; the sidebar renders them
  with `src/components/sidebar/chat-reads.css` ("Checked: …" chips). `BuilderCoachPanel` does not
  render them; your panel must (import that css; no `app.css`).
- **Evals** (you own `evals/**` except `evals/baseline/`): `evals/src/types.ts` `mode?:
  'builder' | 'analytics'` (three places, lines ~34/104/148); `harness.ts` `buildSystem` per mode
  (lines ~74–77), inline reducers (~96–114), `executeRead` chat-only (line ~91 — planner too);
  `backends/agentSdk.ts` `schemasFor`, `models.ts:74`; `evals/src/reads.ts` mirrors
  `chatToolSchemas` with a pin test in `evals/__tests__/reads.test.ts` — add `plannerToolSchemas`
  to the mirror and the pin; `evals/cases/builder.ts` is the template for `cases/planner.ts`.
- **Lessons from wave D** (both bit CI's `full` job): any generated-types edit follows the
  generator's alphabetical table order in both `database.types.ts` and
  `ios/Packages/ApexKit/Sources/ApexAuth/Generated/DatabaseTypes.swift`; any change to the
  profile GET shape is mirrored in `ios/Fixtures/profile.json`. Neither should apply here.
- **Decision-id cleanup you own:** `src/lib/coach/memory.ts:16` and `src/lib/coach/tools.ts:607`
  cite "D-C03" for "nothing is remembered without the athlete's click"; the decision log's
  D-C03 is embeddings, D-C02 is the proposal gate. Change both comments to D-C02.

## Interface contract (do not rename)
- `ChatMode = 'chat' | 'builder' | 'analytics' | 'planner'`.
- `src/lib/blocks/draft.ts` (pure, no React, `.js` specifiers — `api/**` imports it):
  `BlockDraftItem = Omit<TrainingBlock, 'id'>`; `BlockDraft = { editingId: string | null;
  blocks: BlockDraftItem[] }`; `emptyBlockDraft(today)`; `describeBlockDraft(draft)`;
  `BlockDraftUpdateInput = { blocks?: unknown }` (typed loosely, guarded inside);
  `applyBlockDraftUpdate(draft, input, ctx: { existing: TrainingBlock[]; objectives: Objective[];
  today: Date }) → { draft: BlockDraft; summary: string } | { error: string }`. `blocks` replaces
  the whole list. Each item: `name` (required), `intent`, `phase?` (`BLOCK_PHASES`),
  `objective_id?` (must name an objective in ctx), `start_date` (a Monday, YYYY-MM-DD),
  `end_date` (inclusive; the reducer stores `endDateExclusive` = the next day, which must be a
  Monday), `weekly_targets?` `{cardio_minutes?, vert?: {value, unit: 'ft'|'m'}, distance?:
  {value, unit: 'mi'|'km'}, strength_sessions?, climbing_sessions?, long_session_minutes?}`.
  Rules, each a sentence in the one error: 1 ≤ items ≤ 24; `editingId` set ⇒ exactly one item;
  `validateBlock` on each; items contiguous and in date order (item n+1 starts where item n
  ends); no overlap with `existing` (minus `editingId`); no start before today's Monday unless
  the item is the one being edited. Summary: "Block draft updated: 3 blocks, Oct 6 – Dec 28
  (base 4w · build 4w · peak 3w · taper 1w). The user reviews and presses Apply."
- `src/lib/coach/schemas.ts`: `updateBlockDraftSchema: Anthropic.Tool` (`update_block_draft`,
  description in the builder schema's voice: partial list replacement, the rules above, the
  target vocabulary), `plannerToolSchemas()` = `[updateBlockDraftSchema]` (the write half only
  — `chat.ts` appends the reads, as it does for chat).
- `api/chat.ts`: `cachedToolSchemas('planner', ttl)` = `[...plannerToolSchemas(),
  ...readToolSchemas(), { ...readDoctrineToolSchema }]` — no memory tool, no calendar/meal
  writes (structural: the planner cannot touch the schedule or memory).
- `src/lib/coach/prompt.ts`: `buildPlannerPrompt(): string` (stable: role, `safetySection()`,
  the doctrine index + `doctrineSection()` with one added rule line — "Before proposing phases,
  read `periodization`; read `aerobic-base` or `strength-for-mountain-athletes` when the plan
  leans on either; cite the line you rely on" — block-authoring rules, STYLE) and
  `buildPlannerVolatile(draftText, existingBlocksText, objectivesText, today, athlete, contract,
  memories, physiology): string` (`<block_draft>`, `<existing_blocks>`, `<objectives>`, then
  `athleteSection`, `contractSection`, `memorySection`, the physiology block, Today). Bump
  `PROMPT_VERSION` to `2026.09.29-1`. `coach-gate` goes red on your PR by design; the
  orchestrator refreshes the attestation.
- `api/_lib/coach/context.ts` planner branch: `requireDraftObject(draft)`; fetch blocks +
  objectives (the `blockSummary` helper's queries), physiology and memory in parallel, never as
  preconditions; return `{ system: buildPlannerPrompt(), volatile: buildPlannerVolatile(…),
  toolContext: { definitions, events: [], meals: [] } }`. A draft that is not a block draft →
  `ChatContextError('context.draft is not a block draft')`.
- `api/_lib/handlers/coachTool.ts`: `update_block_draft` joins `DRAFT_TOOLS`; its branch reads
  the athlete's blocks and objectives for `ctx` and answers the same `{ ok, resultText, draft }`.
- Client: `src/components/blocks/BlockPlanner.tsx` (mounted by `BlocksView` for `Mode
  { kind: 'plan'; editingId: string | null }`; owns the `BlockDraft` state; draft cards — name,
  phase, range + weeks (`blockPeriod`), targets (`TARGET_META` labels), objective, per-card
  Remove; Apply → `createBlocks(items)` or `updateBlock(editingId, item)`, then `refresh()` and
  back to the list; Cancel discards; nothing persists before Apply) and
  `src/components/blocks/BlockPlannerPanel.tsx` (`useChat({ toolMode: 'planner' })`; the builder
  panel's settle pattern for `update_block_draft`, `cancelAction` for anything else — reads
  never reach it, they are server-side; renders `streamingReads` and `msg.reads` chips; the
  key-missing empty state as the builder panel). Entry: a "Plan with the coach" button in the
  blocks header next to New cycle (`data-testid="plan-with-coach"`); optional: "Plan with the
  coach" on `BlockDetail` opening the planner with `editingId` (FOLLOW-UP if skipped).
- `coach_conversations` threads are scoped by mode as today (`listCoachConversations('planner')`).

## Ownership
- Yours: `api/chat.ts`, `api/_lib/coach/context.ts`, `src/lib/coach/{prompt,schemas,tools}.ts`
  (tools.ts: the D-C02 comment fix and, if needed, nothing else), `src/lib/coach/memory.ts`
  (comment only), `api/_lib/handlers/coachTool.ts`, `api/_lib/handlers/coachConversations.ts`,
  `src/lib/api.ts` (the `CoachMode` line only), the new migration, `ChatMode.swift`, new
  `src/lib/blocks/draft.ts`, new `src/components/blocks/BlockPlanner.tsx`,
  `BlockPlannerPanel.tsx`, `block-planner.css`, `src/components/blocks/BlocksView.tsx` (and
  `BlockDetail.tsx` if you take the optional entry), `evals/**` except `evals/baseline/`, tests
  (`api/__tests__/chat.test.ts`, `coach-context.test.ts`, `coach-conversations.test.ts`,
  `src/lib/blocks/__tests__/draft.test.ts`, component tests), a mock e2e
  `e2e/mock/block-planner.spec.ts` (`builder-coach.spec.ts` is the template), README: one
  paragraph in the coach section directly after the builder/analytics paragraph.
- Not yours (lane E02 runs in parallel): `src/hooks/useChat.ts`,
  `src/components/sidebar/ChatSidebar.tsx`, `src/context/calendar.ts`, `CalendarContext.tsx`,
  `src/components/layout/AppShell.tsx`, `src/components/modal/**`, `src/components/tracker/**`,
  `src/lib/coach/askContext.ts`. Also not yours: `src/lib/db/database.types.ts`, doctrine text,
  `models.ts`, `api/_lib/mcp/**`, `src/styles/app.css`.
- Migration: you write `phaseXX_coach_planner_mode.sql` (HELD — the orchestrator claims the
  number and Shane ships the PR; say so in your report).

## Steps
1. Mode plumbing: `ChatMode`, `isChatMode`, `CoachMode`, `MODES`, the migration, the Swift
   case; tests for each pin (`isChatMode('planner')`, `?mode=planner`, `coach_runs.mode:
   'planner'`).
2. `src/lib/blocks/draft.ts` + tests (every rule, the summary, `describeBlockDraft`).
3. Schema, prompt (stable + volatile), context branch, `cachedToolSchemas('planner')`, the
   server loop gate; chat tests: `cachedToolSchemas('planner')` names, a two-round read loop in
   planner mode, the write streaming to the client, a 1h prefix with the volatile injected,
   the stable half byte-identical across two turns.
4. `coachTool.ts` branch + test.
5. Client: `BlocksView` mode, `BlockPlanner`, `BlockPlannerPanel`, css; component tests;
   mock e2e (open blocks → Plan with the coach → stubbed chat answers with an
   `update_block_draft` → cards show → Apply → the batch POST body carries the rows).
6. Evals: types, harness planner branch (fixture `blockDraft`, `existingBlocks`, `objectives`;
   reducer inline; reads scripted), backends, mirror + pin, `cases/planner.ts` (four cases: a
   12-week base → build → peak → taper plan on Mondays, contiguous; refuses a peak block with no
   base and cites doctrine; leaves an existing block untouched, no overlap; never reaches for a
   tool it does not have). Tests only — no live run.
7. README paragraph; `PROMPT_VERSION`; report.

## NOT VERIFIED to carry forward
Live model behaviour in planner mode (no key); the eval suite's planner cases (orchestrator's
run); Swift on a Mac (`apexcore-linux` CI job proves the enum compiles); the migration against
the local stack (the fold's `full` job checks types drift; the CHECK widening is applied by
Shane in production).
