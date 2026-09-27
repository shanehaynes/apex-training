-- Phase XX: coach_memory — what the athlete has confirmed the coach may remember.
--
-- WHY THIS EXISTS
-- The coach forgets everything between conversations. The athlete profile
-- (profiles.coach_goal / coach_context) is two free-text fields the user
-- edits by hand, and a thread (phase46) is one conversation's history — so
-- "my left shoulder is out until the physio clears it", said on Tuesday,
-- does not reach Thursday's programming unless the athlete says it again.
-- This table holds short, TYPED facts: one row per fact, one of five kinds
-- (injury · preference · goal · history · note), 1–500 characters. The model
-- reads them through Anthropic's memory tool as five virtual files under
-- /memories (one per kind — a file is a view over rows, never a stored blob;
-- api/_lib/coach/memory.ts renders it), the confirmed set is rendered into
-- the live half of the chat prompt, and /api/coach-memory lists, confirms
-- and archives them.
--
-- NOTHING IS REMEMBERED WITHOUT THE ATHLETE'S CLICK (decision D-C03). The
-- model can only PROPOSE: in chat every memory write is a confirm card, and
-- the row is inserted with confirmed_at = now() by the click itself. A row
-- with confirmed_at NULL is a proposal that has not been accepted (reflection,
-- lane D01, writes those) and renders nowhere the model can see.
--
-- WHAT RENDERS: confirmed_at not null AND archived_at null AND superseded_by
-- null — the current confirmed set. An edit never rewrites a row: str_replace
-- inserts the new fact and points the old row's superseded_by at it; delete
-- sets archived_at. History stays, and the prompt shows one line per fact.
--
-- GRANTS: the phase45/phase46 trap still applies. The stack's default
-- privileges hand `anon` and `authenticated` REFERENCES, TRIGGER and TRUNCATE
-- on every table created after phase44's snapshot, and
-- api/__tests__/integration/rls-coverage.integration.test.ts fails on
-- exactly that. So revoke from both roles explicitly, then grant
-- service_role the four verbs. RLS is on with no policies: anon and
-- authenticated read zero rows in every mode, the table is not in the
-- realtime publication, and the API (service_role, scoped by user_id on every
-- query) is the only door. The coach_conversations posture.

create table if not exists coach_memory (
  id            uuid        primary key default gen_random_uuid(),
  -- Cascades, so a deleted account takes its memories with it. Also listed
  -- in USER_DATA_TABLES (api/_lib/handlers/account.ts), which puts it in the
  -- export as well as the sweep.
  user_id       uuid        not null references auth.users (id) on delete cascade,
  -- Exactly MEMORY_KINDS in src/lib/coach/memory.ts, and the five files the
  -- model sees under /memories. Constrained because the set is closed and a
  -- typo would file a fact where no view lists it.
  kind          text        not null check (kind in ('injury','preference','goal','history','note')),
  -- One fact, one line. The bound matches MEMORY_CONTENT_MAX; the prompt
  -- renderer sanitizes on the way out, the row keeps what was confirmed.
  content       text        not null check (length(content) between 1 and 500),
  -- NULL for a fact the athlete confirmed; set by reflection (D01) on a
  -- proposal it inferred, so a later reader can weigh it.
  confidence    real,
  -- 'chat' (proposed by the coach in a conversation, confirmed by the click),
  -- 'reflection' (proposed by the nightly reflection), 'user' (typed into
  -- the notebook directly). Free text rather than a CHECK: the set will grow
  -- with the lanes that write here.
  source_kind   text,
  -- The conversation or review the fact came out of, when there is one.
  source_id     uuid,
  created_at    timestamptz not null default now(),
  -- NULL = proposed, not yet in the prompt. In chat the confirming click sets
  -- it in the same insert; a reflection row waits for /api/coach-memory POST { id }.
  confirmed_at  timestamptz,
  -- The row that replaced this one (str_replace). Set once, never cleared:
  -- the old fact stays readable as history and stops rendering.
  superseded_by uuid        references coach_memory (id),
  -- Forgotten: a delete, or the notebook's archive. Never a hard delete.
  archived_at   timestamptz
);

-- The prompt's query and every `view`: this user's current confirmed facts,
-- by kind. Partial, so proposed, superseded and archived rows cost nothing.
create index if not exists idx_coach_memory_user_kind_live
  on coach_memory (user_id, kind)
  where confirmed_at is not null and archived_at is null;

alter table coach_memory enable row level security;

-- Default privileges gave anon/authenticated REFERENCES, TRIGGER, TRUNCATE
-- the moment this table was created; take them back before granting anyone.
revoke all on table public.coach_memory from anon, authenticated;
grant select, insert, update, delete on table public.coach_memory to service_role;

notify pgrst, 'reload schema';
