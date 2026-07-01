-- ============================================================
-- APEX TRAINING — Phase 3 Migration: Enable RLS, lock down anon key
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- The anon key is public (shipped in the client JS bundle), so RLS is what
-- actually restricts what it can do. All writes now go through service-role
-- backed /api/* endpoints — the anon key is read-only from here on.
-- ============================================================

ALTER TABLE workout_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_exceptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_completions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_completion_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_mutations_log    ENABLE ROW LEVEL SECURITY;

-- anon needs read-only access to the tables the client queries directly:
-- loadEvents() reads workout_events + recurring_exceptions, the completion
-- sync effect reads workout_completions, and Realtime postgres_changes
-- subscriptions are authorized against these same SELECT policies.

CREATE POLICY anon_select_workout_events
  ON workout_events FOR SELECT
  TO anon
  USING (true);

CREATE POLICY anon_select_recurring_exceptions
  ON recurring_exceptions FOR SELECT
  TO anon
  USING (true);

CREATE POLICY anon_select_workout_completions
  ON workout_completions FOR SELECT
  TO anon
  USING (true);

-- workout_completion_log and event_mutations_log are append-only audit logs
-- the client never reads. No policies for them means RLS defaults to deny
-- for anon — that's intentional, not an oversight.

-- No INSERT/UPDATE/DELETE policy for anon on any table — that's what closes
-- the hole. service_role (used by /api/* serverless functions) bypasses RLS
-- entirely by default and needs no explicit policies.
