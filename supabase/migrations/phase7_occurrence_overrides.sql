-- Phase 7: per-occurrence date/time overrides for recurring events.
--
-- recurring_exceptions grows three nullable override columns. A row with all
-- overrides NULL keeps its original meaning (the occurrence at skipped_date is
-- removed). A row with any override set means the occurrence originally
-- generated at skipped_date is displayed at override_date (or skipped_date
-- when only the time changed) with the overridden start/end times. The
-- occurrence keeps its `${baseId}__${skipped_date}` id, so completion state
-- and later edits stay keyed to the same occurrence across moves.

ALTER TABLE recurring_exceptions
  ADD COLUMN IF NOT EXISTS override_date       DATE,
  ADD COLUMN IF NOT EXISTS override_start_time TEXT,
  ADD COLUMN IF NOT EXISTS override_end_time   TEXT;

ALTER TABLE event_mutations_log
  DROP CONSTRAINT IF EXISTS event_mutations_log_operation_check;
ALTER TABLE event_mutations_log
  ADD CONSTRAINT event_mutations_log_operation_check
  CHECK (operation IN ('create','update','delete','delete_instance','update_instance'));
