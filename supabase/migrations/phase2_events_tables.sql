-- ============================================================
-- APEX TRAINING — Phase 2 Migration
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

CREATE TABLE IF NOT EXISTS workout_events (
  id                  TEXT        PRIMARY KEY,
  type                TEXT        NOT NULL CHECK (type IN ('stretching','morning-routine','weights','climbing','cardio','yoga')),
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
  recurring_days      INTEGER[],
  recurring_end_date  DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_we_date ON workout_events (date);
CREATE INDEX IF NOT EXISTS idx_we_type ON workout_events (type, date);

CREATE TABLE IF NOT EXISTS recurring_exceptions (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     TEXT  NOT NULL REFERENCES workout_events (id) ON DELETE CASCADE,
  skipped_date DATE  NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, skipped_date)
);

CREATE INDEX IF NOT EXISTS idx_re_event ON recurring_exceptions (event_id);

CREATE TABLE IF NOT EXISTS event_mutations_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operation    TEXT        NOT NULL CHECK (operation IN ('create','update','delete','delete_instance')),
  event_id     TEXT        NOT NULL,
  event_title  TEXT        NOT NULL,
  event_date   DATE,
  diff         JSONB,
  triggered_by TEXT        NOT NULL DEFAULT 'ai',
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eml_event ON event_mutations_log (event_id);
CREATE INDEX IF NOT EXISTS idx_eml_date  ON event_mutations_log (logged_at);

ALTER TABLE workout_events       DISABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_exceptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE event_mutations_log  DISABLE ROW LEVEL SECURITY;
