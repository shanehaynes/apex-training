-- ============================================================
-- APEX TRAINING — Phase 36 Migration: terms acceptance ledger
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the clickwrap code — the acceptance handler and the
-- requireUser gate both read this table, and the gate FAILS CLOSED (a
-- missing table reads as "nobody has accepted"), so deploying the code
-- first would 403 every authenticated request until this lands.
--
-- Backs the signup/invite acceptance checkbox and the re-acceptance modal.
-- Browsewrap — a link in a footer — is routinely held unenforceable; what
-- makes clickwrap stand up is evidence that a specific person affirmatively
-- agreed to a specific document version at a specific time. That evidence is
-- this table, so it is built to be an audit log rather than current state:
--
--   APPEND-ONLY. Accepting v2 INSERTS; it never updates the v1 row. The
--   trigger below makes that structural rather than a convention — UPDATE
--   always raises, and so does a direct DELETE, so no future handler,
--   migration, or hand-run SQL can quietly rewrite history. The one DELETE
--   that IS allowed is the auth.users cascade, when the account itself is
--   being deleted — see the trigger for how it tells the two apart.
--
-- Versions are the string constants in src/lib/legal/versions.ts, stamped
-- SERVER-SIDE from those constants — never from the request body, or a
-- client could claim to have accepted a version that was never published.
-- ============================================================

CREATE TABLE IF NOT EXISTS terms_acceptances (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- e.g. 'terms-v1' / 'privacy-v1'. Deliberately TEXT with no FK or CHECK:
  -- the set of published versions grows over time and lives in the repo, and
  -- a constraint here would have to be migrated in lockstep with every bump.
  terms_version   TEXT        NOT NULL,
  privacy_version TEXT        NOT NULL,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Evidence fields. Both are best-effort and nullable: ip comes from
  -- x-forwarded-for, which is absent in local dev, and a client can withhold
  -- a user agent. Their absence must never block an acceptance — a row with
  -- a null ip is far better evidence than no row at all.
  ip              TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The gate reads "latest acceptance for this user" on every authenticated
-- request, so that lookup is the one that has to be cheap.
CREATE INDEX IF NOT EXISTS terms_acceptances_user_idx
  ON terms_acceptances (user_id, accepted_at DESC);

-- Append-only, enforced. A BEFORE trigger cannot be worked around by the
-- service-role key the way a REVOKE could be.
--
-- The DELETE case has to distinguish two things that look identical to the
-- trigger: someone quietly erasing evidence (forbidden), and the account
-- itself being deleted, which cascades here (required — DELETE /api/account
-- promises it, and legal/privacy-v1.md §5 says so in writing).
--
-- The test is whether the parent auth.users row still exists. Postgres
-- implements ON DELETE CASCADE as an AFTER-ROW referential trigger on the
-- PARENT, so by the time this child row's DELETE runs, the parent is already
-- gone inside the transaction. A direct DELETE against this table leaves the
-- parent sitting there, and raises.
--
-- Found the hard way: with a blanket DELETE ban, auth.admin.deleteUser()
-- failed with "Database error deleting user" and account deletion was
-- impossible — the audit log had quietly become undeletable in a way that
-- broke the very promise the documents above it make.
CREATE OR REPLACE FUNCTION public.terms_acceptances_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
    RETURN OLD;  -- the account is going; its acceptance record goes with it
  END IF;
  RAISE EXCEPTION
    'terms_acceptances is append-only: % is not permitted. Accepting a new version INSERTs a new row; rows leave only with the account.',
    TG_OP;
END
$$;

DROP TRIGGER IF EXISTS terms_acceptances_no_rewrite ON terms_acceptances;
CREATE TRIGGER terms_acceptances_no_rewrite
  BEFORE UPDATE OR DELETE ON terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.terms_acceptances_append_only();

-- RLS enabled with deliberately NO policies (user_api_keys / mcp_tokens
-- precedent): anon and authenticated get zero rows in every mode. Only the
-- service-role /api/* functions touch this table. The browser learns which
-- versions it has accepted from GET /api/profile, never by reading here.
ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;
