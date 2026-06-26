-- ============================================================
-- APEX TRAINING — Database Schema
-- Run this in your Supabase project's SQL editor.
-- ============================================================

-- Current completion state (one row per event, upserted on toggle)
CREATE TABLE IF NOT EXISTS workout_completions (
  event_id         TEXT PRIMARY KEY,
  event_date       DATE        NOT NULL,
  event_type       TEXT        NOT NULL,
  event_title      TEXT        NOT NULL,
  duration_minutes INTEGER,
  is_completed     BOOLEAN     NOT NULL DEFAULT true,
  completed_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only history of every toggle (never deleted — source of truth for analytics)
CREATE TABLE IF NOT EXISTS workout_completion_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         TEXT        NOT NULL,
  event_date       DATE        NOT NULL,
  event_type       TEXT        NOT NULL,
  event_title      TEXT        NOT NULL,
  duration_minutes INTEGER,
  action           TEXT        NOT NULL CHECK (action IN ('complete', 'uncomplete')),
  logged_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indices for analytics queries (date range scans, type breakdowns, consistency charts)
CREATE INDEX IF NOT EXISTS idx_wc_date   ON workout_completions (event_date);
CREATE INDEX IF NOT EXISTS idx_wc_type   ON workout_completions (event_type, is_completed);
CREATE INDEX IF NOT EXISTS idx_wcl_date  ON workout_completion_log (event_date);
CREATE INDEX IF NOT EXISTS idx_wcl_type  ON workout_completion_log (event_type);
CREATE INDEX IF NOT EXISTS idx_wcl_eid   ON workout_completion_log (event_id);

-- Disable Row Level Security for now (single-user personal site, no auth yet).
-- When user auth is added: enable RLS, add per-user policies, and move
-- the Supabase client to a Vercel Edge Function using the service-role key.
ALTER TABLE workout_completions     DISABLE ROW LEVEL SECURITY;
ALTER TABLE workout_completion_log  DISABLE ROW LEVEL SECURITY;
