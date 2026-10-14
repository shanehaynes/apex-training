-- Phase 56: the migration ledger — production records which migrations ran.
--
-- WHY THIS EXISTS
-- Production migrations are pasted into the Supabase SQL Editor by hand, and
-- nothing records which ones were. scripts/prod-schema-check.mjs infers it from
-- the objects it can see through PostgREST, which works for tables, columns and
-- functions, and is blind to triggers, RLS policies, grants, constraints,
-- defaults and the realtime publication. A migration that only changes those
-- could sit unapplied forever with every check green. On 2026-10-14 two older
-- migrations turned out to be missing only while a new one was being applied.
--
-- So every migration from this one on ends with one statement that stamps its
-- own name here:
--
--   insert into public.migration_ledger (name) values ('<file name without .sql>') on conflict do nothing;
--
-- It is the LAST statement, so it runs only when everything above it did: a
-- paste that stops at an error leaves no stamp. prod-schema-check.mjs reads this
-- table and names every migration on main with no stamp, whatever the
-- migration changes. scripts/__tests__/migration-ledger.test.ts fails a
-- migration that does not end with its own stamp.
--
-- The backfill below stamps phase2 through phase55, which predate the ledger.
-- That is an assertion, not evidence: on 2026-10-14 the schema check found
-- every table, column and function they create, and nothing can prove their
-- policies, triggers and grants after the fact. applied_at for those rows is
-- the moment this file runs, not when each was applied.
--
-- GRANTS: the live_activity_tokens (phase52) posture. RLS on with no policies;
-- revoke everything from anon and authenticated (default privileges hand them
-- REFERENCES, TRIGGER and TRUNCATE, which rls-coverage.integration.test.ts fails
-- on); service_role reads it for the schema check. Stamps are written by
-- whoever runs the migration, as postgres in the SQL Editor.
--
-- Idempotent: if not exists, and every insert is on conflict do nothing, so a
-- re-run changes nothing.

create table if not exists public.migration_ledger (
  -- The migration file name without .sql, e.g. phase56_migration_ledger.
  name       text        primary key,
  applied_at timestamptz not null default now()
);

alter table public.migration_ledger enable row level security;

revoke all on table public.migration_ledger from anon, authenticated;
grant select on table public.migration_ledger to service_role;

-- Backfill: the migrations that predate the ledger (see the header).
insert into public.migration_ledger (name) values
  ('phase2_events_tables'),
  ('phase3_enable_rls'),
  ('phase3_recurrence_rule'),
  ('phase4_workout_tracking'),
  ('phase5_coach_summary'),
  ('phase6_quick_complete'),
  ('phase7_occurrence_overrides'),
  ('phase8_exercise_definitions'),
  ('phase9_multi_user'),
  ('phase10_rls_lockdown'),
  ('phase11_user_api_keys'),
  ('phase12_reviews'),
  ('phase13_avatars'),
  ('phase14_avatars'),
  ('phase15_cat_cow_single_duration'),
  ('phase16_coach_profile_fields'),
  ('phase17_outdoor_climbing'),
  ('phase18_rate_limits'),
  ('phase19_training_blocks'),
  ('phase21_arc_duration_face_pull_reps'),
  ('phase22_meals'),
  ('phase23_meal_coach'),
  ('phase24_meal_favorites'),
  ('phase25_events_user_pk'),
  ('phase26_mcp_tokens'),
  ('phase27_provider_sync'),
  ('phase28_oauth_server'),
  ('phase29_auto_sync'),
  ('phase30_onboarding'),
  ('phase31_concurrency'),
  ('phase32_event_date_backfill'),
  ('phase33_workout_templates'),
  ('phase34_workout_scores'),
  ('phase35_analytics'),
  ('phase37_workout_sport'),
  ('phase38_coach_model'),
  ('phase39_terms_acceptance'),
  ('phase40_realtime_schedule_tables'),
  ('phase41_provider_client'),
  ('phase42_phase32_quarantine_rls'),
  ('phase43_completion_log_unique'),
  ('phase44_data_api_grants'),
  ('phase45_coach_runs'),
  ('phase46_coach_conversations'),
  ('phase47_tips_seen'),
  ('phase48_coach_memory'),
  ('phase49_coach_annotations'),
  ('phase50_coach_contract'),
  ('phase51_coach_planner_mode'),
  ('phase52_live_activity_tokens'),
  ('phase53_definition_log_fields'),
  ('phase54_workout_exercise_notes'),
  ('phase55_core_loop_columns')
on conflict do nothing;

notify pgrst, 'reload schema';

insert into public.migration_ledger (name) values ('phase56_migration_ledger') on conflict do nothing;
