-- ============================================================
-- APEX TRAINING — Phase 31 Migration: concurrency prep
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run BEFORE deploying the phase31 code — it is inert for the
-- currently deployed code (nothing calls last_performed_by_name yet).
-- Prep for concurrent multi-user load: makes RLS evaluate once per
-- query instead of once per row, indexes the predicates the tracker
-- and library actually filter on, and adds the aggregate that
-- replaces two 10k-row drains.
--
-- Note this is NOT connection pooling — every read and write here is
-- an HTTPS request to PostgREST, so there is no app-side Postgres
-- connection to pool. The cost that scales with users is rows on the
-- wire, which is what this migration attacks.
-- ============================================================

-- ------------------------------------------------------------
-- 1) RLS: evaluate auth.uid() once, not once per row
--
-- Bare `auth.uid() = user_id` is re-evaluated for every candidate
-- row. Wrapping it in a subquery makes the planner hoist it into an
-- InitPlan evaluated a single time — the difference shows up on the
-- 10k+ row scans in workout_set_logs / workout_cardio_logs.
--
-- ALTER POLICY rather than DROP + CREATE: it preserves the name,
-- role and command, and there is never an instant where the table
-- sits unprotected. All 13 are FOR SELECT with no WITH CHECK clause,
-- so USING is the whole policy. (The legacy anon_select_* policies
-- were already dropped in phase10.)
-- ------------------------------------------------------------

-- profiles keys on `id`, not `user_id` — the one exception.
ALTER POLICY user_select_own_profile           ON profiles             USING ((select auth.uid()) = id);

ALTER POLICY user_select_workout_events        ON workout_events       USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_recurring_exceptions  ON recurring_exceptions USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_workout_completions   ON workout_completions  USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_workout_sessions      ON workout_sessions     USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_workout_set_logs      ON workout_set_logs     USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_workout_cardio_logs   ON workout_cardio_logs  USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_exercise_definitions  ON exercise_definitions USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_objectives            ON objectives           USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_training_blocks       ON training_blocks      USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_own_meals             ON meals                USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_own_meal_favorites    ON meal_favorites       USING ((select auth.uid()) = user_id);
ALTER POLICY user_select_own_activity_streams  ON activity_streams     USING ((select auth.uid()) = user_id);

-- ------------------------------------------------------------
-- 2) Indexes for predicates that had none
-- ------------------------------------------------------------

-- exercise_name is the LEADING predicate in the .in('exercise_name', spellings)
-- history fetches (src/lib/tracking/sessionRepo.ts, src/lib/library/repo.ts)
-- and had no index at all — every tracker open scanned the user's partition.
-- event_date DESC matches the `.order('event_date', { ascending: false })`
-- those same queries apply.
CREATE INDEX IF NOT EXISTS idx_wsl_user_name_date
  ON workout_set_logs (user_id, exercise_name, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_wclg_user_name_date
  ON workout_cardio_logs (user_id, exercise_name, event_date DESC);

-- PK is (user_id, event_id), but every read filters by date range
-- (reviewData.ts, mcp/data.ts, blocks/repo.ts).
CREATE INDEX IF NOT EXISTS idx_wc_user_date
  ON workout_completions (user_id, event_date);

-- phase25 gave the other three mutation logs (user_id, logged_at DESC);
-- meal_mutations_log was missed, but the AI mutation cap queries it exactly
-- that way (api/_lib/rateLimit.ts).
CREATE INDEX IF NOT EXISTS idx_mml_user_time
  ON meal_mutations_log (user_id, logged_at DESC);

-- ------------------------------------------------------------
-- 3) last_performed_by_name — the library's "last performed" column
--
-- Replaces two .limit(10000) drains (up to 20k rows shipped to the
-- browser on every library mount, and the same again inside the MCP
-- search_exercises tool) with one row per exercise per table.
--
-- Safe to push into SQL because this is a pure max() fold: it never
-- touches the free-text weight/reps parser, which stays in TypeScript
-- as the single source of truth. lastPerformedByCanonical() already
-- takes the max across duplicate names, so UNION ALL needs no dedupe.
--
-- SECURITY INVOKER is deliberate. The browser calls this on the anon
-- client, where RLS must still apply — fetchLastPerformedRows passes
-- no user filter of its own and relies entirely on RLS. A caller
-- passing someone else's id gets zero rows regardless, because RLS on
-- the underlying tables still applies. The service-role MCP caller
-- bypasses RLS and passes its own token-verified userId, the same
-- posture as every other admin query.
--
-- p_user_id defaults to auth.uid() so the browser can call this with no
-- argument at all, exactly like the plain selects it replaces. A
-- service-role caller that omits it gets auth.uid() = NULL and so zero
-- rows — the safe direction to fail.
--
-- Table aliases are required: unqualified column names would be
-- ambiguous against the RETURNS TABLE output names.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION last_performed_by_name(p_user_id UUID DEFAULT NULL)
RETURNS TABLE (exercise_name TEXT, event_date DATE)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH target AS (SELECT coalesce(p_user_id, auth.uid()) AS uid)
  SELECT l.exercise_name, max(l.event_date)
    FROM workout_set_logs l
   WHERE l.user_id = (SELECT uid FROM target) AND l.is_autofilled = false
   GROUP BY l.exercise_name
  UNION ALL
  SELECT c.exercise_name, max(c.event_date)
    FROM workout_cardio_logs c
   WHERE c.user_id = (SELECT uid FROM target) AND c.is_autofilled = false
   GROUP BY c.exercise_name;
$$;

-- Explicit rather than relying on the default PUBLIC execute grant:
-- this is the first function the browser calls directly.
GRANT EXECUTE ON FUNCTION last_performed_by_name(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 4) Verification — both should return zero rows
-- ------------------------------------------------------------

-- Any SELECT policy still using the per-row form. ILIKE, not LIKE:
-- Postgres re-deparses the stored expression, so `(select auth.uid())`
-- comes back as `( SELECT auth.uid() AS uid)` — a case-sensitive match
-- reports every rewritten policy as a failure.
--   SELECT policyname, tablename FROM pg_policies
--    WHERE schemaname = 'public'
--      AND qual ILIKE '%auth.uid()%'
--      AND qual NOT ILIKE '%select auth.uid()%';

-- Any expected index missing:
--   SELECT unnest(ARRAY['idx_wsl_user_name_date','idx_wclg_user_name_date',
--                       'idx_wc_user_date','idx_mml_user_time']) AS idx
--   EXCEPT SELECT indexname FROM pg_indexes WHERE schemaname = 'public';
