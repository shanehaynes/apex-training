-- ============================================================
-- APEX TRAINING — Phase 11 Migration: Per-user Anthropic API keys
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the per-user-key code — it is inert for the
-- currently deployed code (nothing reads this table yet). After the
-- deploy, the coach chat and post-workout summary are down for EVERY
-- user (Shane included) until each saves their own key via Profile →
-- AI Coach; the ANTHROPIC_API_KEY env var can then be removed from
-- Vercel.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_api_keys (
  user_id           UUID        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  anthropic_api_key TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS enabled with deliberately NO policies: anon and authenticated get
-- zero rows in every mode. Only the service-role /api/* functions (which
-- bypass RLS) touch this table. The browser learns only "a key is set"
-- plus its last 4 characters, via GET /api/profile — never the key.
ALTER TABLE user_api_keys ENABLE ROW LEVEL SECURITY;
