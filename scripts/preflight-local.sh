#!/usr/bin/env bash
# Prove the LOCAL Supabase stack is actually working — then optionally repair it.
#
# WHY THIS EXISTS
# Docker reports containers "healthy" that are not functionally reachable. A
# Colima VM left up for two weeks developed a failure in Docker's embedded DNS
# (127.0.0.11): GoTrue could no longer resolve the Postgres container, so every
# sign-in returned 504 while `docker ps` showed all ten containers healthy. The
# live test suite failed nine specs over 24 minutes and read exactly like
# application breakage.
#
# So this script does not ask Docker whether things are healthy. It exercises
# the paths that broke:
#   - the auth container resolving the db container's hostname (the fault)
#   - Kong -> GoTrue -> Postgres          (the fault's symptom)
#   - Kong -> PostgREST                   (the other client-facing path)
#
# Every probe is bounded, because the degraded stack HUNG rather than erroring —
# an unbounded check would inherit the hang it is meant to detect.
#
# Usage:
#   scripts/preflight-local.sh            # check only; non-zero if broken
#   scripts/preflight-local.sh --fix      # check, then repair if broken
#   scripts/preflight-local.sh --quiet    # only print on failure
#
# LOCAL ONLY: refuses any non-localhost URL in .env.agent, same posture as
# scripts/lib/localEnv.mjs.

set -uo pipefail
cd "$(dirname "$0")/.."

FIX=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --fix)   FIX=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

log()  { [ "$QUIET" = 1 ] || echo "$@"; }
fail() { echo "preflight: $*" >&2; }

# ── Portable bounded execution ────────────────────────────────────────────────
# macOS ships neither `timeout` nor `gtimeout`, and a hung `docker` call would
# otherwise hang this script indefinitely.
run_bounded() {
  local secs=$1; shift
  # Per-pid scratch path: sessions run this concurrently, and a shared file
  # would have them writing over each other.
  "$@" >"${TMPDIR:-/tmp}/apex-preflight-$$.out" 2>&1 &
  local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local watcher=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill -9 "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return $rc
}

# ── Local-only guard ──────────────────────────────────────────────────────────
if [ ! -f .env.agent ]; then
  fail ".env.agent not found — run 'supabase start' and create it (see the run-apex-training skill)"
  exit 1
fi
SUPABASE_URL=$(grep -m1 '^VITE_SUPABASE_URL=' .env.agent | cut -d= -f2-)
ANON_KEY=$(grep -m1 '^VITE_SUPABASE_ANON_KEY=' .env.agent | cut -d= -f2-)
if [ -z "${SUPABASE_URL:-}" ] || [ -z "${ANON_KEY:-}" ]; then
  fail ".env.agent is missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY"
  exit 1
fi
case "$SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) fail "refusing non-local Supabase URL in .env.agent: $SUPABASE_URL"; exit 1 ;;
esac

# ── Probes ────────────────────────────────────────────────────────────────────
# Each sets REASON and REMEDY on failure. Ordered cheapest-and-most-fundamental
# first, so the reported cause is the root one rather than a downstream symptom.

REASON=""
REMEDY=""

container_named() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep "^supabase_$1_" | head -1
}

probe_docker() {
  if ! run_bounded 10 docker info; then
    REASON="the Docker daemon is not responding"
    REMEDY="colima start"
    return 1
  fi
}

probe_containers() {
  local missing=()
  for svc in db auth rest kong; do
    [ -z "$(container_named "$svc")" ] && missing+=("supabase_${svc}_*")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    REASON="containers not running: ${missing[*]}"
    REMEDY="supabase start"
    return 1
  fi
}

# The exact fault this script was written for: container-to-container name
# resolution through Docker's embedded DNS.
probe_container_dns() {
  local auth db
  auth=$(container_named auth)
  db=$(container_named db)
  if ! run_bounded 10 docker exec "$auth" getent hosts "$db"; then
    REASON="the auth container cannot resolve the db container's hostname (Docker embedded DNS is degraded)"
    REMEDY="colima restart && supabase start"
    return 1
  fi
}

# Kong -> GoTrue -> Postgres. A DELIBERATELY nonexistent user: GoTrue must query
# the users table to conclude "invalid credentials", so a 400 proves it reached
# Postgres. Depending on a real fixture user would make this fail during a
# legitimate db reset, when the users table is briefly empty.
probe_auth_to_postgres() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
    -d '{"email":"preflight-probe-nonexistent@invalid.local","password":"x"}' 2>/dev/null)
  # 400 = reached Postgres and rejected the credentials (the healthy answer).
  # 000 = curl timed out, which is how the degraded stack actually presented.
  case "$code" in
    400|200) return 0 ;;
    000) REASON="GoTrue timed out reaching Postgres (no response in 8s)"
         REMEDY="colima restart && supabase start"; return 1 ;;
    *)   REASON="GoTrue could not reach Postgres (HTTP $code from /auth/v1/token)"
         REMEDY="colima restart && supabase start"; return 1 ;;
  esac
}

# Kong -> PostgREST. Schema-independent: the root endpoint answers from the
# schema cache, so this stays valid mid-migration when tables come and go.
probe_rest() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    -H "apikey: $ANON_KEY" "$SUPABASE_URL/rest/v1/" 2>/dev/null)
  case "$code" in
    200) return 0 ;;
    000) REASON="PostgREST did not respond within 8s"
         REMEDY="supabase stop && supabase start"; return 1 ;;
    *)   REASON="PostgREST returned HTTP $code"
         REMEDY="supabase stop && supabase start"; return 1 ;;
  esac
}

check_all() {
  REASON=""; REMEDY=""
  probe_docker         || return 1
  probe_containers     || return 1
  probe_container_dns  || return 1
  probe_auth_to_postgres || return 1
  probe_rest           || return 1
  return 0
}

# ── Repair, serialised across concurrent sessions ─────────────────────────────
# Several agent sessions share one stack. Restarting it under another session's
# running tests is worse than the degradation itself, so repair is mutually
# exclusive. A healthy stack means NOBODY repairs, which is why this is safe to
# leave on by default: contention only arises when the stack is genuinely broken.
#
# mkdir is the atomic primitive — macOS ships no flock.
LOCK_DIR="${TMPDIR:-/tmp}/apex-stack-repair.lock"
LOCK_HELD=0

acquire_lock() {
  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    # Reap a lock whose owner died mid-repair.
    local owner
    owner=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      log "  (clearing a stale repair lock from dead pid $owner)"
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [ "$waited" -eq 0 ]; then
      log "  another session is repairing the stack — waiting…"
    fi
    sleep 3
    waited=$((waited + 3))
    if [ "$waited" -ge 180 ]; then
      fail "timed out after 180s waiting for another session's repair to finish"
      return 1
    fi
    # The other session may have already fixed it; re-probe before queueing.
    if check_all; then
      log "  another session repaired the stack"
      return 2
    fi
  done
  echo $$ > "$LOCK_DIR/pid"
  LOCK_HELD=1
}

release_lock() {
  [ "$LOCK_HELD" = 1 ] && rm -rf "$LOCK_DIR"
  LOCK_HELD=0
}

cleanup() {
  release_lock
  rm -f "${TMPDIR:-/tmp}/apex-preflight-$$.out"
}
trap cleanup EXIT INT TERM

# Containers need time to accept connections after any restart, so each rung
# polls rather than probing once. Measured against a real induced outage: a
# single immediate probe reported failure on a rung that was actually working,
# and escalated all the way to a VM restart for a stopped container.
wait_for_healthy() {
  local deadline=$1 waited=0
  while [ "$waited" -lt "$deadline" ]; do
    check_all && return 0
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# Escalating repair, cheapest rung first.
#
# Rung 1 is `docker start`, NOT `supabase start`: the CLI treats a project whose
# containers merely stopped as already running and does nothing, so a single
# dead container would otherwise escalate to a full VM restart — four minutes
# instead of seconds. Verified by stopping a container and watching it happen.
repair() {
  local stopped
  stopped=$(docker ps -a --format '{{.Names}} {{.State}}' 2>/dev/null \
    | awk '$1 ~ /^supabase_/ && $2 != "running" { print $1 }')
  if [ -n "$stopped" ]; then
    log "  repairing: docker start $(echo "$stopped" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    docker start $stopped >/dev/null 2>&1
    if wait_for_healthy 45; then
      log "  recovered after: docker start"
      return 0
    fi
    log "  still failing: $REASON"
  fi

  local rung
  for rung in "supabase stop && supabase start" "colima restart && supabase start"; do
    log "  repairing: $rung"
    eval "$rung" >/dev/null 2>&1
    if wait_for_healthy 90; then
      log "  recovered after: $rung"
      return 0
    fi
    log "  still failing: $REASON"
  done
  return 1
}

# ── Main ──────────────────────────────────────────────────────────────────────
if check_all; then
  log "preflight: local Supabase stack is functionally healthy"
  exit 0
fi

# Check-only: report the cause and the hand fix.
if [ "$FIX" != 1 ]; then
  fail "$REASON"
  fail "fix it with:  $REMEDY"
  fail "or re-run with --fix to repair automatically"
  exit 1
fi

# --fix: hold the reason until we know the outcome. Printing it up front made a
# successful auto-repair look like an unresolved error, which defeats the point
# of a check that is supposed to remove confusion.
BROKEN_BECAUSE="$REASON"
log "preflight: stack degraded ($BROKEN_BECAUSE) — repairing"

acquire_lock
case $? in
  2) # another session fixed it while we waited
     echo "preflight: stack was degraded ($BROKEN_BECAUSE); another session repaired it" >&2
     exit 0 ;;
  1) fail "$BROKEN_BECAUSE"
     fail "could not acquire the repair lock"
     exit 1 ;;
esac

if repair; then
  release_lock
  # Printed even under --quiet: a silent repair hides a real signal that the
  # machine's Docker/Colima state is drifting and may need a rebuild.
  echo "preflight: stack was degraded ($BROKEN_BECAUSE) — repaired, continuing" >&2
  exit 0
fi

release_lock
fail "$BROKEN_BECAUSE"
fail "could not repair the stack automatically. Last failure: $REASON"
fail "try manually:  colima delete && colima start --cpu 4 --memory 4 && supabase start"
exit 1
