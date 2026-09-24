#!/usr/bin/env bash
# Serialize a shared resource across every session and worktree on this machine.
#
#   with-lock.sh <name> <command> [args...]
#   with-lock.sh db npm run db:reset
#
# The lock lives in the primary checkout's .claude/state/, so every worktree
# contends for the same path. A busy lock prints who holds it and waits up to
# LOCK_WAIT seconds (default 600). Nested use of the same lock is free — the
# wrapper exports LOCK_HELD_<name>=1, so a wrapped command that reaches this
# script again just runs, no deadlock.
#
# The primitive is an atomic mkdir, not flock: macOS ships no flock. mkdir is
# not released by the kernel when the holder dies, so the holder's pid is
# recorded and a contender reaps the lock only once that pid is provably gone.
# Reaping is best-effort: two contenders that both see the same dead pid can
# race, so keep critical sections idempotent where possible. A pid is
# machine-local; do not put the state dir on a network share.
set -euo pipefail

[ $# -ge 2 ] || { sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
name=$1; shift
case "$name" in *[!A-Za-z0-9_]*) echo "with-lock: name must be [A-Za-z0-9_]" >&2; exit 64 ;; esac

held_var="LOCK_HELD_$name"
if [ "${!held_var:-}" = 1 ]; then exec "$@"; fi

primary=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
state="${LOCK_STATE_DIR:-$primary/.claude/state}"
mkdir -p "$state"
lock="$state/$name.lock.d"
wait_secs="${LOCK_WAIT:-600}"

reap_if_stale() {
  local pid; pid=$(cat "$lock/pid" 2>/dev/null || true)
  [ -n "$pid" ] || return 1            # no pid yet = holder mid-acquire, not stale
  if kill -0 "$pid" 2>/dev/null || ps -p "$pid" >/dev/null 2>&1; then return 1; fi
  echo "── with-lock: clearing stale '$name' lock from dead pid $pid" >&2
  rm -rf "$lock"
}

announced=0
SECONDS=0
until mkdir "$lock" 2>/dev/null; do
  reap_if_stale && continue
  if [ "$announced" -eq 0 ]; then
    announced=1
    echo "── '$name' is locked by: $(cat "$lock/holder" 2>/dev/null || echo unknown)" >&2
    echo "   waiting up to ${wait_secs}s (LOCK_WAIT overrides)" >&2
  fi
  if [ "$SECONDS" -ge "$wait_secs" ]; then
    echo "── with-lock: gave up after ${wait_secs}s; '$name' is still in use" >&2
    exit 75
  fi
  sleep 1
done

echo "$$" > "$lock/pid"
printf 'pid %s in %s since %s: %s\n' "$$" "$PWD" "$(date +%FT%T)" "$*" > "$lock/holder"
trap 'rm -rf "$lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export "$held_var=1"
"$@"
