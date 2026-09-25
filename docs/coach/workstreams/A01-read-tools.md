# A01 · Read tools for the in-app coach

## Goal
Give the in-app coach a read-only tool surface it can call from a server-side loop: the
eight existing MCP query tools plus three new ones (`get_session_summaries`, `get_reviews`,
`search_history`), exposed through one adapter module with a stable interface the next wave
wires into `api/chat.ts`. Nothing in this lane changes coach behaviour yet; it adds the
capability and its tests.

Why: the coach today is blind. It is handed this week's schedule and today's meals and
cannot read set logs, PRs, HR data, the post-workout summaries it wrote
(`workout_sessions.coach_summary`), the monthly/yearly reviews, or past threads. The MCP server
already exposes most of this to outside clients; the coach cannot call it. A coach that cannot
see history cannot periodize.

## Context you need
- MCP tool definitions: `api/_lib/mcp/protocol.ts` defines
  `McpToolDef { name; description; inputSchema; run(supabase, userId, args) }` and
  `ToolInputError`. The registry is `api/_lib/mcp/toolRegistry.ts` (`MCP_TOOLS`, eight tools).
  Tools live in `api/_lib/mcp/tools/{schedule,tracking,blocks,library,meals}.ts`; argument
  helpers in `api/_lib/mcp/args.ts` (`optionalEnum`, `optionalInt`, `requireDateRange`,
  `requireString`); shared queries in `api/_lib/mcp/data.ts`. Every number they return comes
  from the same pure functions the app uses (`src/lib/tracking/records.ts`,
  `src/lib/review/stats.ts`, `src/lib/library/stats.ts`) — keep that rule.
- The MCP handler (`api/_lib/handlers/mcp.ts`) is an external, untrusted-input channel with
  its own bearer tokens. That is why `search_history` must **not** join `MCP_TOOLS`: it reads
  `coach_messages`, which is service-role only and never leaves the app.
- Tables (see `src/lib/db/database.types.ts` for columns): `workout_sessions` (has
  `coach_summary text`, `started_at`, `finished_at`, an event/occurrence reference),
  `reviews` (`ai_commentary`, `stats jsonb`, period columns), `coach_messages`
  (`conversation_id`, `role`, `display_text`, `kind`, `created_at`), `objectives` (`notes`).
  The API's Supabase client is the service role (`api/_lib/supabaseAdmin.ts`); use the
  `Admin` type pattern from `api/_lib/coach/context.ts`
  (`NonNullable<ReturnType<typeof getSupabaseAdmin>>`).
- Full-text search without an index: PostgREST supports `.textSearch(column, query, {type: 'websearch'})`
  on a plain text column (it wraps `to_tsvector`). No migration, no index — hobby scale.
- The Anthropic SDK is `@anthropic-ai/sdk` (already a dependency). Import the type as
  `import type Anthropic from '@anthropic-ai/sdk'` and use `Anthropic.Tool`.
- How existing MCP tools are tested: look for tests next to them (`api/_lib/mcp/**/__tests__`
  or `api/__tests__/mcp*`) and follow the same stub pattern for the Supabase client.

## Interface contract (the next wave imports exactly this — do not rename)
File `api/_lib/coach/readTools.ts` exports:
- `COACH_READ_TOOLS: readonly McpToolDef[]` — the eight MCP tools, then
  `get_session_summaries`, `get_reviews`, `search_history`, in that fixed order.
- `readToolSchemas(): Anthropic.Tool[]` — one `Anthropic.Tool` per entry (`name`,
  `description`, `input_schema`), same order every call (the prompt cache is a prefix match
  over the tool list). Do not set `strict` unless the schema already has
  `additionalProperties: false` and a complete `required`.
- `isReadToolName(name: string): boolean`.
- `executeReadTool(supabase, userId, name, input): Promise<{ text: string; isError: boolean }>`
  — runs `McpToolDef.run` verbatim (never fork tool logic), `JSON.stringify`s the payload;
  `ToolInputError` → `{ text: <message>, isError: true }`; any other error →
  `{ text: 'tool failed', isError: true }` plus a `console.warn` with the message only, never a
  stack or key material; an unknown name → `isError: true`. It never throws.
- `readToolLabel(name, input): string` — the one-line chip the UI shows, e.g.
  `Checked: Deadlift history`, `Checked: PRs (last 90 days)`, `Checked: stats 2026-08-01 → 2026-09-25`,
  `Checked: schedule`, `Searched history: "left shoulder"`. Never throws; falls back to
  `Checked: <name>`.

New tools (each an `McpToolDef` in a new file under `api/_lib/mcp/tools/`):
- `get_session_summaries` (`sessions.ts`): args `{ start?: YYYY-MM-DD, end?: YYYY-MM-DD, limit?: int ≤ 50 }`
  (default: last 30 days, limit 20). Returns `{ sessions: [{ date, title, durationMinutes, summary }] }`
  from `workout_sessions` rows with a non-empty `coach_summary`, newest first. Join the
  workout title through whatever reference the session row carries (read the schema).
- `get_reviews` (`reviews.ts`): args `{ kind?: 'month' | 'year', limit?: int ≤ 12 }`. Returns
  `{ reviews: [{ kind, periodLabel, commentary, stats }] }`, newest first. Read
  `api/_lib/reviewData.ts` (`getReview`, `createReview`) and `src/lib/review/types.ts` for the
  period shape.
- `search_history` (`history.ts`): args `{ query: string (required, ≤ 200 chars), start?, end?, kinds?: ('message'|'session_summary'|'review'|'objective')[] , limit?: int ≤ 30 }`.
  Searches, per kind, `coach_messages.display_text` (assistant and user rows, `kind = 'turn'`),
  `workout_sessions.coach_summary`, `reviews.ai_commentary`, `objectives.notes`, all scoped to
  `user_id`. Returns `{ results: [{ kind, sourceId, date, snippet }] }` newest first, snippet
  ≤ 240 chars around the match. Errors in one kind degrade to fewer results, not a thrown
  error.
- Register `get_session_summaries` and `get_reviews` in `MCP_TOOLS` (append at the end).
  Do **not** register `search_history` there; say why in a comment.

## Ownership
- You own: `api/_lib/mcp/**` (new tool files, `toolRegistry.ts`, tests), new
  `api/_lib/coach/readTools.ts`, its tests (`api/__tests__/readTools.test.ts` or beside the
  MCP tests, whichever pattern the repo uses), and `CONNECTORS.md` if the MCP tool list is
  documented there (add the two new tools).
- Do not change: `api/chat.ts`, `api/_lib/coach/context.ts`, `api/_lib/coach/physiology.ts`
  (another lane), `src/lib/coach/**` (other lanes), `src/hooks/**`, `src/components/**`,
  `evals/**`, `api/_lib/handlers/**` (the MCP handler picks up the registry automatically),
  anything under Shared state — never.

## Tests
- Unit-test every new tool's argument validation and its `run` against a stubbed Supabase
  client (follow the existing MCP tests).
- `readTools.test.ts`: order of `readToolSchemas()` is stable and matches `COACH_READ_TOOLS`;
  `executeReadTool` maps `ToolInputError` and unknown names to `isError: true` without
  throwing; `readToolLabel` never throws on empty input.
- The ESM import test must stay green (`.js` specifiers).
