-- ============================================================
-- APEX TRAINING — Phase 5 Migration: Coach summary
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Stores the AI-generated post-workout summary on the session row so
-- reopening a finished workout shows the same text without another
-- (billed) generation. Written via the service-role /api/workout-sessions
-- endpoint; readable by anon like the rest of the session row.
-- ============================================================

ALTER TABLE workout_sessions ADD COLUMN IF NOT EXISTS coach_summary TEXT;
