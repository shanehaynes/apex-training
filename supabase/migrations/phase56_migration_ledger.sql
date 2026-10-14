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
-- own name and a fingerprint of its SQL here:
--
--   insert into public.migration_ledger (name, fingerprint) values ('<file without .sql>', '<16 hex>') on conflict do nothing;
--
-- `node scripts/prod-schema-check.mjs --stamp <file>` prints that line. The
-- fingerprint is a hash of the file's statements with comments and whitespace
-- ignored, so an edit to a migration production already ran reads as edited,
-- not applied (2463cf7e once changed a function signature inside phase31).
--
-- It is the LAST statement, so it runs only when everything above it did: a
-- paste that stops at an error leaves no stamp. prod-schema-check.mjs reads this
-- table and names every migration on main that production has not applied as
-- written, whatever the migration changes. scripts/__tests__/migration-ledger.test.ts
-- fails a migration that does not end with its own stamp, and an edit to a
-- backfilled one.
--
-- The backfill below stamps phase2 through phase55, which predate the ledger,
-- with the fingerprint of each file as it stands today. That is an assertion,
-- not evidence: on 2026-10-14 the schema check found
-- every table, column and function they create, and nothing can prove their
-- policies, triggers and grants after the fact. applied_at for those rows is
-- the moment this file runs, not when each was applied.
--
-- GRANTS: RLS on with no policies; revoke everything from anon and
-- authenticated (default privileges hand them REFERENCES, TRIGGER and TRUNCATE,
-- which rls-coverage.integration.test.ts fails on) AND from service_role, which
-- default privileges hand every verb. The API key only ever reads the ledger,
-- for the schema check; a key that could write it could forge or erase stamps.
-- Stamps are written by whoever runs the migration, as postgres in the SQL Editor.
--
-- Idempotent: if not exists, and every insert is on conflict do nothing, so a
-- re-run changes nothing.

create table if not exists public.migration_ledger (
  -- The migration file name without .sql, e.g. phase56_migration_ledger.
  name        text        not null,
  -- sha256 of the file's statements (comments and whitespace ignored, its own
  -- stamp excluded), first 16 hex characters. A re-applied edit is a new row.
  fingerprint text        not null check (fingerprint ~ '^[0-9a-f]{16}$'),
  applied_at  timestamptz not null default now(),
  primary key (name, fingerprint)
);

alter table public.migration_ledger enable row level security;

revoke all on table public.migration_ledger from anon, authenticated, service_role;
grant select on table public.migration_ledger to service_role;

-- Backfill: the migrations that predate the ledger (see the header).
insert into public.migration_ledger (name, fingerprint) values
  ('phase2_events_tables', 'c1f6f2bcc3bd7ccd'),
  ('phase3_enable_rls', 'dd5ac09c706d64e8'),
  ('phase3_recurrence_rule', 'ab1facb01f456821'),
  ('phase4_workout_tracking', '2265a1234fee74cf'),
  ('phase5_coach_summary', '2107bacfc6a62d0f'),
  ('phase6_quick_complete', '8921d64ee4b8cb49'),
  ('phase7_occurrence_overrides', '92cc45239bcc9271'),
  ('phase8_exercise_definitions', '8a009e1e8cbbc3fe'),
  ('phase9_multi_user', '9a7d5a2928412142'),
  ('phase10_rls_lockdown', '0126399789e82dab'),
  ('phase11_user_api_keys', 'f0bdee2b9079c09e'),
  ('phase12_reviews', '93420c26a9341764'),
  ('phase13_avatars', '0a8ccb3af64d9b4a'),
  ('phase14_avatars', '1812d3dc33e7a0ce'),
  ('phase15_cat_cow_single_duration', '1fcf48bdacdfa5f4'),
  ('phase16_coach_profile_fields', 'cabfb66ceaa38fc2'),
  ('phase17_outdoor_climbing', '4f3b13ed6808e342'),
  ('phase18_rate_limits', '661e27d3447f602d'),
  ('phase19_training_blocks', '1eb7063412e44d79'),
  ('phase21_arc_duration_face_pull_reps', '0d20c6c802258607'),
  ('phase22_meals', '73c28ba20c6b51f2'),
  ('phase23_meal_coach', 'e8ac261ea89e1708'),
  ('phase24_meal_favorites', '658e32804afe4641'),
  ('phase25_events_user_pk', 'b3973f87ce3e523a'),
  ('phase26_mcp_tokens', 'e1a4adf6f4f5c4d3'),
  ('phase27_provider_sync', '171beafe6a0aae8d'),
  ('phase28_oauth_server', 'c94be1017881c2b7'),
  ('phase29_auto_sync', '7256f85c437baa53'),
  ('phase30_onboarding', '0eb08e5622909269'),
  ('phase31_concurrency', '7aca46d010172938'),
  ('phase32_event_date_backfill', '109a955cfc26dd09'),
  ('phase33_workout_templates', '690f4cbdcc6c0242'),
  ('phase34_workout_scores', 'c7bdce4b0682db28'),
  ('phase35_analytics', 'd38b8657dfdaea52'),
  ('phase37_workout_sport', '673ecb49aa79eeda'),
  ('phase38_coach_model', 'beea7e4218282f5f'),
  ('phase39_terms_acceptance', '371c3e3a9afd1d51'),
  ('phase40_realtime_schedule_tables', '93d83772cf04dd41'),
  ('phase41_provider_client', 'fe13cd0204bce169'),
  ('phase42_phase32_quarantine_rls', '0b08aebba3aa59f0'),
  ('phase43_completion_log_unique', 'd2a4d2639838890e'),
  ('phase44_data_api_grants', 'b27fd9692cbef8ee'),
  ('phase45_coach_runs', '8574dd94f480c9f5'),
  ('phase46_coach_conversations', '160edef321c0f8b0'),
  ('phase47_tips_seen', '38d4c071f469733d'),
  ('phase48_coach_memory', '80bd237acc4c53d3'),
  ('phase49_coach_annotations', '01ab395192e6e047'),
  ('phase50_coach_contract', '61655a299e360027'),
  ('phase51_coach_planner_mode', '00849f0fd996ba16'),
  ('phase52_live_activity_tokens', 'f3962f526560b0a2'),
  ('phase53_definition_log_fields', 'e5d3aa0b6541f8b4'),
  ('phase54_workout_exercise_notes', 'c8c7adedc42d393f'),
  ('phase55_core_loop_columns', 'e0ccdbb21dfd9047')
on conflict do nothing;

notify pgrst, 'reload schema';

insert into public.migration_ledger (name, fingerprint) values ('phase56_migration_ledger', 'd5918ba825fda268') on conflict do nothing;
