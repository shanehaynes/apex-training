-- ============================================================
-- APEX TRAINING — Phase 26 Migration: MCP personal access tokens
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the MCP-server code — it is inert for the
-- currently deployed code (nothing reads this table yet). Backs the
-- remote MCP endpoint (/api/mcp): users mint a token in Profile,
-- paste it into Claude/ChatGPT as a bearer header, and the endpoint
-- resolves it to a user_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- sha256 hex of the full token. The plaintext is shown once at mint
  -- and never stored; lookup is an indexed equality on this hash.
  token_hash   TEXT        NOT NULL UNIQUE,
  -- Last 4 chars of the plaintext, for display in the token list ("…a1b2").
  token_last4  TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  -- 'pat' now; the Stage 2 OAuth server mints access/refresh tokens into
  -- this same store with kind = 'oauth' and expires_at set, so the MCP
  -- endpoint's auth path never changes.
  kind         TEXT        NOT NULL DEFAULT 'pat' CHECK (kind IN ('pat', 'oauth')),
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx ON mcp_tokens (user_id);

-- RLS enabled with deliberately NO policies (user_api_keys precedent):
-- anon and authenticated get zero rows in every mode. Only the
-- service-role /api/* functions touch this table. The browser sees
-- name/last4/dates via GET /api/mcp-tokens — never the hash.
ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
