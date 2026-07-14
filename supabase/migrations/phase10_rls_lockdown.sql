-- ============================================================
-- APEX TRAINING — Phase 10 Migration: RLS lockdown
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- ONLY run this AFTER the authenticated deploy (auth gate + /api/* JWT
-- checks) is live and confirmed working. Running it first blanks the
-- calendar for the old anon-key client.
--
-- Two things happen here:
--   1. The temporary user_id DEFAULTs from phase9 are dropped — every
--      /api/* handler now stamps user_id explicitly from the verified JWT.
--   2. Every anon read-all policy is dropped. From here, an unauthenticated
--      client gets zero rows from every table; the per-user authenticated
--      policies from phase9 are the only read path.
-- ============================================================

-- 1) Drop the temporary write defaults
ALTER TABLE workout_events           ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE recurring_exceptions     ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE event_mutations_log      ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE workout_completions      ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE workout_completion_log   ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE workout_sessions         ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE workout_set_logs         ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE workout_cardio_logs      ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE exercise_definitions     ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE definition_mutations_log ALTER COLUMN user_id DROP DEFAULT;

-- 2) Drop every anon read-all policy (phase3, phase4, phase8)
DROP POLICY IF EXISTS anon_select_workout_events        ON workout_events;
DROP POLICY IF EXISTS anon_select_recurring_exceptions  ON recurring_exceptions;
DROP POLICY IF EXISTS anon_select_workout_completions   ON workout_completions;
DROP POLICY IF EXISTS anon_select_workout_sessions      ON workout_sessions;
DROP POLICY IF EXISTS anon_select_workout_set_logs      ON workout_set_logs;
DROP POLICY IF EXISTS anon_select_workout_cardio_logs   ON workout_cardio_logs;
DROP POLICY IF EXISTS anon_select_exercise_definitions  ON exercise_definitions;
