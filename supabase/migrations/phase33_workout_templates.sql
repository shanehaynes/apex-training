-- ============================================================
-- APEX TRAINING — Phase 33 Migration: workout templates
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- The workout library: reusable workout templates the builder's search-first
-- flow picks from, the analogue of meal_favorites (phase 24) for workouts.
-- A template is a workout_events row minus its calendar placement (date,
-- times, recurrence, completion), plus the scoring config that defines what
-- a PR means for this workout:
--
--   strength  — per-exercise records (Epley 1RM etc.), the historical default
--   for-time  — fixed work, PR = fastest completion (e.g. MURPH)
--   amrap     — fixed time cap, PR = most rounds+reps (e.g. CINDY)
--
-- Workout-level PR history keys on the template id, so templates are
-- archived (archived_at), never hard-deleted, and renames are safe — the
-- exercise_definitions precedent. Upsert semantics live client-side (same
-- title case-insensitively reuses the existing template's id), so no unique
-- title constraint.
--
-- Scheduled events carry a SNAPSHOT of the template linkage: template_id
-- plus copied scoring columns. Snapshot, not live resolution — a template
-- later switched from for-time to amrap must not reinterpret events already
-- on the calendar (the same reason set logs snapshot planned values). No FK:
-- a composite FK to (user_id, id) cannot SET NULL cleanly, and the soft
-- reference matches how Exercise.definitionId behaves in the event JSONB.
--
-- Same locked-down posture as every phase25+ table: PK led by user_id
-- (client-minted ids must never collide or probe across users), RLS on,
-- SELECT-own policy only (phase31 initplan form), writes via the
-- service-role endpoint /api/workout-templates.
-- ============================================================

CREATE TABLE IF NOT EXISTS workout_templates (
  user_id            UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  id                 TEXT        NOT NULL,
  title              TEXT        NOT NULL,
  type               TEXT        NOT NULL CHECK (type IN
                       ('stretching','morning-routine','weights','climbing',
                        'outdoor-climbing','cardio','yoga')),
  scoring_type       TEXT        NOT NULL DEFAULT 'strength' CHECK (scoring_type IN
                       ('strength','for-time','amrap')),
  time_cap_minutes   INTEGER     CHECK (time_cap_minutes > 0),
  estimated_duration INTEGER     NOT NULL,
  difficulty         INTEGER     NOT NULL DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),
  description        TEXT        NOT NULL DEFAULT '',
  warmup             JSONB       NOT NULL DEFAULT '[]',
  exercises          JSONB       NOT NULL DEFAULT '[]',
  cooldown           JSONB       NOT NULL DEFAULT '[]',
  location           TEXT,
  tags               TEXT[]      NOT NULL DEFAULT '{}',
  equipment          TEXT[]      NOT NULL DEFAULT '{}',
  cardio_targets     JSONB,
  climbing_targets   JSONB,
  archived_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

-- The library list reads newest-saved first.
CREATE INDEX IF NOT EXISTS idx_workout_templates_user
  ON workout_templates (user_id, updated_at DESC);

ALTER TABLE workout_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_select_own_workout_templates ON workout_templates;
CREATE POLICY user_select_own_workout_templates ON workout_templates
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);

-- ── Scheduled events: template linkage + scoring snapshot ────────────────────

ALTER TABLE workout_events
  ADD COLUMN IF NOT EXISTS template_id      TEXT,
  ADD COLUMN IF NOT EXISTS scoring_type     TEXT CHECK (scoring_type IN
                             ('strength','for-time','amrap')),
  ADD COLUMN IF NOT EXISTS time_cap_minutes INTEGER CHECK (time_cap_minutes > 0);

-- PostgREST resolves upsert conflict targets against its cached schema; the
-- new table's composite PK must be visible before /api/workout-templates
-- upserts against it (phase25's closing note).
NOTIFY pgrst, 'reload schema';
