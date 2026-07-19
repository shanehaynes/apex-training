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

-- ============================================================
-- PHASE 2: MUTABLE SCHEDULE
-- ============================================================

-- All workout events (replaces schedule.json as source of truth).
-- exercises / warmup / cooldown are stored as JSONB arrays — their internal
-- structure is complex and query patterns never need to filter inside them.
CREATE TABLE IF NOT EXISTS workout_events (
  id                  TEXT        PRIMARY KEY,
  type                TEXT        NOT NULL CHECK (type IN ('stretching','morning-routine','weights','climbing','outdoor-climbing','cardio','yoga')),
  title               TEXT        NOT NULL,
  subtitle            TEXT,
  date                DATE        NOT NULL,
  start_time          TEXT,
  end_time            TEXT,
  estimated_duration  INTEGER     NOT NULL,
  description         TEXT        NOT NULL DEFAULT '',
  warmup              JSONB       NOT NULL DEFAULT '[]',
  exercises           JSONB       NOT NULL DEFAULT '[]',
  cooldown            JSONB       NOT NULL DEFAULT '[]',
  difficulty          INTEGER     NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  location            TEXT,
  cover_image_url     TEXT,
  tags                TEXT[]      NOT NULL DEFAULT '{}',
  equipment           TEXT[]      NOT NULL DEFAULT '{}',
  is_recurring        BOOLEAN     NOT NULL DEFAULT false,
  recurring_frequency TEXT        CHECK (recurring_frequency IN ('daily','weekly','custom')),
  recurring_days      INTEGER[],  -- 0=Sun … 6=Sat
  recurring_end_date  DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 9: planned cardio targets ({ distance, elevationGain, avgHeartRate }).
-- Idempotent so re-running the schema upgrades existing databases.
ALTER TABLE workout_events ADD COLUMN IF NOT EXISTS cardio_targets JSONB;

-- Phase 17: planned outdoor-climbing targets ({ maxGrade, totalPitches }).
ALTER TABLE workout_events ADD COLUMN IF NOT EXISTS climbing_targets JSONB;

CREATE INDEX IF NOT EXISTS idx_we_date ON workout_events (date);
CREATE INDEX IF NOT EXISTS idx_we_type ON workout_events (type, date);

-- Per-occurrence exceptions for recurring events. All overrides NULL means
-- the occurrence at skipped_date is removed ("delete just this Tuesday").
-- Any override set means the occurrence originally generated at skipped_date
-- is displayed at override_date (or skipped_date when only the time changed)
-- with the overridden start/end times; it keeps its `${baseId}__${skipped_date}`
-- id so completion state and later edits survive moves.
CREATE TABLE IF NOT EXISTS recurring_exceptions (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    TEXT  NOT NULL REFERENCES workout_events (id) ON DELETE CASCADE,
  skipped_date DATE NOT NULL,
  override_date       DATE,
  override_start_time TEXT,
  override_end_time   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, skipped_date)
);

CREATE INDEX IF NOT EXISTS idx_re_event ON recurring_exceptions (event_id);

-- Append-only log of every AI-driven mutation (audit trail).
CREATE TABLE IF NOT EXISTS event_mutations_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operation    TEXT        NOT NULL CHECK (operation IN ('create','update','delete','delete_instance','update_instance')),
  event_id     TEXT        NOT NULL,
  event_title  TEXT        NOT NULL,
  event_date   DATE,
  diff         JSONB,      -- {before: {...}, after: {...}} for updates
  triggered_by TEXT        NOT NULL DEFAULT 'ai',
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eml_event ON event_mutations_log (event_id);
CREATE INDEX IF NOT EXISTS idx_eml_date  ON event_mutations_log (logged_at);

ALTER TABLE workout_events      DISABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_exceptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE event_mutations_log  DISABLE ROW LEVEL SECURITY;
