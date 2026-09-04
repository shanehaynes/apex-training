-- Phase 40: put every table a client subscribes to in the supabase_realtime
-- publication.
--
-- WHY THIS EXISTS
-- The web (src/context/ScheduleContext.tsx) and the iOS app (ApexAuth.RealtimeHub)
-- both subscribe to postgres_changes on the schedule tables. A table that is
-- not in the publication never delivers: the channel subscribes happily and
-- stays silent, and the writing device self-corrects through its own refresh,
-- so the omission hides. Until now only training_blocks and objectives were
-- added by a migration (phase19); the four schedule tables were in production's
-- publication through dashboard state only, and a fresh local stack had none
-- of them — which is why local realtime never worked and nothing noticed.
--
-- workout_completions is new here: neither client subscribed to it before, so
-- a completion toggled on one device did not reach another until a reload.
-- iOS subscribes to it from W2 (docs/ios/workstreams/W02-schedule-read.md).
--
-- meals, meal_favorites and analytics_tiles are the web's other channels
-- (MealsContext, AnalyticsContext), likewise members in production by
-- dashboard state only. They matter beyond completeness: Realtime answers a
-- channel join with ONE verdict for all of its postgres_changes bindings, so
-- a single table missing from the publication silently voids every other
-- binding on that channel. A fresh local stack must carry the full set.
--
-- Idempotent: ADD TABLE errors if the table is already a member, so every
-- table is checked first. Safe to run against production, where the first
-- four are expected to be members already.
-- ------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication not found — skipping realtime setup';
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'workout_events',
    'recurring_exceptions',
    'exercise_definitions',
    'workout_templates',
    'workout_completions',
    'meals',
    'meal_favorites',
    'analytics_tiles'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END
$$;
