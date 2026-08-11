-- ============================================================
-- APEX TRAINING — Phase 28 Migration: OAuth 2.1 server for the MCP endpoint
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the Stage 2 OAuth code — it is inert for the
-- currently deployed code. Backs the "paste URL → sign in" connector flow
-- (claude.ai, ChatGPT): dynamically registered clients, short-lived PKCE
-- authorization codes, and OAuth access/refresh tokens minted into the
-- existing mcp_tokens store (phase26).
-- ============================================================

-- Dynamically registered OAuth clients (RFC 7591). Public clients only
-- (token_endpoint_auth_method 'none' + PKCE); no secret is ever stored.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT        PRIMARY KEY,
  client_name   TEXT        NOT NULL DEFAULT '',
  -- JSONB array of exact redirect URI strings. Loopback URIs
  -- (http://127.0.0.1 / http://localhost) match on any port at authorize
  -- time, per OAuth 2.1 — Claude Code registers a varying loopback port.
  redirect_uris JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-shot PKCE authorization codes: minted at consent, consumed at the
-- token endpoint, ~60s lifetime. Only the sha256 of the code is stored.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  client_id      TEXT        NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  redirect_uri   TEXT        NOT NULL,
  code_challenge TEXT        NOT NULL,  -- PKCE S256 challenge (base64url of sha256(verifier))
  scope          TEXT,
  resource       TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OAuth tokens live in mcp_tokens (phase26): kind 'oauth' = access token
-- (expires_at ~1h), new kind 'refresh' = refresh token (apxr_ prefix, which
-- deliberately fails the MCP endpoint's apx_ Bearer check). client_id ties a
-- token back to the client that obtained it, for display and revocation.
ALTER TABLE mcp_tokens DROP CONSTRAINT IF EXISTS mcp_tokens_kind_check;
ALTER TABLE mcp_tokens ADD CONSTRAINT mcp_tokens_kind_check
  CHECK (kind IN ('pat', 'oauth', 'refresh'));
ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS scope TEXT;

-- RLS enabled with deliberately NO policies (user_api_keys precedent): only
-- the service-role /api/* functions touch these tables.
ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
