-- Phase 8: exercise definitions — normalized exercise library.
-- See EXERCISE_LIBRARY_SPEC.md. One row per movement, owning identity and
-- descriptive metadata (shared: edit once, every referencing event follows).
-- Prescriptions (sets/reps/weight for a given day) stay per-event in the
-- workout_events JSONB; PRs and history stay derived from set_logs/cardio_logs.

CREATE TABLE IF NOT EXISTS exercise_definitions (
  id              TEXT        PRIMARY KEY,   -- stable slug, e.g. 'pistol-squat'; rename never changes it
  canonical_name  TEXT        NOT NULL UNIQUE,
  -- Former names + accepted spellings. History matching unions canonical_name
  -- with aliases so renames never fork PR history: renaming auto-appends the
  -- old canonical_name here.
  aliases         TEXT[]      NOT NULL DEFAULT '{}',
  category        TEXT        NOT NULL CHECK (category IN ('strength','stretch','cardio','skill','mobility')),
  muscle_groups   TEXT[]      NOT NULL DEFAULT '{}',
  equipment       TEXT[]      NOT NULL DEFAULT '{}',
  image_url       TEXT,
  -- Form cues / setup / safety notes. Shared across every referencing event.
  technique_notes TEXT,
  -- Reps for unilateral movements are per side ("5 each leg"), never bare
  -- numbers; this flag lets authoring tools validate that mechanically.
  is_unilateral   BOOLEAN     NOT NULL DEFAULT false,
  -- Insert-time defaults ONLY: copied into a new event entry when the
  -- exercise is added, then owned by the event. Never resolved live.
  default_sets     INTEGER,
  default_reps     TEXT,
  default_duration TEXT,
  default_weight   TEXT,
  default_rest     TEXT,
  -- Soft archive: hidden from pickers/coach list, but referencing events keep
  -- resolving it. Hard delete only with zero references and no matching logs.
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit of definition mutations — parallel to event_mutations_log
-- (separate table so definition slugs never masquerade as event ids).
CREATE TABLE IF NOT EXISTS definition_mutations_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operation       TEXT        NOT NULL CHECK (operation IN ('create','update','archive','unarchive','delete')),
  definition_id   TEXT        NOT NULL,
  definition_name TEXT        NOT NULL,
  diff            JSONB,      -- {before: {...}, after: {...}} for updates
  triggered_by    TEXT        NOT NULL DEFAULT 'ai',
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dml_def  ON definition_mutations_log (definition_id);
CREATE INDEX IF NOT EXISTS idx_dml_date ON definition_mutations_log (logged_at);

-- New log rows stamp the definition they were tracked against. Existing rows
-- stay NULL forever (append-only history is never rewritten) and are matched
-- by exercise_name against canonical_name + aliases.
ALTER TABLE workout_set_logs
  ADD COLUMN IF NOT EXISTS definition_id TEXT;
ALTER TABLE workout_cardio_logs
  ADD COLUMN IF NOT EXISTS definition_id TEXT;

CREATE INDEX IF NOT EXISTS idx_wsl_def  ON workout_set_logs    (definition_id) WHERE definition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wclg_def ON workout_cardio_logs (definition_id) WHERE definition_id IS NOT NULL;

-- Same posture as phase3/phase4: anon key is read-only, all writes go through
-- service-role backed /api/* endpoints (service_role bypasses RLS).
ALTER TABLE exercise_definitions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE definition_mutations_log ENABLE ROW LEVEL SECURITY;

-- The client resolves event exercise entries against definitions directly
-- with the anon key. The mutation log stays server-only (no anon policy),
-- matching event_mutations_log.
CREATE POLICY anon_select_exercise_definitions
  ON exercise_definitions FOR SELECT
  TO anon
  USING (true);
