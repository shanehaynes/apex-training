-- ============================================================
-- APEX TRAINING — Phase 32 Migration: event_date backfill
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- Run AFTER deploying the phase32 code. Order matters here, unlike
-- phase31: migrateTrackedEventDate() maintains the invariant this
-- migration establishes, so backfilling first leaves a window in
-- which a reschedule can strand fresh rows.
--
-- THE BUG
-- expand() pins an occurrence id to the occurrence's ORIGINAL date
-- (`${baseId}__${skipped_date}`) and then applies override_date to
-- the DISPLAYED date. Logging writes event_date from the displayed
-- date. So rescheduling an occurrence that already had logs left
-- the earlier rows at the old date under an id that still matches.
--
-- Nothing filtering on (event_id, event_date) can see those rows —
-- not the tracker, not get_workout_detail — but get_exercise_history,
-- buildExerciseStats and the review email bucket on event_date
-- alone, where a stranded row reads as a phantom extra session on
-- the old day and inflates total_sessions / last_performed.
--
-- THE INVARIANT
-- Every tracked row for one occurrence shares one event_date: the
-- occurrence's currently displayed date.
--
-- WHAT THIS DOES
--   1. Resolves the expected event_date for every event_id that has
--      tracked rows.
--   2. Reports the damage before touching anything.
--   3. Quarantines (not deletes) stale rows whose key is already
--      taken at the target date, then removes them from the live
--      tables so step 4 cannot collide.
--   4. Re-dates the remaining stale rows.
--   5. Re-reports, to confirm zero mismatches remain.
--
-- Idempotent: a second run finds nothing to do.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) Expected event_date per (user_id, event_id)
--
-- Mirrors applyOverride() in src/lib/schedule/expand.ts: the
-- occurrence's original date comes from the id suffix (or, for a
-- bare id, from the parent event's own date), and the displayed
-- date is override_date when an exception row supplies one.
--
-- Split note: occurrence.ts splits ids at the FIRST '__', this
-- splits at the LAST. They agree for every id makeOccurrenceId()
-- can round-trip; they diverge only when a BASE id itself contains
-- '__', which EVENT_ID_PATTERN permits but baseIdOf() already
-- mishandles upstream. Anchoring on the right is the reading that
-- matches how the id was built.
-- ------------------------------------------------------------
CREATE TEMP TABLE phase32_expected AS
WITH tracked AS (
  SELECT user_id, event_id FROM workout_sessions
  UNION SELECT user_id, event_id FROM workout_set_logs
  UNION SELECT user_id, event_id FROM workout_cardio_logs
  UNION SELECT user_id, event_id FROM workout_completions
  UNION SELECT user_id, event_id FROM activity_streams
),
parsed AS (
  SELECT
    t.user_id,
    t.event_id,
    substring(t.event_id from '^(.*)__\d{4}-\d{2}-\d{2}$')  AS split_base,
    substring(t.event_id from '__(\d{4}-\d{2}-\d{2})$')     AS split_date
  FROM tracked t
),
occ AS (
  SELECT
    p.user_id,
    p.event_id,
    COALESCE(p.split_base, p.event_id)            AS base_id,
    COALESCE(p.split_date::date, we.date)         AS orig_date,
    (we.id IS NULL)                               AS base_event_missing
  FROM parsed p
  LEFT JOIN workout_events we
    ON we.id      = COALESCE(p.split_base, p.event_id)
   AND we.user_id = p.user_id
)
SELECT
  o.user_id,
  o.event_id,
  o.orig_date,
  COALESCE(re.override_date, o.orig_date) AS expected_date,
  o.base_event_missing,
  -- An exception row with every override NULL is a DELETED occurrence, not a
  -- moved one. Its rows are orphans from before the purge existed; re-dating
  -- them would invent a session, so they are reported and left alone.
  (re.id IS NOT NULL
     AND re.override_date       IS NULL
     AND re.override_start_time IS NULL
     AND re.override_end_time   IS NULL) AS occurrence_deleted
FROM occ o
LEFT JOIN recurring_exceptions re
  ON re.user_id      = o.user_id
 AND re.event_id     = o.base_id
 AND re.skipped_date = o.orig_date;

-- Only rows this migration is willing to move.
CREATE TEMP TABLE phase32_fixable AS
SELECT user_id, event_id, expected_date
  FROM phase32_expected
 WHERE expected_date IS NOT NULL
   AND NOT base_event_missing
   AND NOT occurrence_deleted;

-- ------------------------------------------------------------
-- 2) Damage report — read this before trusting steps 3 and 4
-- ------------------------------------------------------------
CREATE TEMP TABLE phase32_before AS
SELECT 'workout_sessions'    AS table_name, s.user_id, s.event_id, s.event_date AS stale_date, f.expected_date
  FROM workout_sessions s    JOIN phase32_fixable f USING (user_id, event_id) WHERE s.event_date <> f.expected_date
UNION ALL
SELECT 'workout_set_logs',    l.user_id, l.event_id, l.event_date, f.expected_date
  FROM workout_set_logs l    JOIN phase32_fixable f USING (user_id, event_id) WHERE l.event_date <> f.expected_date
UNION ALL
SELECT 'workout_cardio_logs', c.user_id, c.event_id, c.event_date, f.expected_date
  FROM workout_cardio_logs c JOIN phase32_fixable f USING (user_id, event_id) WHERE c.event_date <> f.expected_date
UNION ALL
SELECT 'workout_completions', w.user_id, w.event_id, w.event_date, f.expected_date
  FROM workout_completions w JOIN phase32_fixable f USING (user_id, event_id) WHERE w.event_date <> f.expected_date
UNION ALL
SELECT 'activity_streams',    a.user_id, a.event_id, a.event_date, f.expected_date
  FROM activity_streams a    JOIN phase32_fixable f USING (user_id, event_id) WHERE a.event_date <> f.expected_date;

-- ------------------------------------------------------------
-- 3) Quarantine the duplicates
--
-- workout_sessions, workout_set_logs, workout_cardio_logs and
-- activity_streams each carry a uniqueness constraint that includes
-- event_date. Collapsing an occurrence onto one date drops
-- event_date out of those keys, so any two rows sharing the rest of
-- the key become duplicates and step 4 would hit a unique violation.
-- That happens whenever an occurrence was logged, moved, and logged
-- again.
--
-- Deduped per target key rather than "collides with a row already at
-- the expected date" — two separate past moves can leave rows at two
-- stale dates with nothing at the expected one, and that shape has no
-- blocker to detect.
--
-- The winner is the row already at the expected date, since that is
-- the one the tracker has been showing and writing to; failing that,
-- the most recently touched. Every loser is copied whole into
-- phase32_quarantine before removal. That is a real table, not a temp
-- one: it outlives the session so the rows can be inspected, and
-- restored if the call was wrong.
--
-- workout_completions is absent by design — its PK is
-- (user_id, event_id) with no date, so it can never duplicate.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phase32_quarantine (
  id             BIGSERIAL   PRIMARY KEY,
  table_name     TEXT        NOT NULL,
  user_id        UUID        NOT NULL,
  event_id       TEXT        NOT NULL,
  stale_date     DATE        NOT NULL,
  target_date    DATE        NOT NULL,
  row_data       JSONB       NOT NULL,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

WITH ranked AS (
  SELECT s.id, f.expected_date,
         row_number() OVER (
           PARTITION BY s.user_id, s.event_id
           ORDER BY (s.event_date = f.expected_date) DESC, s.updated_at DESC, s.id) AS rn
    FROM workout_sessions s JOIN phase32_fixable f USING (user_id, event_id)
), blocked AS (
  DELETE FROM workout_sessions s USING ranked r
   WHERE s.id = r.id AND r.rn > 1
  RETURNING s.*, r.expected_date
)
INSERT INTO phase32_quarantine (table_name, user_id, event_id, stale_date, target_date, row_data)
SELECT 'workout_sessions', user_id, event_id, event_date, expected_date, to_jsonb(blocked) FROM blocked;

WITH ranked AS (
  SELECT l.id, f.expected_date,
         row_number() OVER (
           PARTITION BY l.user_id, l.event_id, l.section, l.exercise_id, l.set_number
           ORDER BY (l.event_date = f.expected_date) DESC, l.updated_at DESC, l.id) AS rn
    FROM workout_set_logs l JOIN phase32_fixable f USING (user_id, event_id)
), blocked AS (
  DELETE FROM workout_set_logs l USING ranked r
   WHERE l.id = r.id AND r.rn > 1
  RETURNING l.*, r.expected_date
)
INSERT INTO phase32_quarantine (table_name, user_id, event_id, stale_date, target_date, row_data)
SELECT 'workout_set_logs', user_id, event_id, event_date, expected_date, to_jsonb(blocked) FROM blocked;

WITH ranked AS (
  SELECT c.id, f.expected_date,
         row_number() OVER (
           PARTITION BY c.user_id, c.event_id, c.section, c.exercise_id
           ORDER BY (c.event_date = f.expected_date) DESC, c.updated_at DESC, c.id) AS rn
    FROM workout_cardio_logs c JOIN phase32_fixable f USING (user_id, event_id)
), blocked AS (
  DELETE FROM workout_cardio_logs c USING ranked r
   WHERE c.id = r.id AND r.rn > 1
  RETURNING c.*, r.expected_date
)
INSERT INTO phase32_quarantine (table_name, user_id, event_id, stale_date, target_date, row_data)
SELECT 'workout_cardio_logs', user_id, event_id, event_date, expected_date, to_jsonb(blocked) FROM blocked;

-- activity_streams has no surrogate key — its PK is
-- (user_id, event_id, event_date) — so rows are addressed by ctid.
-- Safe here: one transaction, no concurrent writer.
WITH ranked AS (
  SELECT a.ctid, f.expected_date,
         row_number() OVER (
           PARTITION BY a.user_id, a.event_id
           ORDER BY (a.event_date = f.expected_date) DESC, a.created_at DESC, a.ctid) AS rn
    FROM activity_streams a JOIN phase32_fixable f USING (user_id, event_id)
), blocked AS (
  DELETE FROM activity_streams a USING ranked r
   WHERE a.ctid = r.ctid AND r.rn > 1
  RETURNING a.*, r.expected_date
)
INSERT INTO phase32_quarantine (table_name, user_id, event_id, stale_date, target_date, row_data)
SELECT 'activity_streams', user_id, event_id, event_date, expected_date, to_jsonb(blocked) FROM blocked;

-- ------------------------------------------------------------
-- 4) Re-date what is left. No collisions remain after step 3.
-- ------------------------------------------------------------
UPDATE workout_sessions s SET event_date = f.expected_date
  FROM phase32_fixable f
 WHERE s.user_id = f.user_id AND s.event_id = f.event_id AND s.event_date <> f.expected_date;

UPDATE workout_set_logs l SET event_date = f.expected_date
  FROM phase32_fixable f
 WHERE l.user_id = f.user_id AND l.event_id = f.event_id AND l.event_date <> f.expected_date;

UPDATE workout_cardio_logs c SET event_date = f.expected_date
  FROM phase32_fixable f
 WHERE c.user_id = f.user_id AND c.event_id = f.event_id AND c.event_date <> f.expected_date;

UPDATE workout_completions w SET event_date = f.expected_date
  FROM phase32_fixable f
 WHERE w.user_id = f.user_id AND w.event_id = f.event_id AND w.event_date <> f.expected_date;

UPDATE activity_streams a SET event_date = f.expected_date
  FROM phase32_fixable f
 WHERE a.user_id = f.user_id AND a.event_id = f.event_id AND a.event_date <> f.expected_date;

COMMIT;

-- ============================================================
-- 5) Verification. The temp tables survive the session, so these
--    run as-is in the same SQL Editor tab.
-- ============================================================

-- What was wrong, per table. Expect rows here on the first run.
SELECT table_name, stale_date, expected_date, count(*) AS rows_affected
  FROM phase32_before
 GROUP BY 1, 2, 3
 ORDER BY 1, 2;

-- What was removed rather than moved. Inspect row_data before
-- dropping this table; the sets are real training data.
SELECT table_name, event_id, stale_date, target_date, count(*) AS rows_quarantined
  FROM phase32_quarantine
 GROUP BY 1, 2, 3, 4
 ORDER BY 1, 2;

-- Deliberately skipped: orphans from a deleted occurrence or a
-- deleted parent event, both predating purgeTrackedEventData().
-- Nothing above touches them.
SELECT event_id, orig_date, base_event_missing, occurrence_deleted
  FROM phase32_expected
 WHERE base_event_missing OR occurrence_deleted
 ORDER BY event_id;

-- Must return zero rows.
SELECT 'workout_sessions' AS table_name, count(*) AS remaining
  FROM workout_sessions s JOIN phase32_fixable f USING (user_id, event_id)
 WHERE s.event_date <> f.expected_date
UNION ALL
SELECT 'workout_set_logs', count(*)
  FROM workout_set_logs l JOIN phase32_fixable f USING (user_id, event_id)
 WHERE l.event_date <> f.expected_date
UNION ALL
SELECT 'workout_cardio_logs', count(*)
  FROM workout_cardio_logs c JOIN phase32_fixable f USING (user_id, event_id)
 WHERE c.event_date <> f.expected_date
UNION ALL
SELECT 'workout_completions', count(*)
  FROM workout_completions w JOIN phase32_fixable f USING (user_id, event_id)
 WHERE w.event_date <> f.expected_date
UNION ALL
SELECT 'activity_streams', count(*)
  FROM activity_streams a JOIN phase32_fixable f USING (user_id, event_id)
 WHERE a.event_date <> f.expected_date;
