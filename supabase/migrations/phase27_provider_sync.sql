-- ============================================================
-- APEX TRAINING — Phase 27 Migration: fitness-provider sync (COROS)
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the provider-sync code — it is inert for the
-- currently deployed code (nothing reads these tables yet). Backs the
-- /api/provider-sync + /api/provider-callback endpoints: users connect
-- their COROS account via OAuth, then a calendar button pulls recent
-- activities into the schedule. Tables are provider-generic so Garmin
-- and Apple later only widen the CHECKs.
-- ============================================================

-- One row per user+provider connection. Tokens are encrypted at the
-- API layer with keyCrypto (enc:v1:…) — the raw OAuth tokens never
-- reach the database or the browser.
CREATE TABLE IF NOT EXISTS provider_connections (
  user_id          UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL CHECK (provider IN ('coros')),
  access_token     TEXT,                -- encrypted; NULL while OAuth is pending
  refresh_token    TEXT,                -- encrypted
  token_expires_at TIMESTAMPTZ,
  status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'connected', 'expired')),
  -- During the redirect dance: { state, codeVerifier (encrypted), createdAt }.
  -- Cleared on successful callback.
  pending_oauth    JSONB,
  -- The recorded "activity grab" watermark: set only after a successful
  -- apply. Bounds the next fetch window; the imports ledger below — not
  -- this timestamp — is what actually prevents duplicates.
  last_synced_at   TIMESTAMPTZ,
  connected_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- The import ledger: one row per provider activity ever decided on,
-- written LAST in each apply so a mid-crash re-proposes the activity
-- and the earlier upserts converge on retry. There is no 'skipped'
-- mode — declining a fill imports the activity as a standalone event.
CREATE TABLE IF NOT EXISTS provider_activity_imports (
  user_id     UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider    TEXT        NOT NULL,
  activity_id TEXT        NOT NULL,
  mode        TEXT        NOT NULL CHECK (mode IN ('created', 'filled')),
  -- Occurrence id when filled (base__YYYY-MM-DD for recurring); the
  -- coros-<activityId> event id when created.
  event_id    TEXT        NOT NULL,
  event_date  DATE        NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, activity_id)
);

-- Rich measured metrics, deliberately OUTSIDE the calendar read path
-- (workout_events stays lean). summary holds scalars (sport, avgHr,
-- maxHr, hrZones, calories, hrv, trainingLoad, vo2max, fileUrls…);
-- streams holds series ({ hr: [[sec,bpm]…], gps: [[sec,lat,lon,ele]…] }),
-- downsampled server-side to ≤ ~2000 points per series before insert.
CREATE TABLE IF NOT EXISTS activity_streams (
  user_id     UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_id    TEXT        NOT NULL,
  event_date  DATE        NOT NULL,
  provider    TEXT        NOT NULL,
  activity_id TEXT        NOT NULL,
  summary     JSONB       NOT NULL,
  streams     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id, event_date)
);

-- Provenance badge on events, stamped only on provider-CREATED one-off
-- events ('coros' | NULL = native). Never set on a recurring base row —
-- a filled occurrence's provenance lives in the ledger + streams tables.
ALTER TABLE workout_events ADD COLUMN IF NOT EXISTS source TEXT;

-- RLS. Connections and the ledger follow the user_api_keys / mcp_tokens
-- posture: enabled with deliberately NO policies — only the service-role
-- /api/* functions touch them; the browser sees status/timestamps via
-- /api/provider-sync, never token material.
ALTER TABLE provider_connections     ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_activity_imports ENABLE ROW LEVEL SECURITY;

-- activity_streams gets a per-user SELECT (meals precedent) so the event
-- detail view can read summaries with the anon client; writes stay
-- service-role only.
ALTER TABLE activity_streams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_select_own_activity_streams ON activity_streams;
CREATE POLICY user_select_own_activity_streams ON activity_streams
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
