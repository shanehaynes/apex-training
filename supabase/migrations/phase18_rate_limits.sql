-- ============================================================
-- APEX TRAINING — Phase 18 Migration: Per-user API rate limiting
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the rate-limit code — it is inert for the
-- currently deployed code, and the api/_lib/rateLimit.ts checks fail
-- OPEN (log + allow) until the function exists, so ordering is
-- forgiving either way.
--
-- Fixed-window counters: one row per user per bucket per window.
-- Boundary bursts of up to 2x the limit are acceptable — the goal is
-- stopping runaway request loops, not precise throttling.
-- ============================================================

CREATE TABLE IF NOT EXISTS api_request_counts (
  user_id      UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  bucket       TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INT         NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, bucket, window_start)
);

-- RLS enabled with deliberately NO policies: only the service-role API
-- layer touches this table (same posture as reviews / user_api_keys).
ALTER TABLE api_request_counts ENABLE ROW LEVEL SECURITY;

-- Atomic bump-and-read for the current window. The upsert is safe under
-- concurrent serverless invocations; the trailing DELETE opportunistically
-- prunes that user/bucket's expired windows so the table stays tiny.
CREATE OR REPLACE FUNCTION bump_rate_limit(
  p_user_id        UUID,
  p_bucket         TEXT,
  p_window_seconds INT
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count        INT;
BEGIN
  v_window_start := to_timestamp(
    floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO api_request_counts (user_id, bucket, window_start, count)
  VALUES (p_user_id, p_bucket, v_window_start, 1)
  ON CONFLICT (user_id, bucket, window_start)
  DO UPDATE SET count = api_request_counts.count + 1
  RETURNING count INTO v_count;

  DELETE FROM api_request_counts
  WHERE user_id = p_user_id
    AND bucket = p_bucket
    AND window_start < v_window_start - make_interval(secs => p_window_seconds * 2);

  RETURN v_count;
END;
$$;
