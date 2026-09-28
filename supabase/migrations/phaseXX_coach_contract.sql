-- Phase XX: the coaching contract and nightly reflection.
--
-- WHY THIS EXISTS
-- The chat coach reads and remembers, but only what the athlete says in chat,
-- and "coach me differently" is a sentence lost in a thread. Two additions
-- close that loop (decision D-C02: the coach improves by proposal, never by
-- silent rewrite):
--
--   profiles.coach_contract   A bounded, athlete-owned text — "how I want
--                             to be coached" (cadence, tone, what to push on,
--                             what to leave alone) — rendered into the live
--                             half of the chat prompt as <coaching_contract>.
--                             The athlete edits it directly, or accepts an
--                             edit the coach proposes (the chat tool
--                             propose_contract_edit, or a nightly reflection)
--                             as a before/after card. Nothing else writes it.
--   profiles.reflection_opt_in
--                             Whether the nightly reflection cron reads this
--                             athlete's day at all. Off by default: a model
--                             call on the athlete's own key every night is
--                             theirs to switch on.
--   coach_reflections         One row per (user, day) the cron reflected on.
--                             The row is the idempotency marker (the unique
--                             key stops a second run from proposing twice),
--                             the state machine (status), the contract edit
--                             the reflection proposed (contract_before /
--                             contract_after / reason), and the list of
--                             coach_memory proposals it inserted
--                             (memory_proposal_ids, each with confirmed_at
--                             null, source_kind 'reflection', source_id =
--                             this row). The notebook shows the row; nothing
--                             applies until the athlete clicks.
--
-- STATUS
--   pending    inserted before the model call; a run that dies here is
--              resumed by the next one.
--   submitted  reserved for the Batch API (batch_id set, results collected
--              later). Unused today: the cron calls messages.create per
--              user under a per-run budget, as review-cron does.
--   done       the model answered and the proposals are written.
--   failed     the model call or its JSON failed twice; `error` says why.
--   resolved   reserved; resolution today is resolved_at + resolution on a
--              done row, so the notebook's "done, unresolved" query is one
--              partial index.
--
-- resolved_at is "nothing further from the athlete on this row": stamped by
-- the accept/reject POST when a contract edit was proposed, and stamped at
-- write time when none was (a done row with contract_after null has nothing
-- to decide — its memory proposals are confirmed one by one through
-- /api/coach-memory). resolution is null in that second case.
--
-- ORDER: migration FIRST, code SECOND. Every reader tolerates the columns'
-- absence (the profile handler's column-missing pattern; the chat prompt
-- drops the section; the cron finds no opted-in users), so a reversed order
-- degrades to today's coach rather than breaking it.
--
-- GRANTS: phase45 and phase46 record the trap, and it still applies. The
-- stack's default privileges hand `anon` and `authenticated` REFERENCES,
-- TRIGGER and TRUNCATE on every table created after phase44's one-time
-- snapshot, and api/__tests__/integration/rls-coverage.integration.test.ts
-- fails on exactly that. So revoke from both roles explicitly, then grant
-- service_role the same four verbs. RLS is on with no policies: anon and
-- authenticated read zero rows in every mode, the table is not in the
-- realtime publication, and the API (service_role, scoped by user_id on
-- every query) is the only door. The coach_conversations posture.

alter table profiles add column if not exists coach_contract text
  check (length(coach_contract) <= 2000);
alter table profiles add column if not exists reflection_opt_in boolean not null default false;

create table if not exists coach_reflections (
  id                  uuid        primary key default gen_random_uuid(),
  -- Cascades, so a deleted account takes its reflections with it. Also
  -- listed in USER_DATA_TABLES (api/_lib/handlers/account.ts), which puts it
  -- in the export as well as the sweep.
  user_id             uuid        not null references auth.users (id) on delete cascade,
  -- The day reflected on (UTC): yesterday, as the cron sees it.
  day                 date        not null,
  status              text        not null check (status in ('pending','submitted','done','failed','resolved')),
  -- Batch API only; null on the messages.create path.
  batch_id            text,
  -- The contract the proposal was made against, so a stale proposal can be
  -- told from a current one.
  contract_before     text,
  -- The proposed contract; null when no change was proposed.
  contract_after      text,
  -- One or two sentences the notebook shows beside the before/after.
  reason              text,
  memory_proposal_ids uuid[]      not null default '{}',
  error               text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  -- The athlete accepted or rejected the contract edit — or there was none.
  resolved_at         timestamptz,
  resolution          text        check (resolution in ('accepted','rejected')),
  unique (user_id, day)
);

-- The notebook's read: this user's finished reflections still waiting on a
-- click. Partial so the resolved history costs the index nothing.
create index if not exists idx_coach_reflections_unresolved
  on coach_reflections (user_id)
  where status = 'done' and resolved_at is null;

alter table coach_reflections enable row level security;

-- Default privileges gave anon/authenticated REFERENCES, TRIGGER, TRUNCATE
-- the moment this table was created; take them back before granting anyone.
revoke all on table public.coach_reflections from anon, authenticated;
grant select, insert, update, delete on table public.coach_reflections to service_role;

notify pgrst, 'reload schema';
