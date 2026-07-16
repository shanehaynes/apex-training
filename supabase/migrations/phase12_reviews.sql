-- ============================================================
-- APEX TRAINING — Phase 12 Migration: Monthly / yearly review ledger
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the review-cron code — it is inert for the
-- currently deployed code (nothing reads this table yet). One row per
-- user per review period; the cron treats a missing row as "generate"
-- and email_sent_at / email_skipped_reason as "done", so the table is
-- both the archive and the double-send guard.
-- ============================================================

CREATE TABLE IF NOT EXISTS reviews (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  period_type          TEXT        NOT NULL CHECK (period_type IN ('month', 'year')),
  -- ISO week-numbering year. A "month" is 4 ISO weeks (13 per year);
  -- month 13 absorbs week 53 in 53-week years.
  iso_year             INT         NOT NULL,
  month_index          INT         CHECK (month_index BETWEEN 1 AND 13),
  stats                JSONB       NOT NULL,
  ai_commentary        TEXT,                    -- null = no key, or generation pending
  email_sent_at        TIMESTAMPTZ,             -- null + no skip reason = send pending (retried daily)
  email_skipped_reason TEXT,                    -- 'no-activity' | 'no-email'
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((period_type = 'month') = (month_index IS NOT NULL))
);

-- COALESCE because yearly rows carry NULL month_index, and NULLs never
-- collide in a plain UNIQUE constraint.
CREATE UNIQUE INDEX IF NOT EXISTS reviews_period_key
  ON reviews (user_id, period_type, iso_year, COALESCE(month_index, 0));

-- RLS enabled with deliberately NO policies: delivery is email-only, so
-- only the service-role cron touches this table (same posture as
-- user_api_keys).
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
