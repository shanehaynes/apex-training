-- ============================================================
-- APEX TRAINING — Phase 30 Migration: onboarding
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the onboarding code — it is inert for the
-- currently deployed code. Backs the first-run welcome flow and the
-- "Getting started" checklist.
-- ============================================================

-- When the user finished or skipped the welcome flow. NULL = never seen
-- it, which is what makes the flow appear. Server-side rather than
-- localStorage (the template-offer banner's approach) so dismissing it on
-- the phone also dismisses it on the laptop.
--
-- Stamped by /api/profile from `{ onboarding_dismissed: true }` — the
-- client never supplies the timestamp, same posture as template_copied_at.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ;

-- Existing accounts have already found their way around; only genuinely
-- new users should meet the welcome flow.
UPDATE profiles SET onboarding_dismissed_at = now() WHERE onboarding_dismissed_at IS NULL;
