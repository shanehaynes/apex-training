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
  reviews, user_api_keys, profiles,
  definition_mutations_log, exercise_definitions,
  workout_cardio_logs, workout_set_logs, workout_sessions,
  event_mutations_log, recurring_exceptions, workout_events,
  workout_completion_log, workout_completions
  CASCADE;
DELETE FROM auth.users;
SQL

run_sql_file supabase/schema.sql
run_sql_file supabase/migrations/phase2_events_tables.sql
run_sql_file supabase/migrations/phase3_enable_rls.sql
run_sql_file supabase/migrations/phase3_recurrence_rule.sql
run_sql_file supabase/migrations/phase4_workout_tracking.sql
run_sql_file supabase/migrations/phase5_coach_summary.sql
run_sql_file supabase/migrations/phase6_quick_complete.sql
run_sql_file supabase/migrations/phase7_occurrence_overrides.sql
run_sql_file supabase/migrations/phase8_exercise_definitions.sql

echo "── creating local auth users (phase9 prerequisite)"
node scripts/create-local-users.mjs

run_sql_file supabase/migrations/phase9_multi_user.sql
run_sql_file supabase/migrations/phase10_rls_lockdown.sql
run_sql_file supabase/migrations/phase11_user_api_keys.sql
run_sql_file supabase/migrations/phase12_reviews.sql
run_sql_file supabase/migrations/phase13_avatars.sql
run_sql_file supabase/migrations/phase14_avatars.sql
run_sql_file supabase/migrations/phase15_cat_cow_single_duration.sql
run_sql_file supabase/migrations/phase16_coach_profile_fields.sql
run_sql_file supabase/migrations/phase17_outdoor_climbing.sql

# Fallback: apply any stray timestamped migration last, in name order. The
# convention is phaseN (see header) so this normally matches nothing.
for f in supabase/migrations/[0-9]*.sql; do
  [ -e "$f" ] || continue
  run_sql_file "$f"
done

# The agent users were created before phase9's on_auth_user_created trigger
# existed — give them the profiles the trigger would have created.
echo "── backfilling profiles for pre-trigger users"
docker exec -i "$DB_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
INSERT INTO profiles (id, display_name, avatar_key)
SELECT id, split_part(email, '@', 1), 'goat'
FROM auth.users
ON CONFLICT (id) DO NOTHING;
SQL

echo "── seeding fixtures"
node scripts/seed-local.mjs

echo "done: local database reset and seeded"
