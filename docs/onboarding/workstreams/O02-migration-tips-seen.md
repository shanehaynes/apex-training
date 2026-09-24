# O02 — Migration: `profiles.tips_seen`

**Wave:** 1 · **Depends on:** O01 · **Unblocks:** cross-device tips (O03 works without it)
**Status:** ready · branch `db/tips-seen` · port 5211 · **HELD** (migration) · wakes the iOS job

## Goal
One column that remembers which tips an account has seen, typed end to end.

## Scope
In:
- `supabase/migrations/phaseNN_tips_seen.sql` — claim `NN` with `scripts/next-phase.sh` when
  the PR opens (47 was free on 2026-09-24). Header comment in the phase30 style. Body:
  `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tips_seen JSONB NOT NULL DEFAULT '{}'::jsonb;`
  `ALTER TABLE profiles ADD CONSTRAINT profiles_tips_seen_object CHECK (jsonb_typeof(tips_seen) = 'object');`
  `COMMENT ON COLUMN profiles.tips_seen IS 'tip id → ISO timestamp first dismissed; see src/lib/onboarding/tips/';`
  No backfill. profiles RLS is select-own; no policy or grant change.
- `scripts/with-stack-lock.sh npm run db:reset-local && npm run db:types` → commit
  `src/lib/db/database.types.ts` and the regenerated Swift `DatabaseTypes.swift` (not HELD,
  but it diffs `ios/`, so the macOS CI job runs).
Out: any client or API code (O03).

## Acceptance
- `npm run agent:check` green; `scripts/db-types.sh --check` clean.
- Shane's `shipit`; Shane applies the SQL in prod; `scripts/prod-schema-check.mjs` clean.

## Session log
