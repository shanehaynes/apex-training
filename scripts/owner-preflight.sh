#!/usr/bin/env bash
# The owner loop's gate (docs/specs/agent-ownership.md). The scheduled task
# `apex-owner` runs this first and stops on any non-zero exit; it runs
# `release` last.
#
#   scripts/owner-preflight.sh acquire           # every check, then take the run lock;
#                                                # prints "token=<t>" on success
#   scripts/owner-preflight.sh release <token>   # drop the lock, only if it is still <t>
#   scripts/owner-preflight.sh check-off         # exit 4 if a kill switch appeared mid-run
#
# It is in HELD (scripts/merge-policy.mjs): it holds the kill switch and the
# no-API rule, so an edit to it is an edit to the loop's authority.
#
# Refusals, each with its reason on stdout:
#   3  the run would bill the API: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
#      ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX or
#      CLAUDE_CODE_USE_FOUNDRY is set. Claude Code bills the API, not the
#      subscription, when one is (Shane: "no API spending").
#   4  a kill switch: .claude/OWNER_OFF or .claude/AUTOMERGE_OFF in the primary
#   5  the primary checkout is dirty or not on main
#   6  another owner run holds the lock
#
# The lock is a symlink whose target is "<since>.<token>": `ln -s` creates it
# atomically WITH its content, so there is no half-made lock to misread. It
# outlives any one process (the run is a Claude session that calls this, then
# many other commands, then `release`), so it records the time it was taken, and a
# lock older than OWNER_LOCK_MAX_SECS (default 3h45m: under the 4-hour cadence,
# so a dead run costs one cycle, and above the run's 3h30m budget) is stale.
# The token makes release safe: a run whose lock was reaped cannot release the
# next run's. A stale lock is reaped by renaming it aside and checking that
# what was moved is still the stale value read a moment before; if another run
# already replaced it, the rename is undone and this run refuses.
set -euo pipefail

cmd=${1:-}
case "$cmd" in acquire|release|check-off) ;; *)
  echo "usage: scripts/owner-preflight.sh acquire | release <token> | check-off" >&2
  exit 64
  ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd -P)
primary=$(cd "$root" && cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
state="$primary/.claude/state"
lock="$state/owner.lock"
max=${OWNER_LOCK_MAX_SECS:-13500}

stamp() { date -r "$1" '+%F %T' 2>/dev/null || date -d "@$1" '+%F %T'; }

kill_switch() {
  local f
  for f in OWNER_OFF AUTOMERGE_OFF; do
    if [ -e "$primary/.claude/$f" ]; then
      echo "owner-preflight: refused — kill switch $primary/.claude/$f exists"
      return 4
    fi
  done
}

if [ "$cmd" = check-off ]; then
  kill_switch || exit 4
  echo "owner-preflight: no kill switch"
  exit 0
fi

if [ "$cmd" = release ]; then
  token=${2:-}
  held=$(readlink "$lock" 2>/dev/null || true)
  if [ -z "$token" ] || [ "${held#*.}" != "$token" ]; then
    echo "owner-preflight: not released — the lock is not this run's (it may have been reaped as stale)"
    exit 7
  fi
  rm -f "$lock"
  echo "owner-preflight: released"
  exit 0
fi

for var in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY; do
  if [ -n "${!var:-}" ]; then
    echo "owner-preflight: refused — $var is set, so this run would bill the API instead of the subscription"
    exit 3
  fi
done

kill_switch || exit 4

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
now=$(date +%s)
token="$now-$$-$RANDOM"
if ! ln -s "$now.$token" "$lock" 2>/dev/null; then
  seen=$(readlink "$lock" 2>/dev/null || true)
  since=${seen%%.*}
  case "$since" in ''|*[!0-9]*) since=0 ;; esac
  if [ -n "$seen" ] && [ $(( now - since )) -lt "$max" ]; then
    echo "owner-preflight: refused — another owner run holds the lock since $(stamp "$since")"
    exit 6
  fi
  aside="$lock.reap.$$"
  if ! mv "$lock" "$aside" 2>/dev/null; then
    echo "owner-preflight: refused — another owner run reaped the stale lock first"
    exit 6
  fi
  if [ "$(readlink "$aside" 2>/dev/null || true)" != "$seen" ]; then
    mv "$aside" "$lock" 2>/dev/null || true
    echo "owner-preflight: refused — another owner run reaped the stale lock first"
    exit 6
  fi
  rm -f "$aside"
  if ! ln -s "$now.$token" "$lock" 2>/dev/null; then
    echo "owner-preflight: refused — another owner run took the lock first"
    exit 6
  fi
  echo "owner-preflight: cleared a stale lock"
fi
echo "owner-preflight: ok — primary $primary, lock taken"
echo "token=$token"
