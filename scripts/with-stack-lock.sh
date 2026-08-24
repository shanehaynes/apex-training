#!/usr/bin/env bash
# Serialize use of the shared local Supabase stack across sessions. One
# Postgres serves the whole machine, and `npm run e2e:live` /
# `npm run db:reset-local` reset whole tables — two sessions running them at
# once corrupt each other's fixtures (CONTRIBUTING.md, "The local Supabase
# stack is shared"). This turns "one session at a time" from prose into flock.
#
#   scripts/with-stack-lock.sh <command> [args...]
#
# The lock lives in the primary checkout's .claude/state/, so every worktree
# contends for the same file. A busy lock prints who holds it, then waits up
# to APEX_STACK_LOCK_WAIT seconds (default 600) — live e2e runs are long, and
# queueing is usually what you want. Nested use is free: the wrapper exports
# APEX_STACK_LOCKED=1, and a wrapped command that itself reaches this script
# (agent:check:full runs db:reset-local runs this) just runs, no deadlock.
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
lock="$state_dir/stack.lock"
holder="$state_dir/stack.lock.holder"
wait_secs="${APEX_STACK_LOCK_WAIT:-600}"

exec 9>"$lock"
if ! flock --nonblock 9; then
  echo "── shared stack is locked by: $(cat "$holder" 2>/dev/null || echo 'unknown — holder note missing')" >&2
  echo "   one session at a time (CONTRIBUTING.md); waiting up to ${wait_secs}s (APEX_STACK_LOCK_WAIT overrides)" >&2
  flock --timeout "$wait_secs" 9 || {
    echo "── gave up after ${wait_secs}s — the shared stack is still in use." >&2
    exit 1
  }
fi

printf 'pid %s in %s since %s: %s\n' "$$" "$PWD" "$(date +%FT%T)" "$*" >"$holder"
trap 'rm -f "$holder"' EXIT

export APEX_STACK_LOCKED=1
"$@"
