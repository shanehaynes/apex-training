-- Phase 55: core-loop columns.
--
-- WHY THIS EXISTS
-- The core-loop work (weight units, per-set metadata, climbing ascents,
-- %1RM prescriptions) needs seven columns across three existing tables.
-- They land together, ahead of the code that writes them, so one applied
-- migration unblocks every lane and no later PR touches the generated
-- types. Every column is nullable or defaulted: the deployed code neither
-- reads nor writes any of them yet, and nothing here changes a row that
-- exists. Safe to re-run.
--
-- RLS: all three tables already carry own-row policies with table-level
-- grants (phase9 / phase44), so a new column needs no policy or grant work.

-- ------------------------------------------------------------
-- profiles: how the athlete enters and reads weights
-- ------------------------------------------------------------

-- The unit the tracker shows and parses by default. Stored values stay in
-- pounds (`*_lb`); this only decides the presentation and the bare-number
-- parse ("185" means 185 of these).
alter table profiles add column if not exists weight_unit text not null default 'lb';
alter table profiles drop constraint if exists profiles_weight_unit_check;
alter table profiles add constraint profiles_weight_unit_check check (weight_unit in ('lb', 'kg'));
comment on column profiles.weight_unit is 'display/parse unit for weights: lb or kg; stored weights are always lb';

-- Body weight in pounds, for "BW" and "BW+25" entries on weighted
-- bodyweight movements. null = never set, and those entries stay text.
alter table profiles add column if not exists body_weight_lb numeric null;
alter table profiles drop constraint if exists profiles_body_weight_lb_check;
alter table profiles add constraint profiles_body_weight_lb_check check (body_weight_lb > 0);
comment on column profiles.body_weight_lb is 'athlete body weight in lb, for bodyweight-relative set weights; null = unknown';

-- ------------------------------------------------------------
-- workout_set_logs: per-set metadata
-- ------------------------------------------------------------

-- Rate of perceived exertion, 1–10 (half points allowed: numeric, not int).
alter table workout_set_logs add column if not exists rpe numeric null;
alter table workout_set_logs drop constraint if exists workout_set_logs_rpe_check;
alter table workout_set_logs add constraint workout_set_logs_rpe_check check (rpe >= 1 and rpe <= 10);

-- A warm-up set is logged like any other but is not a performance: it is
-- excluded from PRs, last-performance shadows, tonnage and every other
-- stat, the same way is_autofilled zero-fills are. The tracker still
-- renders it in the session's own rows. Reads go through isPerformedSet()
-- in src/lib/tracking/records.ts; query builders that feed computation add
-- `is_warmup = false` beside `is_autofilled = false`.
alter table workout_set_logs add column if not exists is_warmup boolean not null default false;

-- Climbing: how the route went. The allowed strings are exactly the
-- AscentStyle union in src/types/workout.ts — change both or neither.
alter table workout_set_logs add column if not exists ascent_style text null;
alter table workout_set_logs drop constraint if exists workout_set_logs_ascent_style_check;
alter table workout_set_logs add constraint workout_set_logs_ascent_style_check
  check (ascent_style in ('flash', 'redpoint', 'follow', 'attempt'));

-- Climbing: attempts on the route before the logged result. null = not
-- tracked; 0 is meaningful (sent first go, with ascent_style saying how).
alter table workout_set_logs add column if not exists attempts integer null;
alter table workout_set_logs drop constraint if exists workout_set_logs_attempts_check;
alter table workout_set_logs add constraint workout_set_logs_attempts_check check (attempts >= 0);

-- ------------------------------------------------------------
-- workout_sessions: a note on the whole session
-- ------------------------------------------------------------

-- Free text for the session as a whole ("slept badly", "new gym"). The
-- per-exercise layer is workout_exercise_notes (phase54); this is the
-- one-per-session layer above it. No length check: the handler bounds it.
alter table workout_sessions add column if not exists note text null;

-- ------------------------------------------------------------
-- last_performed_by_name (phase31): a warm-up set is not a performance
-- ------------------------------------------------------------
-- The library's "last performed" column is a stat, so it now ignores
-- warm-up rows exactly as it ignores autofilled ones. Same signature and
-- body otherwise; CREATE OR REPLACE keeps the phase44 grants.
create or replace function last_performed_by_name(p_user_id uuid default null)
returns table (exercise_name text, event_date date)
language sql
stable
security invoker
set search_path = public
as $$
  with target as (select coalesce(p_user_id, auth.uid()) as uid)
  select l.exercise_name, max(l.event_date)
    from workout_set_logs l
   where l.user_id = (select uid from target) and l.is_autofilled = false and l.is_warmup = false
   group by l.exercise_name
  union all
  select c.exercise_name, max(c.event_date)
    from workout_cardio_logs c
   where c.user_id = (select uid from target) and c.is_autofilled = false
   group by c.exercise_name;
$$;

notify pgrst, 'reload schema';
