-- Phase 17: outdoor climbing events.
-- New event type 'outdoor-climbing' (indoor stays 'climbing'), a new
-- exercise-library category 'climbing' for pitches (style + grade live
-- inside the exercise JSONB entries — no column needed), and a
-- climbing_targets JSONB column ({ maxGrade, totalPitches }) mirroring the
-- cardio_targets pattern: unset fields derive from the pitch list at
-- display time.

ALTER TABLE workout_events DROP CONSTRAINT IF EXISTS workout_events_type_check;
ALTER TABLE workout_events ADD CONSTRAINT workout_events_type_check
  CHECK (type IN ('stretching','morning-routine','weights','climbing','outdoor-climbing','cardio','yoga'));

ALTER TABLE workout_events ADD COLUMN IF NOT EXISTS climbing_targets JSONB;

ALTER TABLE exercise_definitions DROP CONSTRAINT IF EXISTS exercise_definitions_category_check;
ALTER TABLE exercise_definitions ADD CONSTRAINT exercise_definitions_category_check
  CHECK (category IN ('strength','stretch','cardio','skill','mobility','climbing'));
