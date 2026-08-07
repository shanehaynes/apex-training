-- ============================================================
-- APEX TRAINING — Phase 24 Migration: meal favorites
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Reusable meal templates ("favorites"): a meals row minus date/time. Saved
-- from the add-meal composer, applied back to prefill it. Upsert semantics
-- live client-side (same title reuses the existing favorite's id), so no
-- composite unique constraint — the id PK is the only identity. Same
-- locked-down posture as meals (phase 22): no user_id DEFAULT, RLS on,
-- SELECT-own policy only, writes via the service-role endpoint.
-- ============================================================

CREATE TABLE IF NOT EXISTS meal_favorites (
  id              TEXT        PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title           TEXT        NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_meal_favorites_user ON meal_favorites (user_id);

-- Upsert conflict target for /api/meal-favorites, scoped by user (phase9
-- convention): a forged id belonging to another user finds no (user_id, id)
-- conflict, falls through to the id PK, and errors — it can never clobber.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meal_favorites_user_id_id ON meal_favorites (user_id, id);

ALTER TABLE meal_favorites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_select_own_meal_favorites ON meal_favorites;
CREATE POLICY user_select_own_meal_favorites ON meal_favorites
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
