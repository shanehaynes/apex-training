-- ============================================================
-- APEX TRAINING — Phase 43 Migration: replay-safe completion log
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- ORDER: run this migration FIRST, deploy the code SECOND. The new code
-- emits ON CONFLICT (user_id, client_toggle_id), which is a 42P10 until the
-- index below exists; the deployed code writes fine against the new schema
-- (it just ignores the column), so migration-first is the safe order.
--
-- workout_completion_log is the append-only source of truth for analytics,
-- but /api/completions .insert()ed into it with no conflict target. The iOS
-- tracker enqueues the `.completion` op in a durable write queue
-- (ApexCore WriteQueue) and replays it until the server ACKs, so a lost
-- response appended a second, identical audit row — a double count for the
-- first feature that reads the table.
--
-- The replayed op cannot be recognised by its contents: it is byte-identical
-- to the original, and `logged_at` is stamped by its DEFAULT now() on every
-- insert (the column is in SERVER_STAMPED_COLUMNS precisely so a caller
-- cannot backdate history), so a unique key over (…, action, logged_at)
-- would never fire. Two genuine toggles of the same occurrence to the same
-- action — complete, uncomplete, complete — are likewise indistinguishable
-- from a replay by payload alone, so a key over (…, action) would silently
-- drop real history.
--
-- So the client mints the key: `client_toggle_id`, one UUID per toggle,
-- stored in the queued op and therefore identical across every replay of it
-- and different for every new toggle. It is opaque — nothing is read from it
-- and no ordering or timestamp is inferred from it — so a caller supplying
-- it gains no ability to forge history; the worst it can do is suppress its
-- own audit rows, which it could already do by not calling the endpoint.
--
-- NULL is allowed and never conflicts (Postgres treats NULLs as distinct in
-- a unique index). Every caller that goes through buildCompletionRows /
-- CompletionRows.build mints one, so in practice only ops already sitting in
-- an iOS write queue from a build older than this land NULL — they decode
-- with a nil id and keep the old at-least-once behaviour rather than
-- collapsing into each other.
--
-- user_id leads the conflict target, the invariant phase25 established.
-- ============================================================

ALTER TABLE workout_completion_log
  ADD COLUMN IF NOT EXISTS client_toggle_id UUID;

COMMENT ON COLUMN workout_completion_log.client_toggle_id IS
  'Client-minted id for one toggle, stable across write-queue replays. Dedupe key only — never read, ordered by, or trusted as a timestamp.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_wcl_user_toggle
  ON workout_completion_log (user_id, client_toggle_id);

-- PostgREST caches table shapes: without a reload the new column is rejected
-- as unknown and ON CONFLICT (user_id, client_toggle_id) cannot be inferred.
NOTIFY pgrst, 'reload schema';
