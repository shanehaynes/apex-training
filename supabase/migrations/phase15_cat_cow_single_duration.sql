-- Cat-Cow is a timed hold like the stretches around it, not set work. Its
-- definition carried default_sets = 5 (from the "5 seconds each direction"
-- cue), so entries added from the library got sets: 5 and the tracker
-- synthesized five duration rows. Null the default and strip `sets` from
-- every existing Cat-Cow entry so it renders as one duration field.

UPDATE exercise_definitions
SET default_sets = NULL
WHERE id = 'cat-cow';

DO $$
DECLARE
  col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY['warmup', 'exercises', 'cooldown'] LOOP
    EXECUTE format($sql$
      UPDATE workout_events
      SET %1$I = (
        SELECT COALESCE(jsonb_agg(
          CASE
            WHEN e->>'definitionId' = 'cat-cow' OR lower(e->>'name') = 'cat-cow'
              THEN e - 'sets'
            ELSE e
          END
          ORDER BY ord
        ), '[]'::jsonb)
        FROM jsonb_array_elements(%1$I) WITH ORDINALITY AS t(e, ord)
      )
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(%1$I) AS x(e)
        WHERE (x.e->>'definitionId' = 'cat-cow' OR lower(x.e->>'name') = 'cat-cow')
          AND x.e ? 'sets'
      )
    $sql$, col);
  END LOOP;
END $$;
