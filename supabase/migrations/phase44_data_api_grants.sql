-- Phase 44: explicit Data API grants.
--
-- WHY THIS EXISTS
-- supabase/config.toml set auto_expose_new_tables = true, which makes the CLI
-- issue
--   alter default privileges for role postgres in schema public
--     grant all on tables to anon, authenticated, service_role;
-- so every table a migration created was, from the moment of its create table,
-- selectable, insertable, updatable and deletable by anyone holding the
-- publishable anon key — which ships in the web bundle. Row-level security was
-- the only thing in the way, and phase42 is the record of what that costs when
-- RLS is the thing that gets forgotten: phase32_quarantine shipped with
-- relrowsecurity off and anon holding SELECT, INSERT and DELETE on whole
-- workout rows across every user. The same commit as this migration flips the
-- flag off (the field is removed upstream on 2026-10-30 in any case, when the
-- always-revoked behaviour becomes permanent). With it off, nothing is exposed
-- that is not named here.
--
-- WHO GETS WHAT
--   service_role   the API's key. Reads and writes everything and bypasses RLS;
--                  every mutation in this app goes through /api/*.
--   authenticated  SELECT only, and only on the tables a signed-in web or iOS
--                  client reads through PostgREST or subscribes to through
--                  realtime. These are exactly the tables with a SELECT policy
--                  — a grant without a policy reads nothing, and a policy
--                  without a grant is a 401 rather than a filter.
--   anon           nothing. It exists to sign in, and GoTrue lives in `auth`.
--
-- REVOKE before GRANT, so the end state does not depend on whether the default
-- privileges ever fired: the same on a stack started before the flip as on one
-- started after, and the same in production, which has no config.toml. Safe to
-- re-run.
--
-- NEW TABLES FROM HERE ON ARRIVE WITH NO GRANTS AT ALL. Add the ones a client
-- reads to the authenticated list, and every one to the service_role list, in
-- the migration that creates them — otherwise the API 401s on the new table.
-- api/__tests__/integration/rls-coverage.integration.test.ts fails CI's full
-- job if a policy, an RLS setting or a client-role write grant drifts.

-- ── clear whatever the default privileges left behind ───────────────────────
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ── the API ────────────────────────────────────────────────────────────────
-- Not REFERENCES, TRIGGER or TRUNCATE: the service role reads and writes rows,
-- it does not change the schema.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ── signed-in clients, read only ───────────────────────────────────────────
-- src/context/*.tsx and src/lib/*/repo.ts read these through supabase-js;
-- ios/Packages/ApexKit reads activity_streams and subscribes to the realtime
-- set (RealtimeHub.swift). Every one of them has a user_select_* SELECT policy.
grant select on table
  public.activity_streams,
  public.analytics_tiles,
  public.exercise_definitions,
  public.meal_favorites,
  public.meals,
  public.objectives,
  public.profiles,
  public.recurring_exceptions,
  public.training_blocks,
  public.workout_cardio_logs,
  public.workout_completions,
  public.workout_events,
  public.workout_sessions,
  public.workout_set_logs,
  public.workout_templates
to authenticated;

-- ── functions ──────────────────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC on every new function, so these are
-- reachable over /rest/v1/rpc with the anon key no matter what the CLI does.
-- bump_rate_limit is SECURITY DEFINER and writes api_request_counts, so an
-- anonymous caller can inflate any user's rate-limit window: only the API,
-- which is the only caller (api/_lib/rateLimit.ts), needs it.
revoke all on function public.bump_rate_limit(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.bump_rate_limit(uuid, text, integer) to service_role;

-- last_performed_by_name stays reachable by signed-in clients
-- (src/lib/library/repo.ts calls it). It is SECURITY INVOKER, so it sees only
-- what the caller's own SELECT policies allow.
revoke all on function public.last_performed_by_name(uuid) from public, anon;
grant execute on function public.last_performed_by_name(uuid) to authenticated, service_role;
