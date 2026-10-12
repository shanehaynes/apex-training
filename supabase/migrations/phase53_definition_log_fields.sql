-- Phase 53: exercise_definitions.log_fields.
--
-- WHY THIS EXISTS
-- The tracker gives each set row the inputs its prescription names: an entry
-- planned as "3 × 8" gets reps and nothing else. That is wrong for a movement
-- that is sometimes loaded — ring pull-ups with a vest, dips with a belt —
-- since the weight has nowhere to go. What a movement is measured in is a fact
-- about the movement, not about one day's prescription, so it lives on the
-- definition (EXERCISE_LIBRARY_SPEC.md §2.1 tiers): adding "weight" to ring
-- pull-ups mid-workout gives every workout that references them, past and
-- future, a weight input.
--
-- SEMANTICS
-- Additive only. The tracker's inputs are the union of the prescription's
-- dimensions, whatever already carries a value, and these. An empty array —
-- every existing row — changes nothing. 'duration' is the set-log column the
-- UI labels "time".

ALTER TABLE exercise_definitions
  ADD COLUMN IF NOT EXISTS log_fields TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE exercise_definitions DROP CONSTRAINT IF EXISTS exercise_definitions_log_fields_check;
ALTER TABLE exercise_definitions ADD CONSTRAINT exercise_definitions_log_fields_check
  CHECK (log_fields <@ ARRAY['weight','reps','duration']::TEXT[]);
