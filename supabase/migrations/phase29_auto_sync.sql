-- ============================================================
-- APEX TRAINING — Phase 29 Migration: nightly provider auto-sync
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the auto-sync code — it is inert for the
-- currently deployed code. Backs the /api/provider-cron nightly job:
-- every connected provider (COROS today; Garmin/Apple later) syncs
-- automatically once a day, importing unmatched activities and counting
-- planned-workout matches for the user to confirm in-app.
-- ============================================================

-- The user's IANA timezone, stamped from the browser on every manual
-- connect/preview/apply. The cron has no browser to ask, and the schema
-- stores floating local dates — this is how the nightly job converts a
-- UTC activity instant to the user's calendar date. NULL (connected
-- before this migration, never manually synced since) falls back to UTC.
ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS timezone TEXT;

-- Per-connection opt-out for the nightly job; manual sync is unaffected.
ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS auto_sync BOOLEAN NOT NULL DEFAULT TRUE;

-- How many fetched activities matched a planned workout and are waiting
-- for the user's fill/keep-separate decision. Set by the nightly job,
-- cleared by a manual apply; drives the badge on the calendar Sync button.
ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS pending_fill_count INTEGER NOT NULL DEFAULT 0;
