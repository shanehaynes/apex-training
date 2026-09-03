#!/usr/bin/env bash
# Serialize use of the shared local Supabase stack across sessions. One
# Postgres serves the whole machine, and `npm run e2e:live` /
# `npm run db:reset-local` reset whole tables — two sessions running them at
# once corrupt each other's fixtures (CONTRIBUTING.md, "The local Supabase
# stack is shared"). This turns "one session at a time" from prose into a lock.
#
#   scripts/with-stack-lock.sh <command> [args...]
#
# The lock lives in the primary checkout's .claude/state/, so every worktree
# contends for the same path. A busy lock prints who holds it, then waits up
# to APEX_STACK_LOCK_WAIT seconds (default 600) — live e2e runs are long, and
# queueing is usually what you want. Nested use is free: the wrapper exports
# APEX_STACK_LOCKED=1, and a wrapped command that itself reaches this script
# (agent:check:full runs db:reset-local runs this) just runs, no deadlock.
#
# The primitive is an atomic `mkdir`, not flock: macOS ships no flock, and
# Mac sessions run this stack too (docs/ios/MASTER.md). The cost of mkdir is
# that the kernel does not release it when the holder dies, so the lock
# directory records the holder's pid and a contender reaps it when that pid
# is gone.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/with-stack-lock.sh <command> [args...]" >&2
  exit 64
fi

if [ "${APEX_STACK_LOCKED:-}" = 1 ]; then
  exec "$@"
fi

# Anchor the lock on the primary checkout WITHOUT changing the cwd the
# wrapped command runs in. APEX_STACK_LOCK_DIR exists for the tests, which
# must not contend with a real session's lock.
script_root=$(cd "$(dirname "$0")/.." && pwd -P)
primary=$(cd "$script_root" && cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
state_dir="${APEX_STACK_LOCK_DIR:-$primary/.claude/state}"
mkdir -p "$state_dir"
lock="$state_dir/stack.lock.d"
holder="$state_dir/stack.lock.holder"
wait_secs="${APEX_STACK_LOCK_WAIT:-600}"

# A holder that exited without cleaning up (SIGKILL, machine reboot with a
# non-tmp state dir) leaves the directory behind. Only a lock whose recorded
# pid is provably not running is reaped; a directory with no pid file yet is
# a holder mid-acquire, not a stale one.
reap_if_stale() {
  local pid
  pid=$(cat "$lock/pid" 2>/dev/null || true)
  [ -n "$pid" ] || return 1
  if ps -p "$pid" >/dev/null 2>&1; then
    return 1
  fi
  echo "── clearing a stale stack lock from dead pid $pid" >&2
  rm -rf "$lock"
}

announced=0
SECONDS=0
until mkdir "$lock" 2>/dev/null; do
  if reap_if_stale; then
    continue
  fi
  if [ "$announced" -eq 0 ]; then
    announced=1
    echo "── shared stack is locked by: $(cat "$holder" 2>/dev/null || echo 'unknown — holder note missing')" >&2
    echo "   one session at a time (CONTRIBUTING.md); waiting up to ${wait_secs}s (APEX_STACK_LOCK_WAIT overrides)" >&2
  fi
  if [ "$SECONDS" -ge "$wait_secs" ]; then
    echo "── gave up after ${wait_secs}s — the shared stack is still in use." >&2
    exit 1
  fi
  sleep 1
done

echo "$$" >"$lock/pid"
printf 'pid %s in %s since %s: %s\n' "$$" "$PWD" "$(date +%FT%T)" "$*" >"$holder"
trap 'rm -rf "$lock"; rm -f "$holder"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export APEX_STACK_LOCKED=1
"$@"
