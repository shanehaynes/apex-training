-- ============================================================
-- APEX TRAINING — Phase 19 Migration: Objectives & training blocks
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- The semantic layer. Until now the app recorded what happened
-- (sessions, sets, cardio logs) but had no representation of what a
-- stretch of training was FOR — the only goal was profiles.coach_goal,
-- a free-text string. An objective is the thing being trained for; a
-- training block is a dated stretch of training aimed at it, carrying
-- quantified weekly targets.
--
-- Inert for the currently deployed code: nothing reads these tables yet.
-- ============================================================

-- Needed by the non-overlap exclusion constraint below: gist over a
-- scalar (user_id) alongside a range requires the btree_gist operator
-- classes. If a hosted project refuses this extension, drop the
-- constraint and fall back to a check inside api/training-blocks.ts
-- (weaker — racy under concurrent writes).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------
-- 1) objectives — what the training is aimed at
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objectives (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,                 -- "Liberty Ridge"
  target_date DATE,                                 -- null = undated aspiration
  discipline  TEXT        CHECK (discipline IN ('alpine','ice','rock','ski','general')),
  notes       TEXT        NOT NULL DEFAULT '',
  -- Phase 2 fills this: [{ metric, target, unit }], scored against
  -- benchmark results to produce a readiness read. Empty until then —
  -- the column exists now so blocks can reference objectives without a
  -- later table rewrite.
  required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','achieved','abandoned')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2) training_blocks — a dated stretch of training with intent
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS training_blocks (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- SET NULL, never CASCADE: deleting an objective must not delete the
  -- training history aimed at it.
  objective_id       UUID        REFERENCES objectives (id) ON DELETE SET NULL,
  name               TEXT        NOT NULL,          -- "Fall Aerobic Foundation"
  intent             TEXT        NOT NULL DEFAULT '',
  phase              TEXT        CHECK (phase IN ('base','build','peak','taper','recovery','maintenance')),
  -- Half-open [start_date, end_date_exclusive), both Mondays. Matching
  -- the Period convention in src/lib/review/isoMonth.ts means a block
  -- period is a field rename with no date arithmetic, and weeksInPeriod
  -- is always a whole number. The UI displays end_date_exclusive - 1 day.
  start_date         DATE        NOT NULL,
  end_date_exclusive DATE        NOT NULL,
  weekly_targets     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT training_blocks_ordered     CHECK (end_date_exclusive > start_date),
  CONSTRAINT training_blocks_mon_start   CHECK (EXTRACT(ISODOW FROM start_date) = 1),
  CONSTRAINT training_blocks_mon_end     CHECK (EXTRACT(ISODOW FROM end_date_exclusive) = 1),
  CONSTRAINT training_blocks_max_len     CHECK (end_date_exclusive - start_date <= 364)
);

-- Blocks may not overlap: "the block covering date D" must be a total,
-- single-valued function, because the coach prompt and the eventual MCP
-- surface both depend on it being unambiguous. That also makes block
-- membership derivable from event_date alone — no block_id column on
-- workout_events, which would be the wrong grain anyway (a recurring
-- event's occurrences can straddle blocks).
-- User-scoped, per the phase9 convention that every uniqueness
-- constraint is user-prefixed: two users may hold identical ranges.
ALTER TABLE training_blocks DROP CONSTRAINT IF EXISTS training_blocks_no_overlap;
ALTER TABLE training_blocks ADD CONSTRAINT training_blocks_no_overlap
  EXCLUDE USING gist (
    user_id WITH =,
    daterange(start_date, end_date_exclusive, '[)') WITH &&
  );

-- ------------------------------------------------------------
-- 3) block_mutations_log — audit, same posture as event_mutations_log
--    A separate table rather than reusing that one: its operation CHECK
--    and NOT NULL event_id/event_title are event-shaped.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS block_mutations_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  operation    TEXT        NOT NULL CHECK (operation IN ('create','update','delete')),
  resource     TEXT        NOT NULL CHECK (resource IN ('block','objective')),
  resource_id  UUID        NOT NULL,
  resource_name TEXT       NOT NULL,
  diff         JSONB,      -- {before: {...}, after: {...}} for updates
  triggered_by TEXT        NOT NULL DEFAULT 'ai',
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 4) Indexes
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tb_user  ON training_blocks (user_id, start_date);
CREATE INDEX IF NOT EXISTS idx_obj_user ON objectives (user_id, target_date);
CREATE INDEX IF NOT EXISTS idx_bml_res  ON block_mutations_log (resource_id);
CREATE INDEX IF NOT EXISTS idx_bml_date ON block_mutations_log (logged_at);

-- ------------------------------------------------------------
-- 5) RLS — same posture as every other table: the anon/authenticated
--    client reads its own rows, all writes go through service-role
--    /api/training-blocks. The audit log stays server-only (RLS on,
--    deliberately no policies), matching event_mutations_log.
--    Realtime postgres_changes delivery is authorized against these
--    SELECT policies, so each user receives only their own changes.
-- ------------------------------------------------------------
ALTER TABLE objectives          ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_blocks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE block_mutations_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_select_objectives ON objectives;
CREATE POLICY user_select_objectives
  ON objectives FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_select_training_blocks ON training_blocks;
CREATE POLICY user_select_training_blocks
  ON training_blocks FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 6) Realtime. Cross-device sync needs THREE things to line up:
--    publication membership (here), an authenticated SELECT policy
--    (above — Realtime authorizes delivery against it), and the app's
--    postgres_changes subscription (src/context/BlocksContext.tsx).
--
--    Miss this step and nothing errors: the channel subscribes happily
--    and simply never delivers, so a second device keeps showing stale
--    blocks forever. The app still self-corrects on the writing device,
--    because every write path calls refresh() — which is exactly what
--    makes the omission so easy to miss.
--
--    Covered end-to-end by e2e/live/blocks-realtime.spec.ts.
--
--    Idempotent: ADD TABLE errors if the table is already a member, and
--    this migration is expected to be re-run.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication not found — skipping realtime setup';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'training_blocks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE training_blocks;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'objectives'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE objectives;
  END IF;
END
$$;
