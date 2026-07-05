-- ============================================================
-- APEX TRAINING — Phase 6 Migration: Quick-complete logging
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- The "Mark as Complete" toggle now logs every exercise in the event at its
-- planned (recommended) targets. Those rows are flagged is_autofilled, the
-- same flag workout_set_logs already uses for zero-filled skips: system-
-- generated, excluded from PR / last-performance detection, and deletable
-- when the toggle is turned back off. Cardio logs gain the column here so
-- the two tables share the convention.
-- ============================================================

ALTER TABLE workout_cardio_logs
  ADD COLUMN IF NOT EXISTS is_autofilled BOOLEAN NOT NULL DEFAULT false;
