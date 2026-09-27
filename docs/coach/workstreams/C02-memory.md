# C02 · Memory: `coach_memory` table, the memory tool with a Postgres backend, proposal cards

## Goal
The coach remembers what the athlete confirms. A `coach_memory` table holds short, typed facts
("left shoulder: avoid overhead pressing until cleared", "prefers morning sessions", "goal:
Rainier June 2027"). The model reads them through Anthropic's memory tool inside the B01
server-side read loop, proposes new ones as confirm cards ("Remember: …") through the existing
write path, and confirmed memories render in the live half of the prompt, bounded. A handler
lists, confirms and archives them. Nothing is remembered without the athlete's click (decision
D-C03: approve everything).

## Context you need
- The B01 loop on `main`: `api/chat.ts` (`chatToolSchemas`, `runServerSideTool`, the loop;
  `isServerSideTool` filters tool_use blocks by NAME), `src/lib/coach/tools.ts`
  (`isServerSideTool`, `SERVER_SIDE_READ_TOOL_NAMES`, `COACH_TOOLS` with `CoachToolDef
  { schema, execute(input, deps), displayLabel, ... }`), `src/lib/coach/schemas.ts`,
  `src/hooks/useChat.ts` (`historyForTurn`, `settleAction`, `heldResults`), the confirm executor
  `api/_lib/handlers/coachTool.ts` (POST /api/coach-tool, `findCoachTool(name).execute`), and
  `src/lib/coach/preview.ts` (A04's confirm-card preview; add a `memory` kind).
- Prompt: `src/lib/coach/prompt.ts` — `buildVolatileContext(...)` is where a bounded
  `<athlete_memory>` section goes (after the athlete section, before the block); the stable half
  gets one rule line about memory (propose, never assume; cite a memory when it drives advice).
  Bump `PROMPT_VERSION` → `2026.09.27-1`.
- Memory tool: Anthropic's `memory_20250818` (`{ type: 'memory_20250818', name: 'memory' }`).
  The model issues commands over a virtual filesystem under `/memories`: `view` (path),
  `create` (path, file_text), `str_replace` (path, old_str, new_str), `insert` (path,
  insert_line, insert_text), `delete` (path), `rename` (old_path, new_path). Read the exact
  command shapes from the installed SDK: `node_modules/@anthropic-ai/sdk/resources/beta/messages/`
  (search `MemoryTool20250818`) and the helper `helpers/beta/memory` (`betaMemoryTool` /
  `BetaAbstractMemoryTool`). **Decision rule:** if the typed tool is usable on
  `client.messages.stream` (no beta header) and fits `cachedToolSchemas`' `Anthropic.Tool[]`
  after widening the type to `Anthropic.ToolUnion[]`, use it. If it needs the beta client,
  do NOT switch `api/chat.ts` to the beta client; instead declare a custom tool named `memory`
  with an explicit `input_schema` mirroring those six commands and say so under DECISIONS.
- Virtual layout: one file per kind — `/memories/injuries.md`, `/memories/preferences.md`,
  `/memories/goals.md`, `/memories/history.md`, `/memories/notes.md` (kind enum: injury ·
  preference · goal · history · note). `view /memories` lists them with sizes; `view <file>`
  renders that kind's confirmed rows one per line, `- [id:<uuid>] <content>`. A file is a view
  over rows, not a stored blob.
- Read vs write: `view` is a read and runs server-side in the B01 loop. Every other command is a
  write and becomes a confirm card. `isServerSideTool` filters by name today; it must learn to
  look at the input for `memory`: `isServerSideTool(name, input?)` returns true for
  `memory` only when `input.command === 'view'`. Update every caller (chat.ts loop, useChat,
  `readChipsOf`) and the tools test that pins the name mirror.
- Persistence pattern: `api/_lib/handlers/coachConversations.ts` (routing by method + body
  shape, `requireUser`, `enforceRateLimit`, `.eq('user_id', userId)` on every query), registered
  in `api/_lib/app.ts` via `app.all('/coach-conversations', bridge(coachConversations))`.
  Migration style: `supabase/migrations/phase46_coach_conversations.sql` (WHY header, RLS on,
  no policies, explicit revoke from anon/authenticated and grant to service_role — copy the
  GRANTS block verbatim, it is what the rls-coverage integration test checks).
- Types: `src/lib/db/database.types.ts` is generated from the local stack, which you do not
  have. Hand-write the `coach_memory` block in exactly the generator's style (copy the
  `coach_conversations` block: Row / Insert / Update / Relationships), and add a row type to
  `src/lib/db/types.ts`. Flag it under NOT VERIFIED; CI's `full` job checks drift.
- Client API helpers: `src/lib/api.ts` (`getJson`/`postJson`/`patchJson`/`deleteJson`, the
  `*CoachConversation*` functions as the pattern).

## Ownership
- New: `supabase/migrations/phaseXX_coach_memory.sql` (literal `XX`; the orchestrator claims
  the number at PR open — this overrides the common "never touch migrations" line for this one
  new file), `api/_lib/coach/memory.ts` (the backend: list/view/render, apply a confirmed
  command → rows), `api/_lib/handlers/coachMemory.ts`, `src/lib/coach/memory.ts` (client
  types, kinds, path↔kind mapping — pure, no React), tests for each.
- Edit: `api/chat.ts`, `api/_lib/coach/context.ts` (fetch confirmed memories for the volatile
  half, never a precondition), `api/_lib/handlers/coachTool.ts`, `src/lib/coach/{prompt,schemas,tools,preview}.ts`,
  `src/hooks/useChat.ts`, `src/components/sidebar/ChatSidebar.tsx`, `src/lib/api.ts`,
  `src/lib/db/database.types.ts` (hand-written block only), `src/lib/db/types.ts`, their tests.
- Append-only, at a named anchor: `api/_lib/app.ts` — one line directly after the
  `/coach-conversations` route; `api/_lib/handlers/account.ts` — `'coach_memory'` directly after
  `'coach_messages'` in `USER_DATA_TABLES`. Lane C03 appends at different anchors in the same
  two files; touch nothing else in them.
- Not yours: `evals/**`, `src/components/calendar/**`, `src/components/blocks/**`, doctrine,
  physiology, `api/_lib/mcp/**`, `models.ts`.

## Table
```
coach_memory(
  id uuid pk default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('injury','preference','goal','history','note')),
  content text not null check (length(content) between 1 and 500),
  confidence real,                       -- null for user-confirmed facts; set by reflection (D01)
  source_kind text,                      -- 'chat' | 'reflection' | 'user'
  source_id uuid,                        -- conversation id / review id
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,              -- null = proposed, not yet in the prompt
  superseded_by uuid references coach_memory(id),
  archived_at timestamptz
)
index (user_id, kind) where confirmed_at is not null and archived_at is null
```
Only rows with `confirmed_at not null and archived_at is null and superseded_by is null` render
anywhere the model can see. In chat, a confirmed write sets `confirmed_at = now()` in the same
statement (the click is the confirmation).

## Steps
1. Migration + hand-written types + row type.
2. `api/_lib/coach/memory.ts`: `listConfirmed(supabase, userId)`, `renderMemoryFile(kind, rows)`,
   `viewPath(supabase, userId, path)` → text or an error string, `applyMemoryCommand(supabase,
   userId, input)` for the write commands (create appends one row per non-empty line; str_replace
   supersedes the matched row with a new one; delete archives; insert = create at kind; rename
   is refused with a clear message). Cap: 200 confirmed rows per user, 60 rendered in the prompt
   (newest per kind first), say so in the tool result when capped.
3. Tool: add `memory` to the chat tool list (after `read_doctrine`, fixed order) and a
   `CoachToolDef` for its write commands so `coachTool.ts` executes a confirmed one; the
   `displayLabel` is "Remember: <first line>" / "Forget: …" / "Update memory: …"; the A04 preview
   shows the lines to be added or the before/after text.
4. Loop: `runServerSideTool` handles `memory` + `view` via `viewPath`; `serverSideToolLabel`
   → "Checked: memory (injuries)". Mixed rounds and held results already work by shape.
5. Prompt: `<athlete_memory>` in the volatile half from `listConfirmed`, grouped by kind, and
   the stable rule line. `buildChatContext` fetches memories in the same `Promise.all` as
   physiology, degrading to none.
6. Handler `/api/coach-memory`: `GET` list (all non-archived, with confirmed flag), `POST { id }`
   confirm a proposed row, `POST { kind, content }` add one directly (user-authored,
   `source_kind: 'user'`, confirmed), `DELETE { id }` archive. Client helpers in `src/lib/api.ts`.
7. Sidebar: nothing new beyond the confirm card working for memory writes; the notebook UI is
   lane D02. Keep `ChatSidebar.tsx` edits to what the card needs.
8. Tests: memory backend (render, view, apply, caps, supersede) with a stubbed Supabase;
   chat.test — a `memory view` round runs server-side, a `memory create` surfaces a confirm card
   with the label; prompt tests — `<athlete_memory>` in the volatile half only, stable half
   byte-identical; tools test — the predicate with and without input; handler test.
9. README coach section: one paragraph.

## NOT VERIFIED to carry forward
Live model behaviour with the memory tool; the migration applied to a real stack;
`database.types.ts` drift; `coach-gate` red until Shane's `eval:gate`.
