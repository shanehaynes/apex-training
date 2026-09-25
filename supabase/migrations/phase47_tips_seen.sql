-- ============================================================
-- APEX TRAINING — Phase 47 Migration: tips_seen
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Inert for the currently deployed code: nothing reads or writes the
-- column until the onboarding-tips client ships, and that client
-- tolerates the column being absent. Safe to re-run.
-- ============================================================

-- Which progressive-onboarding tips (docs/onboarding/MASTER.md) this
-- account has dismissed: an object of tip id → ISO timestamp of the first
-- dismissal, e.g. {"day-complete-circle": "2026-09-24T12:00:00Z"}.
--
-- Server-side rather than localStorage alone, for the same reason as
-- onboarding_dismissed_at (phase30): a tip dismissed on the phone must not
-- come back on the laptop. Until this is applied in prod the client mirrors
-- "seen" to localStorage and only PATCHes when the column is present, so
-- nothing waits on this migration.
--
-- Stamped by /api/profile from `{ tip_seen: '<id>' }` — the client never
-- supplies the timestamp. No backfill: every existing account starts with
-- nothing seen, which is correct, since no tip has been shown yet.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tips_seen JSONB NOT NULL DEFAULT '{}'::jsonb;

-- An object, never an array or scalar, so a read-merge-write of one key
-- cannot silently replace the whole value with something else.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_tips_seen_object;
ALTER TABLE profiles ADD CONSTRAINT profiles_tips_seen_object CHECK (jsonb_typeof(tips_seen) = 'object');

COMMENT ON COLUMN profiles.tips_seen IS 'onboarding tip id -> ISO timestamp first dismissed; ids live in src/lib/onboarding/tips/';

-- profiles RLS is select-own (phase9) and its grants are table-level
-- (phase44), so the new column needs no policy or grant change.
