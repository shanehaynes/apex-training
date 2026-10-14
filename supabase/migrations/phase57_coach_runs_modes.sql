-- Phase 57: coach_runs records every server-side model call, not only chat.
--
-- WHY THIS EXISTS
-- coach_runs (phase45) is the only per-user record of model spend, and until
-- now only api/chat.ts wrote it. The post-workout summary, the nightly
-- reflection, the monthly/yearly recap and the weekly review all call
-- Anthropic on the athlete's own key and left no row, so any per-user spend
-- figure or token budget built on this table would undercount. Those surfaces
-- now write one row per model call, and `mode` names the surface:
--
--   summary     api/_lib/handlers/coachSummary.ts (post-workout summary)
--   reflection  api/_lib/handlers/reflectionCron.ts (nightly, up to 2 calls per athlete-day)
--   recap       api/review-cron.ts (monthly / yearly review commentary)
--   weekly      the weekly review — added here so its instrumentation needs
--               no second migration; nothing writes it until that lands
--
-- 'planner' (phase51) stays: dropping it would reject every planner turn.
--
-- The privacy posture is unchanged and still the point of the table: counts,
-- timings, identifiers and an error message. No prompt text, no message
-- content, no key material. prompt_version for these surfaces is a hash of
-- the static system prompt, never the prompt itself.
--
-- ORDER: run this migration FIRST, deploy the code SECOND. Against the old
-- CHECK the new rows fail with 23514; recordCoachRun is fail-open, so a
-- reversed order loses rows, never a summary, recap or reflection.
--
-- Same constraint name as phase45 and phase51, so a re-run is a no-op
-- (`if exists`) and there is one constraint of that name on the table.

alter table public.coach_runs
  drop constraint if exists coach_runs_mode_check;
alter table public.coach_runs
  add constraint coach_runs_mode_check
  check (mode in ('chat','builder','analytics','planner','summary','weekly','reflection','recap'));

notify pgrst, 'reload schema';

insert into public.migration_ledger (name, fingerprint) values ('phase57_coach_runs_modes', 'd8b60ed7dd20ee99') on conflict do nothing;
