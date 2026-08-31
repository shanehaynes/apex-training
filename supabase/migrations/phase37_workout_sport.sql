-- ============================================================
-- APEX TRAINING — Phase 37 Migration: sport on workouts
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- A first-class sport dimension on workouts, replacing the analytics
-- dashboard's reliance on parsing synced activity summaries. The five
-- values are the breakdown the dashboard charts:
--
--   running / biking / swimming — picked in the workout builder for
--       cardio-type workouts (and stamped at COROS import from the sport
--       code, backfilled below)
--   climbing — implied by the climbing event types; stored anyway so a
--       row is self-describing without a type lookup
--   other — a named workout the user built for a sport Apex has no
--       bucket for (the repeated soccer workout); the workout's own
--       title carries its identity in breakdowns and filters
--
-- Nullable on purpose: legacy cardio rows have no sport, and analytics
-- shows them as "unspecified" rather than guessing from free text —
-- that guessing is exactly what this column retires.
-- ============================================================

ALTER TABLE workout_events
  ADD COLUMN IF NOT EXISTS sport TEXT CHECK (sport IN
    ('running','biking','swimming','climbing','other'));

ALTER TABLE workout_templates
  ADD COLUMN IF NOT EXISTS sport TEXT CHECK (sport IN
    ('running','biking','swimming','climbing','other'));

-- ── Backfills ────────────────────────────────────────────────────────────────

-- Climbing types are climbing, no judgment involved.
UPDATE workout_events
  SET sport = 'climbing'
  WHERE sport IS NULL AND type IN ('climbing','outdoor-climbing');

UPDATE workout_templates
  SET sport = 'climbing'
  WHERE sport IS NULL AND type IN ('climbing','outdoor-climbing');

-- Provider-synced events: the COROS sport code sits in the paired
-- activity_streams summary. Codes per api/_lib/providers/coros/mapSport.ts:
-- 10x run modes, 2xx bike modes, 300/301 swims. Everything else (ski, row,
-- walk, gym…) stays NULL — 'other' is reserved for workouts the user
-- deliberately names, not a dumping ground for unmapped watch modes.
UPDATE workout_events e
  SET sport = CASE
    WHEN (s.summary->>'sport')::numeric IN (100, 101, 102, 103) THEN 'running'
    WHEN (s.summary->>'sport')::numeric BETWEEN 200 AND 299 THEN 'biking'
    WHEN (s.summary->>'sport')::numeric IN (300, 301) THEN 'swimming'
  END
  FROM activity_streams s
  WHERE s.user_id = e.user_id
    AND s.event_id = e.id
    AND e.sport IS NULL
    AND e.source IS NOT NULL
    AND (s.summary->>'sport') ~ '^[0-9]+$'
    AND (
      (s.summary->>'sport')::numeric IN (100, 101, 102, 103, 300, 301)
      OR (s.summary->>'sport')::numeric BETWEEN 200 AND 299
    );

NOTIFY pgrst, 'reload schema';
