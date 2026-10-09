-- Phase 52: live_activity_tokens.
--
-- WHY THIS EXISTS
-- The iOS tracker shows a Live Activity (the Lock Screen card and the Dynamic
-- Island timer, W12). The app ends it when the workout finishes on the phone,
-- and since #383 it ends it after a schedule refresh when the workout was
-- finished anywhere else. A refresh needs the app running, though, and the
-- card matters most on a locked phone with the app suspended. ActivityKit's
-- answer is a push: the activity is requested with `pushType: .token`, the
-- system hands the app a per-activity APNs token, and the server sends an
-- `end` event to that token. This table is where the server keeps them.
--
-- WHO WRITES
-- /api/live-activity-tokens (api/_lib/handlers/liveActivityTokens.ts): the app
-- POSTs each token the system issues (one activity can be issued several over
-- its life) and DELETEs the session's rows when it ends the activity itself.
-- api/_lib/services/liveActivity.ts reads them when a session is finished or
-- cancelled, or its occurrence marked complete, sends the `end`, and deletes
-- the rows it sent to. A row is useless after the activity ends, so nothing
-- here is history: the register path also sweeps this user's rows older than
-- a day, past the longest an activity can stay on screen (8 h live + 4 h ended).
--
-- KEYS
-- (event_id, event_date) is the tracker session key — event_id is the
-- occurrence id, the same pair workout_sessions and the app's SessionKey use.
-- push_token is unique on its own: APNs mints it per activity, and an upsert
-- on it is what keeps a re-registered token one row.
--
-- environment says which APNs host the token belongs to: a build signed with
-- a development profile gets sandbox tokens, TestFlight and the App Store get
-- production ones, and a token sent to the wrong host is rejected.
--
-- ORDER: migration FIRST, code SECOND. The register call is fire-and-forget on
-- the phone and the sender only reads this table when APNs is configured, so
-- code running ahead of the table logs an error and the card falls back to
-- the app-side end.
--
-- GRANTS: the coach_annotations (phase49) posture. Default privileges hand
-- anon and authenticated REFERENCES, TRIGGER and TRUNCATE on every new table,
-- which rls-coverage.integration.test.ts fails on, so revoke from both and
-- grant service_role the four verbs. RLS on with no policies: the API
-- (service_role, scoped by user_id on every query) is the only door, and the
-- table is not in the realtime publication.

create table if not exists live_activity_tokens (
  id           uuid        primary key default gen_random_uuid(),
  -- Cascades, so a deleted account takes its tokens with it. Also listed in
  -- USER_DATA_TABLES (api/_lib/handlers/account.ts) for the sweep.
  user_id      uuid        not null references auth.users (id) on delete cascade,
  event_id     text        not null,
  event_date   date        not null,
  -- Hex, as ActivityKit's `pushToken` Data is conventionally sent. APNs tokens
  -- are 32 bytes today and Apple says not to rely on the length, so the bound
  -- is generous rather than exact.
  push_token   text        not null unique check (push_token ~ '^[0-9a-f]{16,400}$'),
  environment  text        not null check (environment in ('sandbox','production')),
  -- When the session started, as the app's activity has it: the `end` push
  -- carries a content state the widget decodes, and it needs the same start
  -- the card was drawing from.
  started_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

-- The sender's read: this user's tokens for one session.
create index if not exists idx_live_activity_tokens_session
  on live_activity_tokens (user_id, event_id, event_date);

alter table live_activity_tokens enable row level security;

revoke all on table public.live_activity_tokens from anon, authenticated;
grant select, insert, update, delete on table public.live_activity_tokens to service_role;

notify pgrst, 'reload schema';
