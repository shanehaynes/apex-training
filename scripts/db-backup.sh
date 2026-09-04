#!/usr/bin/env bash
# Dump the production (or local) Supabase database into an encrypted bundle.
#
#   SUPABASE_DB_URL=postgresql://... scripts/db-backup.sh <outdir>   # production
#   scripts/db-backup.sh <outdir> --local                            # local stack
#
# Writes <outdir>/apex-db-<date>.tar.gz.age holding schema.sql, data.sql,
# manifest.txt (rows per table, derived from the dump itself) and meta.txt.
# The plaintext files stay in <outdir> for scripts/db-restore-drill.sh and
# must never leave the machine unencrypted; the .age file is what gets
# uploaded (.github/workflows/backup.yml). Encryption is to the public keys in
# scripts/backup/age-recipient.txt — the private key lives only with Shane.
#
# What is dumped, and why it is enough:
#   schema.sql  public DDL (tables, policies, functions, grants). The CLI's
#               schema dump excludes platform schemas (auth, storage, ...),
#               which every restore target already has.
#   data.sql    rows for the auth and public schemas in COPY format, preceded
#               by SET session_replication_role = replica so a restore never
#               fires triggers or FK checks. The CLI also emits storage and
#               supabase_functions rows; they are stripped because the app
#               uses neither and a restoring role lacks INSERT on some storage
#               tables (COPY needs it even for zero rows). If the app ever
#               stores objects, the check below fails and this must grow.
#   No roles dump: the app creates no roles, and a Supabase stack already
#   has anon/authenticated/service_role.
#
# One thing a schema dump cannot carry: on_auth_user_created is a trigger ON
# auth.users, an excluded schema. The restore drill recreates it; a manual
# disaster recovery must too (README, "Backups").
#
# Runs in a PUBLIC repo's CI logs: never prints the connection string.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { echo "usage: scripts/db-backup.sh <outdir> [--local]" >&2; exit 2; }
out=""; local_mode=0
for arg in "$@"; do
  case "$arg" in
    --local) local_mode=1 ;;
    -*) usage ;;
    *) out=$arg ;;
  esac
done
[ -n "$out" ] || usage

RECIPIENTS=${APEX_AGE_RECIPIENTS:-scripts/backup/age-recipient.txt}
if ! grep -qE '^age1[0-9a-z]+$' "$RECIPIENTS" 2>/dev/null; then
  echo "error: no age public key in $RECIPIENTS — run age-keygen and add the 'age1...' line (README, Backups)" >&2
  exit 1
fi
command -v age >/dev/null || { echo "error: age is not installed (apt install age / brew install age)" >&2; exit 1; }

# The CLI runs pg_dump inside Docker, so the host needs no Postgres client and
# its pg_dump version always matches its own images. PATH in CI (setup-cli),
# npx here — same pin as scripts/db-types.sh.
if command -v supabase >/dev/null; then
  SUPABASE=(supabase)
else
  SUPABASE=(npx --yes supabase@2.115.0)
fi

if [ "$local_mode" = 1 ]; then
  src=(--local); source_name=local
else
  url=${SUPABASE_DB_URL:-}
  [ -n "$url" ] || { echo "error: SUPABASE_DB_URL is not set (or pass --local)" >&2; exit 1; }
  # GitHub-hosted runners have no IPv6 and the direct db.<ref> host is
  # IPv6-only; the transaction pooler (6543) breaks pg_dump. Only the session
  # pooler works from CI — refuse anything else, without echoing the URL.
  case "$url" in
    *:6543/*)
      echo "error: SUPABASE_DB_URL is the transaction pooler (port 6543) — pg_dump needs the session pooler on port 5432" >&2; exit 1 ;;
    *@db.*.supabase.co*)
      echo "error: SUPABASE_DB_URL is the direct host, which is IPv6-only — use the session pooler (aws-0-<region>.pooler.supabase.com:5432)" >&2; exit 1 ;;
    *.pooler.supabase.com:5432/*) ;;
    *)
      echo "error: SUPABASE_DB_URL does not look like a Supabase session-pooler URL" >&2; exit 1 ;;
  esac
  src=(--db-url "$url"); source_name=production
fi

mkdir -p "$out"
rm -f "$out"/schema.sql "$out"/data.sql "$out"/data.sql.full "$out"/manifest.txt "$out"/meta.txt

echo "── dumping schema ($source_name)"
"${SUPABASE[@]}" db dump "${src[@]}" -f "$out/schema.sql"
echo "── dumping data ($source_name)"
"${SUPABASE[@]}" db dump "${src[@]}" --data-only --use-copy -f "$out/data.sql.full"

# The app has no Storage objects. The day it does, this backup is incomplete
# and must include the storage schema (and a role that can restore it).
storage_rows=$(awk '/^COPY "storage"\."objects" /{c=1; next} c && /^\\\.$/{exit} c{n++} END{print n+0}' "$out/data.sql.full")
if [ "$storage_rows" != 0 ]; then
  echo "error: storage.objects holds $storage_rows rows — the app now uses Supabase Storage and this backup does not cover it" >&2
  exit 1
fi

# Keep only the auth and public schemas: drop every other COPY block and the
# sequence resets that go with them.
awk '
  /^COPY "/ { s=$2; sub(/^"/, "", s); sub(/".*/, "", s); skip = (s != "auth" && s != "public"); if (skip) next }
  skip { if ($0 == "\\.") skip = 0; next }
  /^SELECT pg_catalog\.setval\(/ && $0 !~ /setval\(\x27"(auth|public)"\./ { next }
  { print }
' "$out/data.sql.full" > "$out/data.sql"
rm "$out/data.sql.full"

# A dump that is not a dump of this app is worse than a failed run.
grep -q '^SET session_replication_role = replica;' "$out/data.sql" \
  || { echo "error: data.sql does not disable triggers (CLI output format changed?)" >&2; exit 1; }
grep -q '^COPY "auth"\."users" ' "$out/data.sql" \
  || { echo "error: data.sql has no auth.users rows" >&2; exit 1; }
grep -q '^COPY "public"\."workout_events" ' "$out/data.sql" \
  || { echo "error: data.sql has no workout_events rows" >&2; exit 1; }
grep -q '"public"\."handle_new_user"' "$out/schema.sql" \
  || { echo "error: schema.sql has no handle_new_user()" >&2; exit 1; }

# Rows per table, counted from the COPY blocks — no database round trip, and
# the restore drill diffs the restored counts against this.
awk '
  /^COPY "/ { t=$2; gsub(/"/, "", t); n=0; inblk=1; next }
  inblk && /^\\\.$/ { print t "\t" n; inblk=0; next }
  inblk { n++ }
' "$out/data.sql" | sort > "$out/manifest.txt"

printf 'created_utc=%s\nsource=%s\ncli=%s\ngit_sha=%s\n' \
  "$(date -u +%FT%TZ)" "$source_name" \
  "$("${SUPABASE[@]}" --version 2>/dev/null | head -1)" \
  "${GITHUB_SHA:-$(git rev-parse HEAD)}" > "$out/meta.txt"

bundle="$out/apex-db-$(date -u +%F).tar.gz.age"
tar -C "$out" -czf - schema.sql data.sql manifest.txt meta.txt | age -R "$RECIPIENTS" -o "$bundle"

# Totals only — per-table counts are user data and this log may be public.
tables=$(wc -l < "$out/manifest.txt")
rows=$(awk -F'\t' '{s+=$2} END{print s+0}' "$out/manifest.txt")
echo "── bundle: $bundle ($(du -h "$bundle" | cut -f1)), $tables tables, $rows rows"
echo "   plaintext schema.sql/data.sql left in $out for the restore drill — delete them when done"
