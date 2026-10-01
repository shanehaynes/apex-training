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
# recorded and a contender reaps the lock only once it is provably abandoned:
#   - pid file present: its pid is gone AND the file is at least
#     LOCK_NOPID_GRACE seconds old (default 10);
#   - no pid file (holder died between mkdir and writing it): the lock
#     directory is at least LOCK_NOPID_GRACE seconds old.
# Reaping is serialized by a second mkdir lock (<name>.reap.d) and the
# staleness is re-checked inside it, so two contenders never both reap and a
# fresh lock is never removed. A holder removes the lock on exit only while
# the pid file is still its own. A pid is machine-local; do not put the state
# dir on a network share.
#
# Known limitation: SIGKILL of this wrapper while its child command is still
# running leaves the child working after the pid is gone; once the grace
# period passes a second holder can get in alongside it.
set -euo pipefail

[ $# -ge 2 ] || { sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
name=$1; shift
case "$name" in *[!A-Za-z0-9_]*) echo "with-lock: name must be [A-Za-z0-9_]" >&2; exit 64 ;; esac
# Numeric settings: a value like "2s" would otherwise make every comparison
# fail and the wait loop spin forever.
for v in LOCK_WAIT LOCK_NOPID_GRACE; do
  case "${!v:-0}" in *[!0-9]*) echo "with-lock: $v must be a whole number of seconds (got '${!v}')" >&2; exit 64 ;; esac
done

held_var="LOCK_HELD_$name"
if [ "${!held_var:-}" = 1 ]; then exec "$@"; fi

primary=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
state="${LOCK_STATE_DIR:-$primary/.claude/state}"
mkdir -p "$state"
lock="$state/$name.lock.d"
wait_secs="${LOCK_WAIT:-600}"

reap="$state/$name.reap.d"
grace="${LOCK_NOPID_GRACE:-10}"

# Seconds since PATH was modified (GNU stat, then BSD stat); fails if unknown.
age_of() {
  local m
  m=$(stat --format=%Y "$1" 2>/dev/null) || m=$(stat -f %m "$1" 2>/dev/null) || return 1
  case "$m" in ''|*[!0-9]*) return 1 ;; esac
  echo $(( $(date +%s) - m ))
}
pid_alive() { kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1; }

# is_stale DIR: succeeds only when the lock at DIR is provably abandoned.
# Anything it cannot establish (unreadable age, live pid) means "not stale".
is_stale() {
  local d=$1 pid a
  [ -d "$d" ] || return 1
  if [ -e "$d/pid" ]; then
    a=$(age_of "$d/pid") || return 1
    [ "$a" -ge "$grace" ] || return 1
    pid=$(cat "$d/pid" 2>/dev/null || true)
    case "$pid" in ''|*[!0-9]*) return 0 ;; esac   # old and unreadable: writer died mid-write
    if pid_alive "$pid"; then return 1; fi
    return 0
  fi
  a=$(age_of "$d") || return 1
  [ "$a" -ge "$grace" ]
}

# Break an abandoned reap lock. Only by an atomic rename to a name unique to
# this process: of several breakers at most one rename succeeds, and the
# winner inspects what it now owns. If that turns out not to be the stale
# directory it judged (another breaker got there first and a live reaper has
# since created a fresh one), it is put back untouched.
break_stale_reap() {
  local seen got tmp
  is_stale "$reap" || return 0
  seen=$(cat "$reap/pid" 2>/dev/null || true)
  tmp="$reap.broken.$$.${RANDOM}"
  mv "$reap" "$tmp" 2>/dev/null || return 0
  got=$(cat "$tmp/pid" 2>/dev/null || true)
  if [ "$got" = "$seen" ] && is_stale "$tmp"; then
    rm -rf "$tmp"
  elif [ ! -e "$reap" ]; then
    mv "$tmp" "$reap" 2>/dev/null || true
  fi
}

# The reap lock is removed only by the process that created it.
release_reap() { [ "$(cat "$reap/pid" 2>/dev/null || true)" = "$$" ] && rm -rf "$reap"; return 0; }

reap_if_stale() {
  is_stale "$lock" || return 1
  if ! mkdir "$reap" 2>/dev/null; then
    # Another contender is reaping (held for milliseconds); break its reap
    # lock only when that reaper is itself provably dead.
    break_stale_reap
    return 1
  fi
  echo "$$" > "$reap/pid"
  local reaped=1
  if is_stale "$lock"; then          # re-check under the reap lock
    echo "── with-lock: clearing stale '$name' lock ($(cat "$lock/holder" 2>/dev/null || echo 'no holder recorded'))" >&2
    rm -rf "$lock"
    reaped=0
  fi
  release_reap
  return "$reaped"
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
release_lock() { [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$$" ] && rm -rf "$lock"; return 0; }
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export "$held_var=1"
"$@"
