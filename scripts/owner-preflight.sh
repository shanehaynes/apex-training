#!/usr/bin/env bash
# The owner loop's gate (docs/specs/agent-ownership.md). The scheduled task
# `apex-owner` runs this first and stops on any non-zero exit; it runs
# `release` last.
#
#   scripts/owner-preflight.sh acquire   # every check, then take the run lock
#   scripts/owner-preflight.sh release   # drop the run lock
#
# It is in HELD (scripts/merge-policy.mjs): it holds the kill switch and the
# no-API rule, so an edit to it is an edit to the loop's authority.
#
# Refusals, each with its reason on stdout:
#   3  the run would bill the API: ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK
#      or CLAUDE_CODE_USE_VERTEX is set. Claude Code bills the API, not the
#      subscription, when one is (Shane: "no API spending").
#   4  a kill switch: .claude/OWNER_OFF or .claude/AUTOMERGE_OFF in the primary
#   5  the primary checkout is dirty or not on main
#   6  another owner run holds the lock
#
# The lock is an atomic mkdir, like scripts/with-stack-lock.sh, but it outlives
# any one process: the run is a Claude session that calls this, then many
# other commands, then `release`. So it records the time it was taken, and a
# lock older than OWNER_LOCK_MAX_SECS (default 4 hours, one cadence) is stale:
# its run died without releasing.
set -euo pipefail

cmd=${1:-}
case "$cmd" in acquire|release) ;; *)
  echo "usage: scripts/owner-preflight.sh acquire|release" >&2
  exit 64
  ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd -P)
primary=$(cd "$root" && cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
state="$primary/.claude/state"
lock="$state/owner.lock.d"
max=${OWNER_LOCK_MAX_SECS:-14400}

if [ "$cmd" = release ]; then
  rm -rf "$lock"
  echo "owner-preflight: released"
  exit 0
fi

for var in ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX; do
  if [ -n "${!var:-}" ]; then
    echo "owner-preflight: refused — $var is set, so this run would bill the API instead of the subscription"
    exit 3
  fi
done

for f in OWNER_OFF AUTOMERGE_OFF; do
  if [ -e "$primary/.claude/$f" ]; then
    echo "owner-preflight: refused — kill switch $primary/.claude/$f exists"
    exit 4
  fi
done

branch=$(git -C "$primary" symbolic-ref --short -q HEAD || echo "(detached)")
if [ "$branch" != main ]; then
  echo "owner-preflight: refused — the primary checkout is on $branch, not main"
  exit 5
fi
dirty=$(git -C "$primary" status --porcelain)
if [ -n "$dirty" ]; then
  echo "owner-preflight: refused — the primary checkout is dirty:"
  printf '%s\n' "$dirty" | sed 's/^/  /'
  exit 5
fi

mkdir -p "$state"
if ! mkdir "$lock" 2>/dev/null; then
  since=$(cat "$lock/since" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ "$since" -gt 0 ] && [ $(( now - since )) -lt "$max" ]; then
    echo "owner-preflight: refused — another owner run holds the lock since $(date -r "$since" '+%F %T')"
    exit 6
  fi
  if [ "$since" -eq 0 ] && [ $(( now - $(stat -f %m "$lock") )) -lt 60 ]; then
    echo "owner-preflight: refused — another owner run is taking the lock right now"
    exit 6
  fi
  echo "owner-preflight: clearing a stale lock (taken $(( (now - since) / 60 )) min ago)"
  rm -rf "$lock"
  mkdir "$lock"
fi
date +%s > "$lock/since"
echo "owner-preflight: ok — primary $primary, lock taken"
