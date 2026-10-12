-- Phase 54: workout_exercise_notes.
--
-- WHY THIS EXISTS
-- A note typed against one exercise mid-workout — "left shoulder pinchy on
-- the last set", "used the blue band" — belongs to that day only. The plan
-- entry's `notes` can't hold it: in a recurring series every occurrence
-- shares the base event's exercise list, so writing there would put today's
-- note on every future Tuesday (and on the library template it came from).
-- The library definition's technique_notes are the cross-workout layer; this
-- is the single-occurrence one.
--
-- KEYS
-- (event_id, event_date) is the tracker session key, the pair
-- workout_sessions and the set-log tables use; (section, exercise_id) is the
-- plan entry, which is what log rows key on too, so a swapped exercise keeps
-- its note. One row per exercise per occurrence: an upsert replaces it, and
-- an emptied note deletes it.
--
-- WHO WRITES
-- /api/workout-sessions `exercise-note`; `cancel` deletes the session's rows
-- with its logs. `bootstrap` reads them into the tracker model.
--
-- GRANTS: the live_activity_tokens (phase52) / coach_annotations (phase49)
-- posture — RLS on with no policies, service_role the only door, every query
-- scoped by user_id, not in the realtime publication.

create table if not exists workout_exercise_notes (
  -- Cascades, so a deleted account takes its notes with it. Also listed in
  -- USER_DATA_TABLES (api/_lib/handlers/account.ts) for export and the sweep.
  user_id      uuid        not null references auth.users (id) on delete cascade,
  event_id     text        not null,
  event_date   date        not null,
  section      text        not null check (section in ('warmup','exercise','cooldown')),
  exercise_id  text        not null,
  note         text        not null check (char_length(note) between 1 and 2000),
  updated_at   timestamptz not null default now(),
  primary key (user_id, event_id, event_date, section, exercise_id)
);

alter table workout_exercise_notes enable row level security;

revoke all on table public.workout_exercise_notes from anon, authenticated;
grant select, insert, update, delete on table public.workout_exercise_notes to service_role;

notify pgrst, 'reload schema';
