-- ============================================================
-- APEX TRAINING — Phase 34 Migration: workout-level scores
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- The score a scored workout (workout_templates.scoring_type, phase 33)
-- earns at Finish. A score is strictly 1:1 with a tracked session and the
-- finish path already updates that row, so these are columns on
-- workout_sessions, not a new table:
--
--   for-time — score_time_seconds; the PR is the LOWEST
--   amrap    — score_rounds + score_reps; the PR is the lexicographic max
--
-- template_id is denormalized onto the session (the exercise_name
-- convention on set logs): workout-level PR history must group across every
-- scheduled instance of the named workout and survive event deletion, and
-- with the id on the row no join is needed. PR comparison itself stays
-- client-side in src/lib/tracking/records.ts, like every other record kind.
--
-- No RLS change: phase10 dropped the permissive anon SELECT and phase9's
-- user-scoped SELECT policy (tightened in phase31) covers the new columns;
-- writes keep going through the service-role /api/workout-sessions finish
-- action, which validates the score shape.
-- ============================================================

ALTER TABLE workout_sessions
  ADD COLUMN IF NOT EXISTS template_id        TEXT,
  ADD COLUMN IF NOT EXISTS score_type         TEXT CHECK (score_type IN ('for-time','amrap')),
  ADD COLUMN IF NOT EXISTS score_time_seconds INTEGER CHECK (score_time_seconds > 0),
  ADD COLUMN IF NOT EXISTS score_rounds       INTEGER CHECK (score_rounds >= 0),
  ADD COLUMN IF NOT EXISTS score_reps         INTEGER CHECK (score_reps >= 0);

-- The score-history read: sessions for one template, before this date.
CREATE INDEX IF NOT EXISTS idx_workout_sessions_template
  ON workout_sessions (user_id, template_id, event_date);
