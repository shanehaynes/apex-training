-- ============================================================
-- APEX TRAINING — Phase 4 Migration: Workout tracking
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Adds per-set actuals logging for workout sessions. event_id follows the
-- same convention as workout_completions: for recurring occurrences it is
-- the expanded `${baseId}__${date}` id synthesized by expandRecurringEvents,
-- so one column already identifies the occurrence. event_date is stored
-- alongside it for analytics range scans and defensive uniqueness.
-- ============================================================

-- One row per tracked session (get-or-create on "Start Workout").
CREATE TABLE IF NOT EXISTS workout_sessions (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id               TEXT        NOT NULL,
  event_date             DATE        NOT NULL,
  started_at             TIMESTAMPTZ NOT NULL,
  finished_at            TIMESTAMPTZ,
  total_duration_seconds INTEGER,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, event_date)
);

-- One row per set attempt for non-cardio exercises. Planned values are
-- snapshotted at log time; exercise definitions live in mutable JSONB on
-- workout_events, so a later edit must not rewrite history.
CREATE TABLE IF NOT EXISTS workout_set_logs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         TEXT        NOT NULL,
  event_date       DATE        NOT NULL,
  section          TEXT        NOT NULL CHECK (section IN ('warmup', 'exercise', 'cooldown')),
  exercise_id      TEXT        NOT NULL,
  exercise_name    TEXT        NOT NULL,
  set_number       INTEGER     NOT NULL,
  planned_weight   TEXT,
  planned_reps     TEXT,
  planned_duration TEXT,
  actual_weight    TEXT,
  actual_reps      TEXT,
  actual_duration  TEXT,
  -- true = zero-filled at Finish, not a real 0-rep attempt; keeps skipped
  -- sets distinguishable from failed sets for future analytics.
  is_autofilled    BOOLEAN     NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, event_date, section, exercise_id, set_number)
);

-- One row per cardio exercise per session — structured manual entry,
-- no per-set granularity.
CREATE TABLE IF NOT EXISTS workout_cardio_logs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         TEXT        NOT NULL,
  event_date       DATE        NOT NULL,
  section          TEXT        NOT NULL CHECK (section IN ('warmup', 'exercise', 'cooldown')),
  exercise_id      TEXT        NOT NULL,
  exercise_name    TEXT        NOT NULL,
  duration_minutes NUMERIC,
  distance         TEXT,
  elevation_gain   TEXT,
  avg_heart_rate   INTEGER,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, event_date, section, exercise_id)
);

CREATE INDEX IF NOT EXISTS idx_ws_date  ON workout_sessions   (event_date);
CREATE INDEX IF NOT EXISTS idx_wsl_key  ON workout_set_logs   (event_id, event_date);
CREATE INDEX IF NOT EXISTS idx_wsl_date ON workout_set_logs   (event_date);
CREATE INDEX IF NOT EXISTS idx_wclg_key ON workout_cardio_logs (event_id, event_date);

-- Same posture as phase3: anon key is read-only, all writes go through
-- service-role backed /api/* endpoints (service_role bypasses RLS).
ALTER TABLE workout_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_set_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_cardio_logs ENABLE ROW LEVEL SECURITY;

-- The tracker reads existing sessions/logs directly with the anon client
-- when re-entering a session (resume + post-finish editing).
CREATE POLICY anon_select_workout_sessions
  ON workout_sessions FOR SELECT
  TO anon
  USING (true);

CREATE POLICY anon_select_workout_set_logs
  ON workout_set_logs FOR SELECT
  TO anon
  USING (true);

CREATE POLICY anon_select_workout_cardio_logs
  ON workout_cardio_logs FOR SELECT
  TO anon
  USING (true);
