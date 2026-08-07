-- ============================================================
-- APEX TRAINING — Phase 23 Migration: meal coach tools
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Audit trail for meal mutations, mirroring definition_mutations_log
-- (phase 8). Needed now that the AI coach can log/update/delete meals:
-- the daily AI mutation cap (api/_lib/rateLimit.ts) counts triggered_by='ai'
-- audit rows, so coach meal writes must land somewhere countable. Server-only
-- like the other logs: RLS on, no policies — written and read exclusively
-- through service-role /api/* handlers.
-- ============================================================

CREATE TABLE IF NOT EXISTS meal_mutations_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  operation    TEXT        NOT NULL CHECK (operation IN ('create','update','delete')),
  meal_id      TEXT        NOT NULL,
  meal_title   TEXT        NOT NULL,
  diff         JSONB,      -- {before: {...}, after: {...}} for updates
  triggered_by TEXT        NOT NULL DEFAULT 'ai',
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mml_meal ON meal_mutations_log (meal_id);
CREATE INDEX IF NOT EXISTS idx_mml_date ON meal_mutations_log (logged_at);

ALTER TABLE meal_mutations_log ENABLE ROW LEVEL SECURITY;
