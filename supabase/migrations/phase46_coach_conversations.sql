-- Phase 46: coach_conversations + coach_messages.
--
-- WHY THIS EXISTS
-- The web coach thread is React state and nothing else. src/hooks/useChat.ts
-- keeps two arrays — `messages` for display and `apiMessages` in the verbatim
-- Anthropic shape — and a refresh, a crashed tab or a second device loses
-- both. iOS already persists the same thread locally in GRDB
-- (ios/Packages/ApexKit/Sources/ApexPersistence/Database.swift), and D-013
-- shaped those tables like the server table that did not exist yet, so that
-- the eventual move would be a sync rather than a rewrite. These are that
-- server table: same column names, same nullability, same `kind` vocabulary.
--
-- WHAT THE TWO COLUMNS MEAN (D-025, proved in ChatSessionTests)
-- A stored message carries BOTH halves of a turn, and either half may be
-- absent:
--   api_content  — the verbatim Anthropic `content` (a string, or the block
--                  array carrying text/tool_use/tool_result). NULL on a
--                  display-only row: an error notice, a stopped partial.
--   display_text — what the thread renders. NULL on a hidden row: the
--                  synthetic "Give me my coaching briefing for today." prompt
--                  that triggerInitial sends but never shows.
-- `kind` (turn · notice · stopped) is how the thread renders a row whose
-- api_content is NULL without inferring it from the nulls themselves.
--
-- PRIVACY — READ BEFORE APPLYING THIS TO PRODUCTION
-- phase45 could say of coach_runs that it holds "NO prompt text, NO message
-- content", which is what kept it inside legal/privacy-v1.md as written.
-- This table is the opposite: api_content and display_text ARE the prompt and
-- the reply. legal/privacy-v1.md (lines ~50, 95, 148) currently tells the
-- user that prompt contents are not logged. That sentence and this table
-- cannot both be true, so this migration MUST NOT be applied to production
-- until the Privacy Policy has been updated to describe stored conversations
-- and their retention. That edit is Shane's, not this migration's. Local and
-- preview stacks are unaffected — they hold no real user's words.
--
-- ORDER: migration FIRST, code SECOND. The web writes are fail-open (a failed
-- save logs a console.warn and the thread continues in memory exactly as it
-- does today), so a reversed order degrades to today's behaviour rather than
-- breaking chat — but the safety net is not the plan.
--
-- GRANTS: phase45's header records the trap, and it still applies. The
-- stack's default privileges hand `anon` and `authenticated` REFERENCES,
-- TRIGGER and TRUNCATE on every table created after phase44's one-time
-- snapshot, and api/__tests__/integration/rls-coverage.integration.test.ts
-- fails on exactly that. So revoke from both roles explicitly, then grant
-- service_role the same four verbs. RLS is on with no policies: anon and
-- authenticated read zero rows in every mode, the tables are not in the
-- realtime publication, and /api/coach-conversations (service_role, scoped
-- by user_id on every query) is the only door. The user_api_keys /
-- mcp_tokens / coach_runs posture.

create table if not exists coach_conversations (
  id          uuid        primary key default gen_random_uuid(),
  -- Cascades, so a deleted account takes its conversations — and, through
  -- the second cascade below, every message in them — with it. Also listed
  -- in USER_DATA_TABLES (api/_lib/handlers/account.ts), which puts it in the
  -- export as well as the sweep.
  user_id     uuid        not null references auth.users (id) on delete cascade,
  -- Which coach surface owns the thread: exactly the ChatMode union in
  -- api/_lib/coach/context.ts and the UseChatOptions toolMode in
  -- src/hooks/useChat.ts. Constrained rather than free text because the set
  -- is closed and a typo would strand a thread where no surface lists it.
  mode        text        not null check (mode in ('chat','builder','analytics')),
  -- Nullable: a thread is created before it has been named, and nothing
  -- names one automatically yet.
  title       text,
  created_at  timestamptz not null default now(),
  -- Bumped by the API on every append. This is the list's sort key, not
  -- created_at: "my most recent thread" means the one I last spoke in.
  -- Maintained by the writer rather than a trigger — one writer, and a
  -- trigger would need its own grants to no benefit.
  updated_at  timestamptz not null default now()
);

create table if not exists coach_messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references coach_conversations (id) on delete cascade,
  -- Denormalized from the parent conversation on purpose, for two reasons
  -- that both outrank the duplication: every API query can scope itself with
  -- a plain .eq('user_id', userId) instead of a join the service-role client
  -- would have to get right every time, and api/__tests__/account.test.ts
  -- reads this line — any create table with a user_id must appear in
  -- USER_DATA_TABLES — so the export and the delete sweep cover the messages
  -- themselves rather than trusting the cascade to be enough.
  user_id         uuid        not null references auth.users (id) on delete cascade,
  role            text        not null check (role in ('user','assistant')),
  -- The verbatim Anthropic content: a string for a plain turn, or the block
  -- array (text / tool_use / tool_result) for everything else. jsonb rather
  -- than text because it is replayed into the next request unchanged and a
  -- malformed blob should fail on the way in, not on the way out. NULL on a
  -- display-only row (D-025).
  api_content     jsonb,
  -- What the UI renders. NULL on a hidden row — the synthetic briefing
  -- prompt is history the model needs and the user never asked for.
  display_text    text,
  -- turn: an ordinary message. notice: something the app said about the
  -- conversation (an error, a missing key). stopped: a partial the user
  -- aborted. Constrained for the same reason as mode, and defaulted so the
  -- common case does not have to say so.
  kind            text        not null default 'turn' check (kind in ('turn','notice','stopped')),
  created_at      timestamptz not null default now()
);

-- The list query: this user's threads for one surface, newest activity first.
create index if not exists idx_coach_conversations_user_recent
  on coach_conversations (user_id, mode, updated_at desc);

-- The load query: one thread's messages in the order they were spoken.
create index if not exists idx_coach_messages_conversation_order
  on coach_messages (conversation_id, created_at);

alter table coach_conversations enable row level security;
alter table coach_messages enable row level security;

-- Default privileges gave anon/authenticated REFERENCES, TRIGGER, TRUNCATE
-- the moment these tables were created; take them back before granting
-- anyone.
revoke all on table public.coach_conversations from anon, authenticated;
revoke all on table public.coach_messages from anon, authenticated;
grant select, insert, update, delete on table public.coach_conversations to service_role;
grant select, insert, update, delete on table public.coach_messages to service_role;

notify pgrst, 'reload schema';
