-- Phase 59: Apple Health on the provider-sync rails (W16 M0, D-056).
--
-- WHY THIS EXISTS
-- W16 brings Apple Health in as a second provider. The phone is the provider:
-- it reads Health and posts what it read through /api/provider-sync as
-- provider 'apple' (M2b), on the rails COROS built (phase27) — the same
-- connection row, import ledger, match and fill. Daily metrics (sleep, HRV,
-- resting HR, steps, body mass) are not activities, so they get a table of
-- their own that the coach's physiology block reads (M3b). One migration for
-- both milestones, so production takes one paste and the generated types move
-- once (docs/ios/workstreams/W16-apple-health.md, M0).
--
-- WHAT CHANGES
--   provider_connections.provider   CHECK widened to ('coros','apple')
--   provider_connections.categories new: which Health categories the athlete
--                                   switched on, one opt-in each (D-056); keys
--                                   are allowlisted in the handler, the phase41
--                                   posture. '{}' for COROS rows: nothing changes.
--   provider_activity_imports.mode  CHECK gains 'skipped': "Don't import" on a
--                                   Health workout is recorded so it is never
--                                   offered again.
--   daily_metrics                   new, one row per (user, local date, provider)
--   profiles.body_weight_updated_at new: when body_weight_lb was last set, so a
--   profiles.body_weight_source     Health sample only overwrites an older value
--                                   and never a newer manual one (M3b); 'user' |
--                                   'apple'. Weights entered before this are
--                                   stamped 'user' as of the row's updated_at.
--
-- ORDER: migration FIRST, code SECOND. Nothing reads any of this until M2b and
-- M3b, except the account export, which reads daily_metrics the moment this
-- PR deploys (it is in USER_DATA_TABLES) — so the table must exist in
-- production before the code lands. Every change here is additive or widens a
-- CHECK, so it is safe ahead of the code and safe to re-run.
--
-- GRANTS: daily_metrics is the phase52 posture verbatim — RLS on with no
-- policies, every privilege revoked from anon and authenticated (default
-- privileges hand them REFERENCES, TRIGGER and TRUNCATE, which
-- rls-coverage.integration.test.ts fails on), service_role the four verbs.
-- The API, scoped by user_id on every query, is the only door; the table is
-- not in the realtime publication. The two existing tables keep their grants.

-- ------------------------------------------------------------
-- provider_connections: a second provider, and its categories
-- ------------------------------------------------------------

-- The inline CHECK from phase27 took Postgres's default name.
alter table public.provider_connections
  drop constraint if exists provider_connections_provider_check;
alter table public.provider_connections
  add constraint provider_connections_provider_check check (provider in ('coros', 'apple'));

alter table public.provider_connections
  add column if not exists categories jsonb not null default '{}'::jsonb;
alter table public.provider_connections
  drop constraint if exists provider_connections_categories_check;
alter table public.provider_connections
  add constraint provider_connections_categories_check check (jsonb_typeof(categories) = 'object');
comment on column public.provider_connections.categories is
  'Apple Health opt-ins by category (workoutsWrite, workoutsRead, dailyMetrics, bodyMass, mealsWrite); keys allowlisted in the handler; {} for COROS';

-- ------------------------------------------------------------
-- provider_activity_imports: a declined import is remembered
-- ------------------------------------------------------------

alter table public.provider_activity_imports
  drop constraint if exists provider_activity_imports_mode_check;
alter table public.provider_activity_imports
  add constraint provider_activity_imports_mode_check check (mode in ('created', 'filled', 'skipped'));

-- ------------------------------------------------------------
-- daily_metrics: what Health says about a day
-- ------------------------------------------------------------

create table if not exists daily_metrics (
  -- Cascades, so a deleted account takes its metrics with it. Also listed in
  -- USER_DATA_TABLES (api/_lib/handlers/account.ts) for the export and sweep.
  user_id        uuid        not null references auth.users (id) on delete cascade,
  -- The athlete's local calendar day the phone summarised.
  date           date        not null,
  provider       text        not null check (provider in ('apple')),
  sleep_minutes  integer     check (sleep_minutes between 0 and 1440),
  -- { core, deep, rem, awake } minutes, as Health stages them.
  sleep_stages   jsonb       check (sleep_stages is null or jsonb_typeof(sleep_stages) = 'object'),
  sleep_start    timestamptz,
  sleep_end      timestamptz,
  hrv_sdnn_ms    numeric     check (hrv_sdnn_ms > 0),
  resting_hr     integer     check (resting_hr between 20 and 250),
  steps          integer     check (steps >= 0),
  body_mass_lb   numeric     check (body_mass_lb > 0),
  body_mass_at   timestamptz,
  -- Which device or app each value came from (the Health source names).
  sources        jsonb       check (sources is null or jsonb_typeof(sources) = 'object'),
  updated_at     timestamptz not null default now(),
  primary key (user_id, date, provider)
);

alter table daily_metrics enable row level security;

revoke all on table public.daily_metrics from anon, authenticated;
grant select, insert, update, delete on table public.daily_metrics to service_role;

-- ------------------------------------------------------------
-- profiles: where the body weight came from, and when
-- ------------------------------------------------------------

alter table public.profiles add column if not exists body_weight_updated_at timestamptz null;
alter table public.profiles add column if not exists body_weight_source text null;
alter table public.profiles drop constraint if exists profiles_body_weight_source_check;
alter table public.profiles add constraint profiles_body_weight_source_check
  check (body_weight_source is null or body_weight_source in ('user', 'apple'));
comment on column public.profiles.body_weight_source is
  'Who last set body_weight_lb: user (Profile, PATCH /api/profile) or apple (Health, only from a newer sample); null = no body weight';

-- A body weight entered before this migration has no instant to compare a
-- Health sample against, and M3b writes a sample only when it is newer than
-- body_weight_updated_at. Stamp those weights as the athlete's own, as of
-- the row's last update — an upper bound on when the weight was typed — so a
-- newer Health reading still lands and an older backfilled one does not.
-- Idempotent: only rows still unstamped.
update public.profiles
   set body_weight_updated_at = coalesce(updated_at, now()),
       body_weight_source = 'user'
 where body_weight_lb is not null
   and body_weight_updated_at is null;

notify pgrst, 'reload schema';


insert into public.migration_ledger (name, fingerprint) values ('phase59_apple_health', '90bbae06e64016b1') on conflict do nothing;
