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
# The lock is the kernel's: acquire starts one background process that holds
# `flock` on .claude/state/owner.lock and, while it lives, keeps the Mac awake
# (caffeinate; plain sleep where there is none). It lives at most
# OWNER_LOCK_MAX_SECS (default 3h45m: under the 4-hour cadence, so a dead run
# costs one cycle, and above the run's 3h30m budget), so a run that dies
# without releasing frees the lock by itself. The token is the holder's pid;
# release kills it only if it is still the holder of this lock, so a run that
# overstayed cannot free the next run's lock.
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
holder="$state/owner.lock.pid"
max=${OWNER_LOCK_MAX_SECS:-13500}

FLOCK=$(command -v flock || echo /opt/homebrew/bin/flock)
if command -v caffeinate >/dev/null 2>&1; then hold=(caffeinate -i -s -t "$max"); else hold=(sleep "$max"); fi

# Is pid $1 the flock holding our lock file?
is_holder() {
  [ -n "$1" ] && ps -p "$1" -o command= 2>/dev/null | grep -qF -- "$lock"
}

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
  if [ -z "$token" ] || ! is_holder "$token"; then
    echo "owner-preflight: not released — $token is not this lock's holder (it may have expired)"
    exit 7
  fi
  kids=$(pgrep -P "$token" || true)
  # shellcheck disable=SC2086 # pids
  kill "$token" $kids 2>/dev/null || true
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
# flock -n exits at once when another process holds the lock; otherwise it
# runs the holder. -o keeps the lock on flock itself rather than on the
# holder it runs, so killing flock frees it. Started detached, so it outlives
# this script.
nohup "$FLOCK" -n -o "$lock" "${hold[@]}" >/dev/null 2>&1 &
pid=$!
sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  other=$(cat "$holder" 2>/dev/null || true)
  echo "owner-preflight: refused — another owner run holds the lock${other:+ (holder pid $other)}"
  exit 6
fi
echo "$pid" > "$holder"
echo "owner-preflight: ok — primary $primary, lock taken"
echo "token=$pid"
