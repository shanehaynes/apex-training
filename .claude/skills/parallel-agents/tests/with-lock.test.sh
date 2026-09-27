#!/usr/bin/env bash
# Tests for scripts/with-lock.sh (stale reaping, grace periods, exclusivity).
#
#   bash tests/with-lock.test.sh      # one PASS/FAIL line per case; exit 0 iff all pass
#   WITH_LOCK_TEST_ONLY=REGEX         # run only the cases whose name matches
#   WITH_LOCK_UNDER_TEST=/path/with-lock.sh   # test another copy
#
# Each case gets a throwaway git repo (the lock lives in its .claude/state/)
# under one mktemp -d directory, removed on exit.
set -u

HERE=$(cd "$(dirname "$0")" && pwd -P)
WL="${WITH_LOCK_UNDER_TEST:-$HERE/../scripts/with-lock.sh}"
TMP_ROOT=$(mktemp -d)
TMP_ROOT=$(cd "$TMP_ROOT" && pwd -P)
BG_PIDS=""
cleanup() { for p in $BG_PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$TMP_ROOT"; }
trap cleanup EXIT
export GIT_CONFIG_NOSYSTEM=1 HOME="$TMP_ROOT/home"
mkdir -p "$HOME"
unset LOCK_STATE_DIR LOCK_NOPID_GRACE LOCK_WAIT LOCK_HELD_t || true

pass=0; failn=0; n=0

fail() { echo "ASSERT: $*"; exit 1; }
eq() { [ "$1" = "$2" ] || fail "${3:-values differ}: expected [$2], got [$1]"; }
wl() { bash "$WL" "$@"; }

# Fresh repo; cwd = repo; $L = lock dir for name "t".
fixture() {
  R=$(mktemp -d "$TMP_ROOT/case.XXXXXX"); R=$(cd "$R" && pwd -P)
  git init -q "$R"; cd "$R"
  mkdir -p .claude/state
  L="$R/.claude/state/t.lock.d"
}
dead_pid() { sh -c 'exit 0' & local p=$!; wait "$p" 2>/dev/null; echo "$p"; }
age_it() { touch -t 202001010000 "$@"; }   # make paths ~years old (BSD and GNU touch)

run() {
  local name=$1 log rc
  n=$((n + 1)); log="$TMP_ROOT/log.$n"
  ( set -e; "$name" ) > "$log" 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then echo "PASS $name"; pass=$((pass + 1))
  else echo "FAIL $name"; sed 's/^/     /' "$log" | tail -n 25; failn=$((failn + 1)); fi
}

# ── cases ────────────────────────────────────────────────────────────────────
t_runs_command_and_releases() {
  fixture
  eq "$(wl t echo hi)" hi "output"
  [ ! -e "$L" ] || fail "lock left behind"
  RC=0; wl t sh -c 'exit 7' || RC=$?
  eq "$RC" 7 "exit code propagated"
  [ ! -e "$L" ] || fail "lock left behind after failure"
}

t_usage_and_bad_name_exit_64() {
  fixture
  RC=0; wl t >/dev/null 2>&1 || RC=$?; eq "$RC" 64 "no command"
  RC=0; wl 'bad name' true >/dev/null 2>&1 || RC=$?; eq "$RC" 64 "bad name"
}

t_nested_same_lock_is_free() {
  fixture
  eq "$(LOCK_WAIT=2 wl t bash "$WL" t echo nested)" nested "nested"
}

t_busy_lock_times_out_75() {
  fixture
  mkdir "$L"; sleep 30 & live=$!; BG_PIDS="$BG_PIDS $live"; echo "$live" > "$L/pid"
  RC=0; LOCK_WAIT=2 wl t true 2>/dev/null || RC=$?
  eq "$RC" 75 "exit"
  kill "$live"
}

t_a13_nopid_lock_older_than_grace_is_reaped() {
  fixture
  mkdir "$L"; age_it "$L"
  RC=0; LOCK_WAIT=5 LOCK_NOPID_GRACE=2 wl t true 2>/dev/null || RC=$?
  eq "$RC" 0 "a lock dir with no pid file wedged the lock"
  [ ! -e "$L" ] || fail "lock left behind"
}

t_a13_nopid_lock_younger_than_grace_is_kept() {
  fixture
  mkdir "$L"
  RC=0; LOCK_WAIT=2 LOCK_NOPID_GRACE=30 wl t true 2>/dev/null || RC=$?
  eq "$RC" 75 "fresh no-pid lock (holder mid-acquire) was taken"
  [ -d "$L" ] || fail "fresh no-pid lock removed"
}

t_a13_dead_pid_with_young_pid_file_is_kept() {
  fixture
  mkdir "$L"; dead_pid > "$L/pid"
  RC=0; LOCK_WAIT=2 LOCK_NOPID_GRACE=30 wl t true 2>/dev/null || RC=$?
  eq "$RC" 75 "lock with a pid file younger than the grace period was reaped"
  [ -f "$L/pid" ] || fail "lock removed"
}

t_a13_dead_pid_with_old_pid_file_is_reaped() {
  fixture
  mkdir "$L"; dead_pid > "$L/pid"; age_it "$L/pid" "$L"
  RC=0; LOCK_WAIT=5 LOCK_NOPID_GRACE=2 wl t true 2>/dev/null || RC=$?
  eq "$RC" 0 "stale lock not reaped"
}

t_a13_live_pid_is_never_reaped_even_when_old() {
  fixture
  mkdir "$L"; sleep 30 & live=$!; BG_PIDS="$BG_PIDS $live"
  echo "$live" > "$L/pid"; age_it "$L/pid" "$L"
  RC=0; LOCK_WAIT=2 LOCK_NOPID_GRACE=1 wl t true 2>/dev/null || RC=$?
  eq "$RC" 75 "live holder's lock taken"
  eq "$(cat "$L/pid")" "$live" "live holder's lock replaced"
  kill "$live"
}

t_a13_stale_reap_lock_does_not_wedge() {
  fixture
  mkdir "$L"; dead_pid > "$L/pid"; age_it "$L/pid" "$L"
  mkdir "$L/../t.reap.d"; dead_pid > "$L/../t.reap.d/pid"; age_it "$L/../t.reap.d/pid" "$L/../t.reap.d"
  RC=0; LOCK_WAIT=8 LOCK_NOPID_GRACE=2 wl t true 2>/dev/null || RC=$?
  eq "$RC" 0 "abandoned reap lock wedged the lock"
}

t_a13_exit_never_removes_someone_elses_lock() {
  fixture
  # The command hands the lock dir to another pid (as a wrongful reaper would);
  # on exit the wrapper must leave it alone.
  wl t sh -c "echo 999999 > '$L/pid'"
  [ -d "$L" ] || fail "wrapper removed a lock that was no longer its own"
}

# N contenders, a planted stale lock, a read-modify-write critical section that
# sleeps between read and write: any overlap loses an update.
t_a13_concurrent_contenders_after_stale_lock_are_exclusive() {
  fixture
  local trial i pids rc bad=0
  for trial in 1 2 3 4 5; do
    rm -rf "$L" .claude/state/t.reap.d
    mkdir "$L"; dead_pid > "$L/pid"; age_it "$L/pid" "$L"
    echo 0 > counter
    pids=""
    for i in 1 2 3 4 5 6; do
      LOCK_WAIT=60 LOCK_NOPID_GRACE=1 bash "$WL" t sh -c 'n=$(cat counter); sleep 0.3; echo $((n + 1)) > counter' 2>/dev/null &
      pids="$pids $!"
    done
    rc=0; for i in $pids; do wait "$i" || rc=1; done
    [ "$rc" -eq 0 ] || fail "trial $trial: a contender failed"
    [ "$(cat counter)" = 6 ] || { echo "trial $trial: counter=$(cat counter)"; bad=$((bad + 1)); }
  done
  eq "$bad" 0 "trials with lost updates"
}

# ── round 4: A52 ─────────────────────────────────────────────────────────────
kill_tree() {
  local c
  for c in $(ps -A -o pid= -o ppid= | awk -v p="$1" '$2 == p { print $1 }'); do kill_tree "$c"; done
  kill "$1" 2>/dev/null || true
}
# run_bounded SECS CMD…: RC = exit code, or 124 if it had to be killed.
run_bounded() {
  local secs=$1 pid start; shift
  "$@" >/dev/null 2>&1 & pid=$!
  start=$(date +%s)
  while kill -0 "$pid" 2>/dev/null && [ $(( $(date +%s) - start )) -lt "$secs" ]; do sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then kill_tree "$pid"; wait "$pid" 2>/dev/null || true; RC=124; return; fi
  RC=0; wait "$pid" || RC=$?
}

t_a52_non_numeric_settings_exit_64() {
  fixture
  mkdir "$L"; sleep 30 & live=$!; BG_PIDS="$BG_PIDS $live"; echo "$live" > "$L/pid"
  LOCK_WAIT=2s run_bounded 8 bash "$WL" t true
  eq "$RC" 64 "LOCK_WAIT=2s (124 = waited forever)"
  kill "$live"; rm -rf "$L"
  LOCK_NOPID_GRACE=abc run_bounded 8 bash "$WL" t true
  eq "$RC" 64 "LOCK_NOPID_GRACE=abc"
  LOCK_WAIT='' run_bounded 8 bash "$WL" t true
  eq "$RC" 0 "empty LOCK_WAIT means the default"
}

# Shim a tool so a deterministic interleaving can be forced at one point.
shim() {  # shim NAME SCRIPT-BODY  → $SHIMDIR/NAME, real tool as $REAL
  SHIMDIR="$R/shim"; mkdir -p "$SHIMDIR"
  printf '#!/bin/sh\nREAL=%s\n%s\n' "$(command -v "$1")" "$2" > "$SHIMDIR/$1"; chmod +x "$SHIMDIR/$1"
}

# While this process holds the reap lock, another breaks it and takes it (as
# a TOCTOU breaker would). Releasing must not remove that other reap lock.
t_a52_reap_dir_removed_only_by_its_creator() {
  fixture
  mkdir "$L"; dead_pid > "$L/pid"; age_it "$L/pid" "$L"
  export SHIM_REAP="$R/.claude/state/t.reap.d" SHIM_MARK="$R/mark"
  shim stat 'if [ -f "$SHIM_REAP/pid" ] && [ ! -e "$SHIM_MARK" ]; then echo 4242424 > "$SHIM_REAP/pid"; touch "$SHIM_MARK"; fi
exec "$REAL" "$@"'
  RC=0; PATH="$SHIMDIR:$PATH" LOCK_WAIT=5 LOCK_NOPID_GRACE=1 bash "$WL" t true 2>/dev/null || RC=$?
  [ -e "$SHIM_MARK" ] || fail "interleaving not reached"
  [ -d "$SHIM_REAP" ] || fail "another process's reap lock was removed"
  eq "$(cat "$SHIM_REAP/pid")" 4242424 "reap lock owner"
}

# A breaker judges an abandoned reap lock stale; before it acts, that lock is
# broken by someone else and a live reaper creates a fresh one. The breaker
# must not remove the live reaper's lock.
t_a52_breaker_never_removes_a_live_reap_dir() {
  fixture
  mkdir "$L"; dead_pid > "$L/pid"; age_it "$L/pid" "$L"
  export SHIM_REAP="$R/.claude/state/t.reap.d" SHIM_MARK="$R/mark"
  mkdir "$SHIM_REAP"; dead_pid > "$SHIM_REAP/pid"; age_it "$SHIM_REAP/pid" "$SHIM_REAP"
  sleep 30 & live=$!; BG_PIDS="$BG_PIDS $live"; export SHIM_LIVE=$live
  shim cat 'if [ "$1" = "$SHIM_REAP/pid" ] && [ ! -e "$SHIM_MARK" ]; then
  "$REAL" "$1"; rm -rf "$SHIM_REAP"; mkdir "$SHIM_REAP"; echo "$SHIM_LIVE" > "$SHIM_REAP/pid"; touch "$SHIM_MARK"; exit 0
fi
exec "$REAL" "$@"'
  RC=0; PATH="$SHIMDIR:$PATH" LOCK_WAIT=3 LOCK_NOPID_GRACE=1 bash "$WL" t true 2>/dev/null || RC=$?
  [ -e "$SHIM_MARK" ] || fail "interleaving not reached"
  [ -d "$SHIM_REAP" ] || fail "a live reaper's lock was removed by a breaker"
  eq "$(cat "$SHIM_REAP/pid")" "$live" "live reaper's lock replaced"
  eq "$RC" 75 "waited for the live reaper"
  kill "$live"
}

for t in $(declare -F | awk '{print $3}' | grep '^t_' | grep -E "${WITH_LOCK_TEST_ONLY:-.}"); do run "$t"; done
echo "── $pass passed, $failn failed ($n cases)"
[ "$failn" -eq 0 ]
