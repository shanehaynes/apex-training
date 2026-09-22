-- Phase 45: coach_runs.
--
-- WHY THIS EXISTS
-- Every coach turn already measures itself and then throws the measurement
-- away. api/chat.ts ends with `console.log('[api/chat] usage', { model,
-- client, withTools, input, cacheRead, cacheWrite, output })` — the four token
-- counts that decide what a conversation costs, the model that produced them,
-- and the build that asked. On Vercel that line lives in a function log with a
-- retention window and no way to group by user, model or prompt version, so
-- none of the questions worth asking can be answered: which model is being
-- used, whether the system-prompt cache is being hit, what a turn costs, which
-- prompt version a regression belongs to, how often a run ends in an error.
-- The comment at api/chat.ts:80 about gating a change "on the usage numbers
-- logged at the end of the handler" is a plan that no stored data supports.
--
-- This table is that data: one row per coach turn, written by the API after
-- the stream closes. It holds counts, timings, identifiers and an error
-- message. It holds NO prompt text, NO message content and NO key material —
-- which is what keeps it inside legal/privacy-v1.md as written, and what makes
-- it safe to keep indefinitely. Keep it that way when columns are added.
--
-- ORDER: run this migration FIRST, deploy the code SECOND. The insert lands in
-- a later PR; against a database without this table it would be PGRST205 on
-- every coach turn. The helper that writes the row is fail-open (it logs and
-- returns, never throws), so a reversed order degrades to today's behaviour
-- rather than 500ing the chat — but "the safety net holds" is not a reason to
-- lean on it, and production is applied by hand.
--
-- GRANTS: phase44's header says new tables "ARRIVE WITH NO GRANTS AT ALL".
-- Not quite: its `revoke all on all tables` was a one-time snapshot, and the
-- stack's default privileges still hand `anon` and `authenticated` REFERENCES,
-- TRIGGER and TRUNCATE on every table created afterwards (CI caught exactly
-- that on this table's first run). So every migration that creates a table
-- revokes from both roles explicitly, then grants service_role the same four
-- verbs phase44 grants. `authenticated` and `anon` end with nothing: the web
-- and iOS clients never read it, it is not in the realtime publication, and
-- RLS is on with no policies — the user_api_keys / mcp_tokens /
-- terms_acceptances precedent. That combination is what
-- api/__tests__/integration/rls-coverage.integration.test.ts asserts.

create table if not exists coach_runs (
  id                 uuid        primary key default gen_random_uuid(),
  -- Cascades, so a deleted account takes its run history with it. The table
  -- is also listed in USER_DATA_TABLES (api/_lib/handlers/account.ts), which
  -- puts it in the export as well as the sweep.
  user_id            uuid        not null references auth.users (id) on delete cascade,
  -- An id minted per request by the writer and also logged, so a row can be
  -- lined up with whatever the function log still holds. Nothing stamps one
  -- today; the PR that writes the row is where it starts existing.
  request_id         text        not null,
  -- Which surface asked: exactly the ChatMode union in
  -- api/_lib/coach/context.ts:30. Constrained rather than free text because
  -- the set is closed and a typo would silently split a metric in two.
  mode               text        not null check (mode in ('chat','builder','analytics')),
  -- The resolved model id (src/lib/coach/model.ts), not the client's request.
  model              text        not null,
  -- The system-prompt version in force for this turn. Deliberately TEXT with
  -- no constraint, for the reason terms_acceptances gives: the set grows in
  -- the repo and a CHECK here would need migrating in lockstep.
  prompt_version     text        not null,
  -- clientTag(req) ?? 'web' — which build produced the traffic. Nullable
  -- because it is best-effort: an old client sends no version header.
  client             text,
  with_tools         boolean     not null,
  -- The four numbers from the Anthropic usage object. cache_read vs
  -- cache_write is the pair that says whether prompt caching is working at
  -- all; input/output is the pair that says what the turn cost. Defaulted so
  -- a partial write is a row with zeros rather than no row.
  input_tokens       integer     not null default 0,
  cache_read_tokens  integer     not null default 0,
  cache_write_tokens integer     not null default 0,
  output_tokens      integer     not null default 0,
  tool_use_count     integer     not null default 0,
  -- Nullable: a turn the client aborted has neither.
  stop_reason        text,
  latency_ms         integer,
  -- An error message only — never a key, never prompt text, never a stack.
  error              text,
  created_at         timestamptz not null default now()
);

-- Every read of this table is "this user's recent runs" (an account export,
-- a per-user cost question), so that is the index it gets.
create index if not exists idx_coach_runs_user_created on coach_runs (user_id, created_at desc);

-- RLS on with deliberately no policies: anon and authenticated read zero rows
-- in every mode. service_role bypasses RLS and is the only thing that touches
-- this table.
alter table coach_runs enable row level security;

-- Default privileges gave anon/authenticated REFERENCES, TRIGGER, TRUNCATE
-- the moment the table was created; take them back before granting anyone.
revoke all on table public.coach_runs from anon, authenticated;
grant select, insert, update, delete on table public.coach_runs to service_role;

notify pgrst, 'reload schema';
