-- ============================================================
-- APEX TRAINING — Phase 22 Migration: meals
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Nutrition logging: one row per meal, keyed to a calendar day. Deliberately
-- its own table, not a workout_events type — meals have no completion,
-- recurrence, or ICS-feed semantics. Numeric macro columns are nullable
-- (blank form fields stay unset) and NUMERIC, not INTEGER, so half-gram
-- entries work. fat_total_g is independent of the sat/trans split: total ≥
-- sat + trans is enforced client-side (unsaturated fats make up the rest).
--
-- Born post-phase10, so it starts in the locked-down posture: no user_id
-- DEFAULT (the /api/meals handler stamps it from the verified JWT), RLS on,
-- and a per-user SELECT policy only — all writes go through the service-role
-- endpoint.
-- ============================================================

CREATE TABLE IF NOT EXISTS meals (
  id              TEXT        PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title           TEXT        NOT NULL,
  date            DATE        NOT NULL,
  time            TEXT,
  meal_type       TEXT        CHECK (meal_type IN ('breakfast','lunch','dinner','snack')),
  calories        NUMERIC     CHECK (calories >= 0),
  protein_g       NUMERIC     CHECK (protein_g >= 0),
  carbs_g         NUMERIC     CHECK (carbs_g >= 0),
  fiber_g         NUMERIC     CHECK (fiber_g >= 0),
  sugar_g         NUMERIC     CHECK (sugar_g >= 0),
  fat_total_g     NUMERIC     CHECK (fat_total_g >= 0),
  fat_saturated_g NUMERIC     CHECK (fat_saturated_g >= 0),
  fat_trans_g     NUMERIC     CHECK (fat_trans_g >= 0),
  notes           TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals (user_id, date);

ALTER TABLE meals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_select_own_meals ON meals;
CREATE POLICY user_select_own_meals ON meals
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
