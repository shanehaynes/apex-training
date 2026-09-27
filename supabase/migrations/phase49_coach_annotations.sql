-- Phase XX: coach_annotations.
--
-- WHY THIS EXISTS
-- The coach's only surface is the chat window. A note it leaves there —
-- "deload this week, load ratio 1.4" — is worth more on the calendar week it
-- refers to than in a thread nobody reopens. This table is that note: one
-- row per remark, pinned to the thing it is about (a day, an event
-- occurrence or a training block), shown by the web client as a small chip
-- where that thing renders (src/components/calendar/AnnotationChip.tsx), and
-- dismissed by the athlete in place. Dismissal is a timestamp, not a delete,
-- so a later reflection pass can see what the coach said and whether it was
-- acted on.
--
-- WHO WRITES
-- /api/coach-annotations (api/_lib/handlers/coachAnnotations.ts) is the only
-- door. Today its POST stamps created_by = 'coach' unconditionally; the chat
-- tool that calls it (wave D, `leave_note`) lands after this table does. The
-- other two created_by values are reserved for the reflection pass and for a
-- note the athlete leaves themself, neither of which exists yet — the check
-- names them now so the column's vocabulary is a decision rather than an
-- accident.
--
-- TARGETS
-- target_id is text because the three kinds do not share an id shape: a day
-- is 'YYYY-MM-DD'; an event is the expanded occurrence id
-- (src/lib/schedule/occurrence.ts, `base__date` for a recurring instance,
-- the bare id otherwise); a block is its uuid. No foreign key on purpose —
-- an occurrence id names no row, and a note that outlives a deleted event
-- simply stops rendering (the client only asks for ids it is showing).
--
-- ORDER: migration FIRST, code SECOND. The client read is fail-open — a
-- failed fetch logs a console.warn and renders no chips — so a reversed
-- order degrades to today's calendar rather than breaking it.
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

create table if not exists coach_annotations (
  id           uuid        primary key default gen_random_uuid(),
  -- Cascades, so a deleted account takes its notes with it. Also listed in
  -- USER_DATA_TABLES (api/_lib/handlers/account.ts), which puts it in the
  -- export as well as the sweep.
  user_id      uuid        not null references auth.users (id) on delete cascade,
  target_kind  text        not null check (target_kind in ('day','event','block')),
  -- 'YYYY-MM-DD' for a day; the event occurrence id; the block uuid.
  target_id    text        not null,
  -- A chip, not an essay: the client shows the first ~40 characters and the
  -- rest on hover. 400 is room for a sentence of reasoning, not a briefing.
  body         text        not null check (length(body) between 1 and 400),
  -- Drives the chip colour. info: a remark. caution: something to watch.
  -- alert: something to act on before the session.
  severity     text        not null default 'info' check (severity in ('info','caution','alert')),
  created_by   text        not null default 'coach' check (created_by in ('coach','reflection','user')),
  created_at   timestamptz not null default now(),
  -- Set by the athlete's dismiss (DELETE on the API). A dismissed note is
  -- never shown again and never deleted: it is the record that the coach
  -- said something and the athlete saw it.
  dismissed_at timestamptz
);

-- The read query: this user's live notes for one target kind, narrowed to a
-- date range for days. Partial on dismissed_at so dismissed rows cost the
-- index nothing and the common read never touches them.
create index if not exists idx_coach_annotations_live_target
  on coach_annotations (user_id, target_kind, target_id)
  where dismissed_at is null;

alter table coach_annotations enable row level security;

-- Default privileges gave anon/authenticated REFERENCES, TRIGGER, TRUNCATE
-- the moment this table was created; take them back before granting anyone.
revoke all on table public.coach_annotations from anon, authenticated;
grant select, insert, update, delete on table public.coach_annotations to service_role;

notify pgrst, 'reload schema';
