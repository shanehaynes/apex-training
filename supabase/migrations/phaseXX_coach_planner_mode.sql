-- Phase XX: the coach's planner mode joins the closed `mode` sets.
--
-- WHY THIS EXISTS
-- api/_lib/coach/context.ts gains a fourth ChatMode, 'planner' (decision
-- D-C07): the coach drafts training blocks that the athlete applies. Every
-- turn of it records a coach_runs row (phase45) and its threads are stored in
-- coach_conversations (phase46), and both tables constrain `mode` to the
-- three values that existed when they were written — deliberately, so a typo
-- could never split a metric or strand a thread. This widens both CHECKs by
-- exactly the one new value. Nothing else changes: no column, no index, no
-- RLS. The generated types do not move either — the generator emits `mode:
-- string` for a CHECK, not an enum — so database.types.ts and
-- DatabaseTypes.swift are untouched by design.
--
-- Postgres named the inline `check (mode in (...))` constraints
-- `<table>_mode_check`; both are dropped by that name and re-added with the
-- same name, so a second run of this file is a no-op (`if exists`) and the
-- prod schema check keeps finding one constraint of that name per table.

alter table public.coach_runs
  drop constraint if exists coach_runs_mode_check;
alter table public.coach_runs
  add constraint coach_runs_mode_check
  check (mode in ('chat','builder','analytics','planner'));

alter table public.coach_conversations
  drop constraint if exists coach_conversations_mode_check;
alter table public.coach_conversations
  add constraint coach_conversations_mode_check
  check (mode in ('chat','builder','analytics','planner'));
