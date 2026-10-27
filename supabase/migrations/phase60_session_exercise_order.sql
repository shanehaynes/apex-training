-- Phase 60: the order a workout's exercises were done in, per session.
--
-- WHY THIS EXISTS
-- Mid-workout the athlete reorders exercises in the tracker ("the squat rack
-- is free, do back squat first"). That order belongs to this sitting only:
-- the plan is often a recurring series, and moving back squat up today must
-- not move it up on every Friday. So the order lives on the session row, not
-- on the event.
--
-- `exercise_order` maps a tracker section to the entry ids in the order the
-- athlete arranged them: {"warmup": [...], "exercises": [...], "cooldown":
-- [...]}. A section left out, or an id it does not name, keeps the plan's
-- order (lib/tracking/order.ts). null = never reordered, which is exactly
-- today's behaviour, so the column is safe to apply ahead of or behind the
-- code. The handler bounds the shape and size; the check here only refuses a
-- non-object.
--
-- RLS: workout_sessions already carries own-row policies with table-level
-- grants; a new column needs no policy or grant work.

alter table workout_sessions add column if not exists exercise_order jsonb null;
alter table workout_sessions drop constraint if exists workout_sessions_exercise_order_check;
alter table workout_sessions add constraint workout_sessions_exercise_order_check
  check (exercise_order is null or jsonb_typeof(exercise_order) = 'object');
comment on column workout_sessions.exercise_order is 'Per-section entry ids in the order the athlete arranged them in the tracker; null = the plan''s order';

notify pgrst, 'reload schema';

insert into public.migration_ledger (name, fingerprint) values ('phase60_session_exercise_order', '2d0958401b4411e2') on conflict do nothing;
