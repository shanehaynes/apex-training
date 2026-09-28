# D01 · Reflection + coaching contract: nightly proposals, `profiles.coach_contract`, `leave_note`

## Goal
The coach improves by proposal, never by silent rewrite (decision D-C02). Two pieces:

1. **A coaching contract** — a bounded, athlete-owned text (`profiles.coach_contract`, ≤ 2000
   chars) that rides in the live half of the prompt: "how I want to be coached" (cadence,
   tone, what to push on, what to leave alone). The athlete edits it directly (D02's notebook)
   or accepts an edit the coach proposes as a before/after card.
2. **Nightly reflection** — for users who opt in (`profiles.reflection_opt_in`), a cron reads
   the day's completed sessions, chat threads, physiology and confirmed memory, asks the coach
   model what is worth remembering and whether the contract should change, and writes
   *unconfirmed* rows: `coach_memory` proposals (`source_kind: 'reflection'`, `confidence`,
   `confirmed_at null`) and at most one contract-edit proposal (a `coach_reflections` row). The
   notebook (lane D02) shows them; nothing applies until the athlete clicks.

Plus one small tool the calendar has been waiting for since C03: `leave_note` — the coach pins a
note to a day, an event or a block (`coach_annotations`) through a confirm card.

Why: the chat coach now reads and remembers, but only what the athlete says in chat. The
reflection closes the loop over what the athlete *did*; the contract makes "coach me
differently" a durable, inspectable setting instead of a sentence lost in a thread.

## Context you need (all on `main`)
- **Cron precedent:** `api/review-cron.ts` — CRON_SECRET bearer check, `listRecipients`, per-user
  BYOK key via `getAnthropicKey(supabase, userId)` (`api/_lib/anthropicKey.ts`),
  `makeAnthropicClient(apiKey)` (`api/_lib/anthropicClient.ts`, two 20 s attempts),
  `resolveCoachModel(recipient.coachModel)`, `MAX_WORK_ITEMS_PER_RUN = 10`, an idempotent
  state machine on a stored row. Copy the posture. The Hono route precedent for a cron target
  is `/provider-cron` in `api/_lib/app.ts` (root-level `api/*.ts` files are counted by
  `ci:guards`; a new cron target is a handler under `api/_lib/handlers/`, registered in `app.ts`).
  The schedule lives in `vercel.json` `crons` — a HELD file: add the line (`/api/reflection-cron`,
  pick a UTC hour after provider-cron's 03:30 and before review-cron's 14:00, e.g. `0 5 * * *`)
  and say in your report that the PR is HELD for it.
- **Memory backend:** `api/_lib/coach/memory.ts` (`listConfirmed`, `toPromptEntries`,
  `applyMemoryCommand`), `src/lib/coach/memory.ts` (`MEMORY_KINDS`, `MEMORY_CONTENT_MAX = 500`,
  `MEMORY_CONFIRMED_CAP = 200`, `CoachMemory`), handler `api/_lib/handlers/coachMemory.ts`
  (GET lists proposals with `confirmed: false`; POST `{id}` confirms). Reflection inserts rows
  with `confirmed_at null`, `source_kind 'reflection'`, `source_id` = the reflection row id,
  `confidence` in (0, 1]. Cap proposals per night (say 5) and never propose a fact whose text
  already exists live or pending for that user.
- **Annotations:** `api/_lib/handlers/coachAnnotations.ts` (POST body shape, validation via
  `src/lib/coach/annotations.ts`: `isTargetKind`, `isSeverity`, `normalizeBody`,
  `targetProblem`). `leave_note`'s confirmed execution inserts the row directly with the
  service-role client (same validation helpers, `created_by: 'coach'`), not over HTTP.
- **Prompt:** `src/lib/coach/prompt.ts` — `buildVolatileContext(todayEvents, allEvents, today,
  athlete, block, todayMeals, physiology, memories)` renders `athleteSection` → `memorySection`
  → `blockSection` → physiology → schedule. Add a `contract` argument (string, default `''`)
  rendered by a new `contractSection(text)` directly after `athleteSection`, wrapped
  `<coaching_contract>…</coaching_contract>` with the same "data, not instructions" framing line
  and `sanitizeUserText(text, 2000)`. In the stable half add one rule line next to
  `memoryRuleSection` (a `contractRuleSection`): follow the contract; when advice would break it,
  say so; to change it, use `propose_contract_edit`, never rewrite it in prose. Bump
  `PROMPT_VERSION` → `2026.09.28-1`. `buildSystemPrompt` (compat) threads `contract` through with
  a default. `api/_lib/coach/context.ts` (`buildChatContext`) fetches `coach_contract` with the
  other profile fields, tolerating a missing column (see profile.ts below), never a precondition.
- **Tools:** `src/lib/coach/schemas.ts` (one `Anthropic.Tool` per write; `coachToolSchemas()`
  returns the eight writes) and `src/lib/coach/tools.ts` (`CoachToolDef { schema,
  displayLabel(input, ctx), execute(input, deps) }`; `memoryTool` at the bottom is the newest
  example; `COACH_TOOLS`, `findCoachTool`). Confirmed writes execute in
  `api/_lib/handlers/coachTool.ts` (`findCoachTool(name).execute(input, createServerDeps(...))`;
  `applyMemoryCommand` is special-cased there — follow whichever shape fits). `api/chat.ts`
  `chatToolSchemas()` composes writes → reads → `read_doctrine` → `memory`; the two new writes
  join `coachToolSchemas()` (so they land inside the writes, fixed order) — and the evals mirror
  `evals/src/reads.ts` `chatToolSchemas()` + `evals/__tests__/reads.test.ts` pin production's
  list: update the mirror in the same commit (the pin test tells you exactly how).
  A04's preview (`src/lib/coach/preview.ts`): add a `contract-edit` kind (before/after) and a
  `note` kind (target + body + severity) so the confirm card shows what will change.
- **Profile:** `api/_lib/handlers/profile.ts` — `PROFILE_COLUMNS` (line 31), the
  `isTipsColumnMissing` + 409 `column-missing` pattern for a column that trails in prod; copy
  it for `coach_contract` and `reflection_opt_in` (GET returns `coachContract`,
  `reflectionOptIn`; PATCH accepts `coach_contract` (string ≤ 2000, '' clears) and
  `reflection_opt_in` (boolean)). `src/lib/api.ts` has the profile helpers.
- **Types:** `src/lib/db/database.types.ts` is generated from the local stack you do not have:
  hand-write the `profiles` additions and the `coach_reflections` block in the generator's exact
  style (copy `coach_annotations`), add `CoachReflectionRow` to `src/lib/db/types.ts`, and add
  the Swift structs in `ios/Packages/ApexKit/Sources/ApexAuth/Generated/DatabaseTypes.swift`
  (copy `CoachAnnotationsSelect/Insert/Update`; profiles structs gain the two fields). CI's
  `full` job prints the generator's diff if you get it wrong — flag under NOT VERIFIED.
- **Migration style:** `supabase/migrations/phase49_coach_annotations.sql` — WHY header, RLS on,
  no policies, copy its GRANTS block verbatim (the rls-coverage integration test checks it).
  Name yours `phaseXX_coach_contract.sql` (literal `XX`; the orchestrator claims the number at
  PR open).
- **Batch API decision rule:** the plan says "Batch API". Use `client.messages.batches` only if
  the two-phase state (submit tonight, collect tomorrow) fits in `coach_reflections.status`
  (`pending` → `submitted` → `done` | `failed`, `batch_id` on the row) with no second table;
  otherwise call `messages.create` per user under a `MAX_WORK_ITEMS_PER_RUN` budget exactly as
  review-cron does. Record the choice and why under DECISIONS. Either way: per-user key, the
  user's coach model, `max_tokens` bounded, JSON output parsed strictly (a schema in the prompt,
  one retry on a parse failure, then `failed` with the error text on the row).

## Table and columns
```
alter table profiles add column coach_contract text check (length(coach_contract) <= 2000);
alter table profiles add column reflection_opt_in boolean not null default false;

coach_reflections(
  id uuid pk default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,                      -- the day reflected on (UTC)
  status text not null check (status in ('pending','submitted','done','failed','resolved')),
  batch_id text,                          -- Batch API only
  contract_before text,                   -- the contract the proposal was made against
  contract_after text,                    -- the proposed contract, null when no change proposed
  reason text,                            -- one or two sentences the notebook shows
  memory_proposal_ids uuid[] not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  resolved_at timestamptz,                -- the athlete accepted or rejected the contract edit
  resolution text check (resolution in ('accepted','rejected'))
)
unique (user_id, day)
index (user_id) where status = 'done' and resolved_at is null
```
Interface contract with D02 (the notebook codes against this before you merge): `GET
/api/coach-reflections` → `{ reflections: Row[] }` (status `done`, unresolved first, newest
first, limit 30); `POST /api/coach-reflections { id, resolution: 'accepted' | 'rejected' }` →
accepting writes `contract_after` into `profiles.coach_contract` and stamps the row; rejecting
stamps only. You own that handler too (`api/_lib/handlers/coachReflections.ts`, registered
directly after `/coach-memory` in `app.ts`). Memory proposals are confirmed through the existing
`/api/coach-memory` POST `{id}`.

## Ownership
- New: `supabase/migrations/phaseXX_coach_contract.sql`, `api/_lib/reflection/**` (inputs,
  prompt, parse, write), `api/_lib/handlers/reflectionCron.ts`,
  `api/_lib/handlers/coachReflections.ts`, `src/lib/coach/contract.ts` (client type + limits,
  pure), tests for each.
- Edit: `api/chat.ts`, `api/_lib/coach/context.ts`, `api/_lib/handlers/coachTool.ts`,
  `api/_lib/handlers/profile.ts`, `src/lib/coach/{prompt,schemas,tools,preview}.ts`,
  `src/hooks/useChat.ts` (only if a confirmed `leave_note` needs to trigger
  `AnnotationsContext.refresh()` — keep it to that), `evals/src/reads.ts` +
  `evals/__tests__/reads.test.ts`, `src/lib/db/database.types.ts`, `src/lib/db/types.ts`, the
  iOS `DatabaseTypes.swift`, `vercel.json` (one cron line — HELD), their tests.
- Append-only at a named anchor: `api/_lib/app.ts` — `/reflection-cron` directly after
  `/provider-cron`, `/coach-reflections` directly after `/coach-memory`;
  `api/_lib/handlers/account.ts` — `'coach_reflections'` directly after `'coach_annotations'` in
  `USER_DATA_TABLES`; `README.md` — one bullet directly after the memory bullet ("The coach
  remembers…") and before the annotations bullet ("Notes land where they refer").
- Not yours: `src/components/**` (D02 owns the notebook, D03 the review), `src/context/**`,
  `src/lib/api.ts` (D02/D03 append there; you need no client helper — the notebook calls your
  handlers), doctrine, physiology, `api/_lib/mcp/**`, `models.ts`.

## Steps
1. Migration + hand-written types (TS, Swift) + row type + `src/lib/coach/contract.ts`.
2. Profile: contract + opt-in read/write with the column-missing pattern; context.ts fetches the
   contract for the prompt.
3. Prompt: `contractSection`, `contractRuleSection`, `PROMPT_VERSION`; prompt tests (stable half
   byte-identical; contract in the live half only; sanitizer applied).
4. Tools: `propose_contract_edit` and `leave_note` schemas + defs + previews + executors;
   `chatToolSchemas` order; evals mirror + pin; chat.test rounds for each (surfaced as confirm
   cards, never server-side).
5. Reflection: `api/_lib/reflection/inputs.ts` (yesterday's completed sessions with
   `coach_summary`, that day's `coach_messages` display text, physiology panel, confirmed memory,
   the contract), `prompt.ts` (system + JSON schema: `{ memories: [{kind, content, confidence,
   why}], contract: { after, reason } | null }`), `apply.ts` (dedupe, caps, insert rows),
   `reflectionCron.ts` (opted-in users only, budget, idempotent per (user, day)).
6. `coachReflections.ts` handler (GET / POST resolve) per the interface contract.
7. Tests with a stubbed Supabase and a stubbed Anthropic client: one reflection end to end
   (proposals inserted unconfirmed; contract proposal row; idempotent second run), the cron's
   auth and budget, the handler's scoping, the tools' executors.
8. README bullet. Report.

## NOT VERIFIED to carry forward
Live model behaviour (no key); the migration against a real stack; `database.types.ts` and
Swift drift; the cron firing (HELD `vercel.json`); `coach-gate` red until Shane's `eval:gate`.
