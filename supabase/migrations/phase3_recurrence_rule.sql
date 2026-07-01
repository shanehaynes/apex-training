-- ============================================================
-- PHASE 3: CANONICAL RECURRENCE RULE
-- Run this in your Supabase project's SQL editor.
--
-- Adds workout_events.recurrence_rule: a single RFC 5545 RRULE value
-- string (no 'RRULE:' prefix), e.g. 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231'.
-- This is now the single source of truth for a recurring event's pattern —
-- parsed/validated/expanded by src/lib/recurrence/.
--
-- recurring_frequency, recurring_days, recurring_end_date are DEPRECATED:
-- left in place for rollback safety, no longer read by new code (a runtime
-- fallback derives a rule from them only when recurrence_rule is NULL).
-- Do not drop them in this migration.
-- ============================================================

ALTER TABLE workout_events ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;

COMMENT ON COLUMN workout_events.recurrence_rule IS
  'Canonical RFC 5545 RRULE value (no RRULE: prefix). Supported subset: FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY (weekly), BYMONTHDAY (monthly), COUNT xor UNTIL. Floating dates only — no Z/TZID.';
COMMENT ON COLUMN workout_events.recurring_frequency IS 'DEPRECATED — superseded by recurrence_rule.';
COMMENT ON COLUMN workout_events.recurring_days      IS 'DEPRECATED — superseded by recurrence_rule.';
COMMENT ON COLUMN workout_events.recurring_end_date  IS 'DEPRECATED — superseded by recurrence_rule.';

-- Backfill daily-recurring rows (the only pattern in real data to date).
UPDATE workout_events
SET recurrence_rule = 'FREQ=DAILY' ||
  CASE WHEN recurring_end_date IS NOT NULL
       THEN ';UNTIL=' || to_char(recurring_end_date, 'YYYYMMDD')
       ELSE '' END
WHERE is_recurring = true
  AND recurring_frequency = 'daily'
  AND recurrence_rule IS NULL;

-- Backfill any weekly rows (schema-legal; none known in real data, but the
-- recurring_days column exists for exactly this — 0=Sun … 6=Sat).
UPDATE workout_events
SET recurrence_rule = 'FREQ=WEEKLY' ||
  CASE WHEN recurring_days IS NOT NULL AND array_length(recurring_days, 1) > 0
       THEN ';BYDAY=' || (
         SELECT string_agg((ARRAY['SU','MO','TU','WE','TH','FR','SA'])[d + 1], ',' ORDER BY ord)
         FROM unnest(recurring_days) WITH ORDINALITY AS t(d, ord)
       )
       ELSE '' END ||
  CASE WHEN recurring_end_date IS NOT NULL
       THEN ';UNTIL=' || to_char(recurring_end_date, 'YYYYMMDD')
       ELSE '' END
WHERE is_recurring = true
  AND recurring_frequency = 'weekly'
  AND recurrence_rule IS NULL;

-- 'custom' rows (if any ever existed) are intentionally NOT backfilled:
-- the value is meaningless and the old code never expanded it either.
-- They remain is_recurring with a NULL rule and render as single events.
