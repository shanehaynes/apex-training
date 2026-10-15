-- Phase 58: the athlete's time zone on the profile.
--
-- WHY THIS EXISTS
-- The server has no idea what day it is for the athlete. The web sends its
-- local "today" with every coach and analytics request, but the paths with no
-- browser behind them fall back to the UTC date: the MCP tools when a client
-- omits `today`, the nightly reflection (which read "yesterday" in UTC, so a
-- Pacific athlete's day was reflected on at 22:00 local, before it ended),
-- the starter-plan copy for clients that send no start date, and the
-- provider cron for a connection that never stamped a zone
-- (docs/improvements/03-platform-and-reach.md §4).
--
-- `timezone` is an IANA name ("America/New_York"), written by the web client
-- from Intl.DateTimeFormat whenever it differs from the stored one, and
-- validated by PATCH /api/profile. null = unknown; every reader falls back to
-- UTC, which is exactly today's behaviour, so the column is safe to apply
-- ahead of or behind the code.
--
-- RLS: profiles already carries own-row policies with table-level grants
-- (phase9 / phase44); a new column needs no policy or grant work.

alter table profiles add column if not exists timezone text null;
alter table profiles drop constraint if exists profiles_timezone_check;
alter table profiles add constraint profiles_timezone_check
  check (timezone is null or (length(timezone) between 1 and 64));
comment on column profiles.timezone is 'IANA time zone the athlete is in, from the web client; null = unknown (readers use UTC)';

notify pgrst, 'reload schema';

insert into public.migration_ledger (name, fingerprint) values ('phase58_profile_timezone', 'cf9d50265173d346') on conflict do nothing;
