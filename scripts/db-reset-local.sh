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

# A running container is not a working one: Docker has reported every container
# healthy while GoTrue could not reach Postgres at all. Prove the stack actually
# works — and repair it — before spending minutes seeding into it.
scripts/preflight-local.sh --fix --quiet || exit 1

DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep '^supabase_db_' | head -1 || true)
if [ -z "$DB_CONTAINER" ]; then
  echo "error: local Supabase stack is not running — run 'supabase start' first" >&2
  exit 1
fi

run_sql_file() {
  echo "── applying $1"
  docker exec -i "$DB_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$1"
}

echo "── dropping app tables and auth users"
docker exec -i "$DB_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();
DROP TABLE IF EXISTS
  api_request_counts,
  block_mutations_log, training_blocks, objectives,
  reviews, user_api_keys, profiles,
  definition_mutations_log, exercise_definitions,
  workout_cardio_logs, workout_set_logs, workout_sessions,
  event_mutations_log, recurring_exceptions, workout_events,
  workout_completion_log, workout_completions
  CASCADE;
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
