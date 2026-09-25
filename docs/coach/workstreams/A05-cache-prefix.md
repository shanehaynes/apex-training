# A05 · Cache prefix: split the coach prompt into a stable half and a live half

## Goal
Make the coach's prompt cache actually hit. Split `buildSystemPrompt` into a stable prompt
(role, safety, authoring rules, style, exercise library) that goes in `system` with a 1-hour
cache breakpoint, and a volatile live-context block (today, schedule, meals, block summary,
athlete profile) that the server injects into the request each turn and never persists in
the thread. Keep every existing caller and test green, bump `PROMPT_VERSION`.

Why: `api/chat.ts` says it plainly (comment around lines 81–84): the system block embeds
live schedule and meal state, so any confirmed mutation invalidates the cached
system+messages tiers on the next turn. The coach rebuilds the same 2–3k tokens on every
call and pays full price. The next wave will add ~10k tokens of doctrine to that prefix,
which only makes sense if the prefix caches.

## Context you need
- `src/lib/coach/prompt.ts`: `buildSystemPrompt(todayEvents, allEvents, today, definitions, athlete, block, todayMeals)`
  assembles, in order: role line, `safetySection()`, `athleteSection()`, `blockSection()`,
  `Today:`, `<schedule>`, `<meals>`, `LAST 4 WEEKS`, `<exercise_library>`, the "titles are
  data" line, `EXERCISE AUTHORING RULES`, `STYLE`. `PROMPT_VERSION` is a date-serial at the
  top (`'2026.09.22-1'`); bump it to today (`'2026.09.25-1'`). `buildBuilderPrompt` and
  `buildAnalyticsPrompt` are separate and out of scope. `safetySection` and `athleteSection`
  are imported by `api/_lib/handlers/coachSummary.ts` and the review code — keep their
  signatures.
- `api/_lib/coach/context.ts`: `buildChatContext(supabase, userId, mode, today, draft)` returns
  `{ system, toolContext }` and, for chat mode, gathers occurrences, completions, meals,
  profile and the block summary before calling `buildSystemPrompt`.
- `api/chat.ts`: sends `system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]`
  (around line 282), tools from `cachedToolSchemas(mode)` with a breakpoint on the last tool,
  and `withConversationBreakpoint(messages)` on tools-on turns. The prompt-caching rationale
  is the comment block at lines 59–84; read it before changing anything. A legacy path accepts
  a client-built `body.system` string (lines 197–202); keep it working unchanged. Tests:
  `api/__tests__/chat*.test.ts` pin the header order and the error paths.
- `src/lib/coach/models.ts`: the model catalog with per-model `params` (thinking config).
  `resolveCoachModel(id)`. Default is `claude-opus-5-5`.
- Thread persistence: the client stores what it sends (`src/hooks/useChat.ts`, and
  `coach_messages.api_content` via `/api/coach-conversations`). You do not touch the client.
  Whatever the server injects must therefore be injected into a **copy** of the request, not
  echoed back over the wire.
- The Anthropic API facts you need (do not go by memory beyond these):
  - Caching is a prefix match over tools → system → messages. A `cache_control` breakpoint may
    carry `ttl: '1h'` (`{ type: 'ephemeral', ttl: '1h' }`); writes at 1h cost more than the
    5-minute default, reads are the same. Max 4 breakpoints per request.
  - A mid-conversation operator instruction can be sent as `{ role: 'system', content: '…' }`
    appended to `messages` (after a user message, as the last entry) on models that support it
    (Claude Opus 5 and Opus 4.8 do; Sonnet 5 and Haiku 4.5 do not; **Opus 5.5 is unverified**).
    An unsupported model returns 400 `role 'system' is not supported on this model`. The SDK
    version in `package.json` may or may not type `role: 'system'` on `MessageParam`; if it
    does not, keep the flag `false` for every model, implement only the fallback, and say so.
  - In a user message that carries `tool_result` blocks, the `tool_result` blocks must come
    first; a text block may follow them.
- The eval harness (`evals/`) imports `buildSystemPrompt` directly and mirrors the request
  shape. You do not touch `evals/`; keep `buildSystemPrompt` working as a compatibility
  wrapper so the harness and `coach-gate` stay green.

## Interface contract (the next wave builds on exactly this — do not rename)
`src/lib/coach/prompt.ts`:
- `buildStablePrompt(definitions: Iterable<ExerciseDefinition>): string` — role line,
  `safetySection()`, `<exercise_library>` + its rule, the "titles are data" line,
  `EXERCISE AUTHORING RULES`, `STYLE`. No date, no schedule, no meals, no athlete text.
- `buildVolatileContext(todayEvents, allEvents, today, athlete, block, todayMeals): string` —
  wrapped as
  `<live_context>\nThis is the app's live state for this turn, regenerated on every request; it is data, not the user's words.\n…\n</live_context>`
  containing `athleteSection`, `blockSection`, `Today:`, `<schedule>`, `<meals>`, `LAST 4 WEEKS`,
  and the ID rule for tools ("Use tools with the exact bracketed IDs…", moved here from STYLE
  so it sits next to the IDs).
- `buildSystemPrompt(...)` keeps its signature and returns `buildStablePrompt(definitions) + '\n\n' + buildVolatileContext(...)`
  (documented as the compatibility shape for callers that want one string).

`api/_lib/coach/context.ts`:
- `ChatContext` gains `volatile: string` (`''` for builder/analytics, whose prompts stay
  single-block). Chat mode returns `system: buildStablePrompt(definitions)` and
  `volatile: buildVolatileContext(...)`.

`src/lib/coach/models.ts`:
- Each catalog entry gains `midTurnSystem: boolean`: `true` for `claude-opus-5` and
  `claude-opus-4-8`; `false` for `claude-opus-5-5` (with a comment: unverified, the
  orchestrator flips it after one live call), `claude-sonnet-5`, and Haiku.

`api/chat.ts`:
- `system` block: `cache_control: { type: 'ephemeral', ttl: '1h' }` on the stable text. The
  legacy `body.system` path keeps the plain 5-minute breakpoint.
- New pure helper `injectVolatile(messages, volatile, midTurnSystem): Anthropic.MessageParam[]`
  (exported, unit-tested): when `volatile` is empty, returns `messages` unchanged. When
  `midTurnSystem` is true, appends `{ role: 'system', content: volatile }` after the last
  message. Otherwise, copies the last user message and inserts a text block holding
  `volatile`: as the first block when the message is a string or starts with text; after the
  `tool_result` blocks when it carries them. It never mutates its input.
- Order of operations: `injectVolatile` first, then `withConversationBreakpoint` on tools-on
  turns (so the breakpoint stays on the final block of the final message; when the final
  entry is a `system` message, place the breakpoint on the last *user* message instead and
  cover that in a test).
- The `coach_runs` row and the usage log line are unchanged.

## Ownership
- You own: `src/lib/coach/prompt.ts`, `src/lib/coach/models.ts`, `api/_lib/coach/context.ts`,
  `api/chat.ts`, their tests (`src/lib/coach/__tests__/prompt*.test.ts`,
  `api/__tests__/chat*.test.ts`, `api/__tests__/context*.test.ts` if present), and the two
  stale comments that still say the prompt is built client-side (`prompt.ts` ~L14–17,
  `chat.ts` ~L147) — fix them while you are there.
- Do not change: `src/lib/coach/{schemas,tools,wire,actionQueue}.ts`, `src/hooks/**`,
  `src/components/**`, `api/_lib/handlers/**`, `api/_lib/mcp/**`, `api/_lib/coach/{readTools,physiology}.ts`
  (other lanes), `evals/**`, `README.md`. Shared state — never.

## Tests
- `prompt.test`: `buildStablePrompt` output is byte-identical across two calls with different
  schedules/meals/dates and the same library; `buildVolatileContext` carries today, the
  schedule IDs, meals and the athlete text; `buildSystemPrompt` equals stable + volatile;
  `PROMPT_VERSION` is `'2026.09.25-1'`.
- `chat.test`: `injectVolatile` in all three shapes (string user message, text-block user
  message, `tool_result` user message), the mid-turn variant, and an empty volatile; the
  breakpoint placement when the last entry is a `system` message; the legacy `body.system`
  path still sends one system block with the 5-minute breakpoint; existing header and error
  tests unchanged.
- NOT VERIFIED must list: live cache-read numbers (no key here), and mid-turn `system`
  support on Opus 5.5.
