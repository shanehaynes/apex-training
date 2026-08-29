-- ============================================================
-- APEX TRAINING — Phase 35 Migration: analytics foundation
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- The modular analytics dashboard: user-composed chart tiles (a ChartSpec
-- JSONB the client builds, validates, and renders — the server guards the
-- column, src/lib/analytics/spec.ts guards the contents, the blocks
-- weekly_targets precedent). Layout is real columns, not JSONB: a tile's
-- grid position (x, y, w, h) is written by every drag/resize commit as a
-- batched upsert, and deleting a tile can never orphan a layout entry.
--
-- Tiles hard-DELETE, unlike templates and exercise definitions: nothing
-- keys history on a tile id, so there is no archived_at.
--
-- Same locked-down posture as every phase25+ table: PK led by user_id
-- (client-minted ids must never collide or probe across users), RLS on,
-- SELECT-own policy only (phase31 initplan form), writes via the
-- service-role endpoint /api/analytics-tiles.
--
-- Also carried here, because they exist for the same feature:
--   meals.alcohol_g            — alcohol tracked as grams like every other
--                                macro column; folded into derived calories
--                                at 7 kcal/g (Atwater 4/4/9/7)
--   profiles.max_hr,           — HR-zone boundaries for %-time-in-zone
--   profiles.threshold_hr        tiles: Friel LTHR bands when threshold_hr
--                                is set, max-HR %-bands otherwise
--   activity_streams index     — analytics is the first reader that range-
--                                scans this table by date; the PK
--                                (user_id, event_id, event_date) cannot
--                                serve that past its first column
-- ============================================================

CREATE TABLE IF NOT EXISTS analytics_tiles (
  user_id    UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  id         TEXT        NOT NULL,
  spec       JSONB       NOT NULL,
  x          INTEGER     NOT NULL DEFAULT 0 CHECK (x >= 0),
  y          INTEGER     NOT NULL DEFAULT 0 CHECK (y >= 0),
  w          INTEGER     NOT NULL DEFAULT 4 CHECK (w BETWEEN 1 AND 12),
  h          INTEGER     NOT NULL DEFAULT 3 CHECK (h BETWEEN 1 AND 24),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

ALTER TABLE analytics_tiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_select_own_analytics_tiles ON analytics_tiles;
CREATE POLICY user_select_own_analytics_tiles ON analytics_tiles
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);

-- ── Meals: alcohol as a first-class macro ────────────────────────────────────

ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS alcohol_g NUMERIC CHECK (alcohol_g >= 0);

ALTER TABLE meal_favorites
  ADD COLUMN IF NOT EXISTS alcohol_g NUMERIC CHECK (alcohol_g >= 0);

-- ── Profiles: HR-zone settings ───────────────────────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS max_hr       INTEGER CHECK (max_hr BETWEEN 100 AND 250),
  ADD COLUMN IF NOT EXISTS threshold_hr INTEGER CHECK (threshold_hr BETWEEN 80 AND 230);

-- ── Activity streams: date-range scans ───────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_activity_streams_user_date
  ON activity_streams (user_id, event_date);

-- PostgREST resolves upsert conflict targets against its cached schema; the
-- new table's composite PK must be visible before /api/analytics-tiles
-- upserts against it (phase25's closing note).
NOTIFY pgrst, 'reload schema';
