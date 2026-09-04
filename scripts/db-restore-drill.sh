#!/usr/bin/env bash
# Restore a backup's plaintext (from scripts/db-backup.sh, or an extracted
# bundle) into the LOCAL Supabase stack, then prove it took.
#
#   scripts/db-restore-drill.sh <dir> [--no-types-check]
#
# <dir> holds schema.sql, data.sql and manifest.txt. This runs nightly in CI
# (.github/workflows/backup.yml) against a fresh `supabase start`, and by hand
# against a developer's stack for a real drill (README, "Backups"). Either way
# the stack ends up holding whatever the dump held — for a production bundle
# that is real users' data and their password hashes — so
# `npm run db:reset-local` afterwards puts the fixtures back.
#
# Steps: drop the app's public objects (leaving btree_gist, which the
# migration installed into public), truncate the auth tables the dump refills,
# load schema + data in one transaction, recreate the one trigger a schema
# dump cannot carry (on_auth_user_created is ON auth.users, an excluded
# schema), then assert: users and events exist, profiles match users, every
# row count matches the manifest, the trigger is back, and the schema matches
# the committed types. That last one fails when production lags main's
# migrations — a red run then means "apply the migration", not "bad backup".
#
# LOCAL ONLY: connects exclusively to the running local stack's Postgres
# container; there is no way to point this at a remote project.
set -euo pipefail
cd "$(dirname "$0")/.."

# The stack is shared machine-wide — self-relaunch under the cross-session
# lock (see scripts/db-reset-local.sh). Re-entrant via APEX_STACK_LOCKED=1.
if [ "${APEX_STACK_LOCKED:-}" != 1 ]; then
  exec scripts/with-stack-lock.sh scripts/db-restore-drill.sh "$@"
fi

usage() { echo "usage: scripts/db-restore-drill.sh <dir> [--no-types-check]" >&2; exit 2; }
dir=""; types_check=1
for arg in "$@"; do
  case "$arg" in
    --no-types-check) types_check=0 ;;
    -*) usage ;;
    *) dir=$arg ;;
  esac
done
[ -n "$dir" ] || usage
for f in schema.sql data.sql manifest.txt; do
  [ -f "$dir/$f" ] || { echo "error: $dir/$f not found" >&2; exit 1; }
done

scripts/preflight-local.sh --fix --quiet || exit 1

DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep '^supabase_db_' | head -1 || true)
if [ -z "$DB_CONTAINER" ]; then
  echo "error: local Supabase stack is not running — run 'supabase start' first" >&2
  exit 1
fi
db() { docker exec -i "$DB_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "── dropping the app's public objects"
# Dynamic, so a table added by a later migration is not missed the way
# db-reset-local.sh's hand-written list once missed phase21. Anything owned by
# an extension (pg_depend deptype 'e' — btree_gist's 180-odd functions and
# types live in public) is left alone, and the extension itself is never
# dropped: schema.sql re-issues CREATE EXTENSION IF NOT EXISTS for it.
db <<'SQL'
SET client_min_messages = warning;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DO $$
DECLARE stmts text[]; stmt text;
BEGIN
  -- Names are rendered up front: dropping a table cascades to its owned
  -- sequence, and a regclass rendered after that is a bare oid.
  SELECT coalesce(array_agg(format('DROP %s IF EXISTS %s CASCADE',
      CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
           WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      c.oid::regclass)), '{}')
  INTO stmts
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e');
  FOREACH stmt IN ARRAY stmts LOOP EXECUTE stmt; END LOOP;

  SELECT coalesce(array_agg(format('DROP %s IF EXISTS %s CASCADE',
      CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, p.oid::regprocedure)), '{}')
  INTO stmts
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');
  FOREACH stmt IN ARRAY stmts LOOP EXECUTE stmt; END LOOP;

  SELECT coalesce(array_agg(format('DROP TYPE IF EXISTS %s CASCADE', t.oid::regtype)), '{}')
  INTO stmts
  FROM pg_type t JOIN pg_namespace ns ON ns.oid = t.typnamespace
  WHERE ns.nspname = 'public' AND t.typtype IN ('e','d','r','c') AND t.typrelid = 0
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e');
  FOREACH stmt IN ARRAY stmts LOOP EXECUTE stmt; END LOOP;
END $$;
SQL

echo "── truncating the non-public tables the dump refills"
# A populated local stack would otherwise collide on primary keys. Only
# tables the dump actually COPYs into, and only those that exist here — one
# the local auth schema lacks is left for the COPY to report, which is the
# "production's GoTrue is newer than the CLI's" diagnosis.
tables=$(grep -oE '^COPY "[A-Za-z0-9_]+"\."[A-Za-z0-9_]+"' "$dir/data.sql" \
  | sed 's/^COPY //; s/"//g' | grep -v '^public\.' | sort -u | tr '\n' ' ')
db -o /dev/null -v tables="$tables" <<'SQL'
SELECT set_config('apex.tables', :'tables', false);
DO $$
DECLARE keep text[] := '{}'; t text;
BEGIN
  FOREACH t IN ARRAY string_to_array(trim(current_setting('apex.tables')), ' ') LOOP
    IF to_regclass(t) IS NOT NULL THEN keep := keep || t; END IF;
  END LOOP;
  IF cardinality(keep) > 0 THEN
    EXECUTE 'TRUNCATE ' || array_to_string(keep, ', ') || ' CASCADE';
  END IF;
END $$;
SQL

echo "── restoring schema + data in one transaction"
# psql ignores --single-transaction for bare stdin; -f - reads stdin as a file
# and honours it. data.sql's SET session_replication_role = replica (which
# supautils lets the local postgres role set) keeps triggers and FK checks
# off for the load, so row order does not matter. The GRANTs schema.sql
# carries for btree_gist's functions warn "no privileges were granted"
# (postgres does not own extension objects) — 1,500 lines of nothing, dropped.
cat "$dir/schema.sql" "$dir/data.sql" | db -1 -o /dev/null -f - \
  2> >(grep -v 'no privileges were granted for' >&2)

echo "── recreating on_auth_user_created"
# The schema dump excludes auth, and a trigger belongs to its table, so this
# trigger is the one piece of the app's schema no dump carries. Verbatim from
# supabase/migrations/phase9_multi_user.sql.
db <<'SQL'
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
NOTIFY pgrst, 'reload schema';
SQL
sleep 2

echo "── checking the restore"
q() { db -tA -c "$1"; }
users=$(q "SELECT count(*) FROM auth.users")
profiles=$(q "SELECT count(*) FROM public.profiles")
events=$(q "SELECT count(*) FROM public.workout_events")
trigger=$(q "SELECT count(*) FROM pg_trigger WHERE tgname = 'on_auth_user_created' AND NOT tgisinternal")
[ "$users" -gt 0 ] || fail "no auth.users restored"
[ "$events" -gt 0 ] || fail "no workout_events restored"
# Every user gets a profile from the signup trigger (phase9 backfilled the
# rest); revisit if a migration ever adds profile-less users on purpose.
[ "$profiles" = "$users" ] || fail "profiles ($profiles) != auth.users ($users)"
[ "$trigger" = 1 ] || fail "on_auth_user_created is missing"

# Every table in the manifest must hold exactly the rows the dump held.
sql=""
while IFS=$'\t' read -r t n; do
  sql+="${sql:+ UNION ALL }SELECT '$t', count(*) FROM \"${t%%.*}\".\"${t#*.}\""
done < "$dir/manifest.txt"
if ! diff <(sort "$dir/manifest.txt") <(db -tA -F $'\t' -c "$sql" | sort) >&2; then
  fail "row counts differ from manifest (left: manifest, right: restored)"
fi

rows=$(awk -F'\t' '{s+=$2} END{print s+0}' "$dir/manifest.txt")
echo "   ok: $users users, $events events, $(wc -l < "$dir/manifest.txt") tables / $rows rows match the manifest"

if [ "$types_check" = 1 ]; then
  echo "── checking the restored schema against the committed types"
  scripts/db-types.sh --check
fi

echo "── done: the local stack now holds the restored data — 'npm run db:reset-local' puts the fixtures back"
