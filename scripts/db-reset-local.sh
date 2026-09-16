#!/usr/bin/env bash
# Reset the LOCAL Supabase database to the full schema and reseed fixtures.
#
# Applies schema.sql + the phaseN migrations in their real order (lexicographic
# sorting breaks: phase10 < phase2), creating the auth users between phase8
# and phase9 — phase9's backfill aborts unless shanehaynes.sah@gmail.com
# exists. Migrations use the phaseN naming on purpose: `supabase start` only
# auto-applies <timestamp>_*.sql files, so phaseN ones are skipped there and
# ordered here instead. Keep new migrations phaseN — a timestamped one would
# be auto-applied by `supabase start` before this script builds the schema.
# The trailing loop still sweeps up any stray <timestamp>_*.sql, last.
#
# LOCAL ONLY: connects exclusively to the running local stack's Postgres
# container; there is no way to point this at a remote project.

set -euo pipefail
cd "$(dirname "$0")/.."

# The stack is shared machine-wide — self-relaunch under the cross-session
# lock so two sessions cannot reset over each other. Re-entrant: the wrapper
# no-ops when the calling chain already holds the lock.
if [ "${APEX_STACK_LOCKED:-}" != 1 ]; then
  # Not "$0": the cd above already moved to the repo root, so a caller's
  # relative $0 may no longer resolve.
  exec scripts/with-stack-lock.sh scripts/db-reset-local.sh "$@"
fi

# A running container is not a working one: Docker has reported every container
# healthy while GoTrue could not reach Postgres at all. Prove the stack actually
# works — and repair it — before spending minutes seeding into it.
scripts/preflight-local.sh --fix --quiet || exit 1

# Scoped to THIS project's container, never whatever Docker lists first: one
# daemon serves every project on this machine, and an unscoped match would
# truncate a different project's tables (scripts/lib/project-id.sh).
. scripts/lib/project-id.sh
DB_CONTAINER=$(apex_container db)
if [ -z "$DB_CONTAINER" ]; then
  echo "error: local Supabase stack is not running — run 'supabase start' first" >&2
  exit 1
fi

run_sql_file() {
  echo "── applying $1"
  docker exec -i "$DB_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$1"
}

echo "── dropping the app's public objects and auth users"
# Everything in public, found in the catalog rather than named by hand — the
# same approach as scripts/db-restore-drill.sh. The hand-written table list
# this replaced fell twelve tables behind, and a table that survives here is
# never rebuilt: its migration's CREATE TABLE IF NOT EXISTS is skipped, so an
# edited column, default or RLS setting never reaches this database and its
# rows outlive the reset. Functions go for the same reason: CREATE OR REPLACE
# keeps a stale function's grants, cannot change its return type, and never
# removes one that no migration creates any more.
#
# Left alone: anything an extension owns (pg_depend deptype 'e' — btree_gist,
# which phase19 installs into public, keeps ~200 functions and types there),
# and the extension itself, which phase19 re-issues IF NOT EXISTS; and
# anything internal to another object (deptype 'i' — an identity column's
# sequence, a range type's constructor), which goes when its owner does.
# Dropping a table also takes it out of the supabase_realtime publication;
# phase19 and phase40 put the members back.
docker exec -i "$DB_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
SET client_min_messages = warning;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();
DO $$
DECLARE stmts text[]; stmt text;
BEGIN
  -- Each list is collected before its first drop; IF EXISTS skips whatever an
  -- earlier CASCADE already took (a serial column's sequence goes with its table).
  SELECT coalesce(array_agg(format('DROP %s IF EXISTS %I.%I CASCADE',
      CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
           WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE'
           WHEN 'c' THEN 'TYPE' ELSE 'TABLE' END,
      ns.nspname, c.relname)), '{}')
  INTO stmts
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f','c')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e','i'));
  FOREACH stmt IN ARRAY stmts LOOP EXECUTE stmt; END LOOP;

  SELECT coalesce(array_agg(format('DROP %s IF EXISTS %I.%I(%s) CASCADE',
      CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
      ns.nspname, p.proname, pg_get_function_identity_arguments(p.oid))), '{}')
  INTO stmts
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype IN ('e','i'));
  FOREACH stmt IN ARRAY stmts LOOP EXECUTE stmt; END LOOP;

  -- Domains, enums and ranges. Composite types are pg_class rows (relkind 'c',
  -- above); array and multirange types go with their element or range type.
  SELECT coalesce(array_agg(format('DROP TYPE IF EXISTS %I.%I CASCADE', ns.nspname, t.typname)), '{}')
  INTO stmts
  FROM pg_type t JOIN pg_namespace ns ON ns.oid = t.typnamespace
  WHERE ns.nspname = 'public' AND t.typtype IN ('d','e','r')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype IN ('e','i'));
  FOREACH stmt IN ARRAY stmts LOOP EXECUTE stmt; END LOOP;
END $$;
DELETE FROM auth.users;
SQL

run_sql_file supabase/schema.sql

# Apply every phaseN migration in numeric order via a version-sorted glob —
# never a hand-enumerated list: the old list silently skipped phase21 because
# nobody added it, and the [0-9]*.sql straggler glob below can't catch phaseN
# names. sort -V orders phase2 < phase10 correctly and breaks same-number ties
# (phase3_enable_rls before phase3_recurrence_rule) lexicographically.
# phase9's backfill aborts unless the local auth users exist, so they are
# created just before the first migration numbered >= 9.
users_created=0
while IFS= read -r f; do
  n=$(basename "$f"); n=${n#phase}; n=${n%%[!0-9]*}
  if [ "$users_created" -eq 0 ] && [ "$n" -ge 9 ]; then
    echo "── creating local auth users (phase9 prerequisite)"
    node scripts/create-local-users.mjs
    users_created=1
  fi
  run_sql_file "$f"
done < <(printf '%s\n' supabase/migrations/phase*.sql | sort -V)

# Fallback: apply any stray timestamped migration last, in name order. The
# convention is phaseN (see header) so this normally matches nothing.
for f in supabase/migrations/[0-9]*.sql; do
  [ -e "$f" ] || continue
  run_sql_file "$f"
done

# The agent users were created before phase9's on_auth_user_created trigger
# existed — give them the profiles the trigger would have created.
#
# onboarding_dismissed_at is stamped because these profiles are inserted
# AFTER phase30's backfill has already run, so they would otherwise be the
# one thing phase30 exists to prevent: established fixtures that look like
# brand-new accounts. The welcome flow then renders over the calendar and
# swallows the clicks of every live e2e spec. The first-run flow itself is
# covered by e2e/mock/onboarding.spec.ts against an explicit fresh stub.
# Fixture users need a CURRENT terms acceptance, for the same reason the
# profiles above need onboarding_dismissed_at: without one the phase39 gate
# in requireUser 403s every /api/* call, and every live e2e spec fails on an
# empty calendar with no visible cause. Versions are read from
# src/lib/legal/versions.ts rather than hardcoded here, so bumping a version
# does not silently leave this seed one release behind.
echo "── recording terms acceptance for the fixture users"
LEGAL_VERSIONS=$(npx --yes tsx -e \
  "import {TERMS_VERSION, PRIVACY_VERSION} from './src/lib/legal/versions.ts'; console.log(TERMS_VERSION + ' ' + PRIVACY_VERSION)")
TERMS_VERSION=${LEGAL_VERSIONS%% *}
PRIVACY_VERSION=${LEGAL_VERSIONS##* }
docker exec -i "$DB_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<SQL
INSERT INTO terms_acceptances (user_id, terms_version, privacy_version, ip, user_agent)
SELECT id, '$TERMS_VERSION', '$PRIVACY_VERSION', '127.0.0.1', 'db-reset-local.sh fixture'
FROM auth.users;
SQL

echo "── backfilling profiles for pre-trigger users"
docker exec -i "$DB_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
INSERT INTO profiles (id, display_name, avatar_key, onboarding_dismissed_at)
SELECT id, split_part(email, '@', 1), 'goat', now()
FROM auth.users
ON CONFLICT (id) DO UPDATE SET onboarding_dismissed_at = EXCLUDED.onboarding_dismissed_at;
SQL

# phase25 rewrote the workout_events PK; PostgREST must reload its schema
# cache before the seeder's merge-duplicates upserts, or they 42P10 against
# the stale ON CONFLICT (id). The NOTIFY in phase25 already queued a reload —
# re-notify and give it a beat to settle before writing.
docker exec -i "$DB_CONTAINER" psql -q -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema';" >/dev/null
sleep 2

echo "── seeding fixtures"
node scripts/seed-local.mjs

echo "done: local database reset and seeded"
