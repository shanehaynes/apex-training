-- Two prescription-shape fixes, same class as phase15 (cat-cow).
--
-- 1. ARC Traversing carried default_weight = '40–50% effort'. The weight
--    column is a load, and the tracker derives its input fields from the
--    planned targets — so an intensity cue parked there rendered a weight box
--    next to the duration box. ARC is a timed session: null the default and
--    strip `weight` from every existing entry so it renders as one duration
--    field. The number moves into technique_notes, where the rest of the
--    intensity rule already lives.
--
-- 2. Face Pulls with External Rotation had default_reps = NULL and only a
--    band weight, so entries added from the library logged a weight with no
--    rep count. Backfill 15 reps on the definition and on entries that have
--    none. (Plain 'Face Pulls' already carries reps '20' — untouched.)

UPDATE exercise_definitions
SET default_weight = NULL,
    technique_notes = replace(
      technique_notes,
      'INTENSITY RULE: must be able to speak',
      'INTENSITY RULE: 40–50% effort — must be able to speak'
    )
WHERE id = 'arc-traversing';

UPDATE exercise_definitions
SET default_reps = '15'
WHERE id = 'face-pulls-with-external-rotation'
  AND default_reps IS NULL;

DO $$
DECLARE
  col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY['warmup', 'exercises', 'cooldown'] LOOP
    -- ARC Traversing: drop the effort-as-weight field.
    EXECUTE format($sql$
      UPDATE workout_events
      SET %1$I = (
        SELECT COALESCE(jsonb_agg(
          CASE
            WHEN e->>'definitionId' = 'arc-traversing'
              OR lower(e->>'name') = 'arc traversing'
              THEN e - 'weight'
            ELSE e
          END
          ORDER BY ord
        ), '[]'::jsonb)
        FROM jsonb_array_elements(%1$I) WITH ORDINALITY AS t(e, ord)
      )
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(%1$I) AS x(e)
        WHERE (x.e->>'definitionId' = 'arc-traversing'
               OR lower(x.e->>'name') = 'arc traversing')
          AND x.e ? 'weight'
      )
    $sql$, col);

    -- Face Pulls with External Rotation: add the missing rep count.
    EXECUTE format($sql$
      UPDATE workout_events
      SET %1$I = (
        SELECT COALESCE(jsonb_agg(
          CASE
            WHEN e->>'definitionId' = 'face-pulls-with-external-rotation'
              OR lower(e->>'name') = 'face pulls with external rotation'
              THEN e || '{"reps": "15"}'::jsonb
            ELSE e
          END
          ORDER BY ord
        ), '[]'::jsonb)
        FROM jsonb_array_elements(%1$I) WITH ORDINALITY AS t(e, ord)
      )
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(%1$I) AS x(e)
        WHERE (x.e->>'definitionId' = 'face-pulls-with-external-rotation'
               OR lower(x.e->>'name') = 'face pulls with external rotation')
          AND NOT (x.e ? 'reps')
      )
    $sql$, col);
  END LOOP;
END $$;
