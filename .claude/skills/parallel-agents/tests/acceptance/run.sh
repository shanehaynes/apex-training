#!/usr/bin/env bash
# Run every acceptance suite against one implementation of the skill.
#
#   SKILL_ROOT=<dir containing scripts/ and hooks/> bash tests/acceptance/run.sh
#   (default SKILL_ROOT: the repo root two levels up)
#
# Prints one PASS/FAIL line per case, a SUMMARY line per component and a
# TOTAL line. Exit 0 iff every case passed. A suite that dies without its
# SUMMARY line is reported as a FAIL, never silently skipped.
set -u
here=$(cd "$(dirname "$0")" && pwd -P)
SKILL_ROOT=${SKILL_ROOT:-$(cd "$here/../.." && pwd -P)}
SKILL_ROOT=$(cd "$SKILL_ROOT" && pwd -P) || { echo "run: SKILL_ROOT not found" >&2; exit 2; }
export SKILL_ROOT
echo "── acceptance suite against SKILL_ROOT=$SKILL_ROOT"

total_pass=0 total_fail=0
log=$(mktemp "${TMPDIR:-/tmp}/accept-run.XXXXXX")
trap 'rm -f "$log"' EXIT

run_suite() { # run_suite <component> <command…>
  local comp=$1 rc line p f
  shift
  "$@" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  line=$(grep -E "^SUMMARY $comp pass=[0-9]+ fail=[0-9]+$" "$log" | tail -1)
  if [ -z "$line" ]; then
    echo "FAIL $comp: suite crashed (exit $rc) before reporting a SUMMARY"
    p=$(grep -c "^PASS $comp:" "$log")
    f=$(( $(grep -c "^FAIL $comp:" "$log") + 1 ))
  else
    p=$(printf '%s' "$line" | sed -E 's/.*pass=([0-9]+).*/\1/')
    f=$(printf '%s' "$line" | sed -E 's/.*fail=([0-9]+).*/\1/')
    if [ "$f" -eq 0 ] && [ "$rc" -ne 0 ]; then
      echo "FAIL $comp: suite exited $rc despite no failing case"
      f=1
    fi
  fi
  total_pass=$((total_pass + p))
  total_fail=$((total_fail + f))
}

if command -v node >/dev/null 2>&1; then NODE=node; else NODE=""; fi
node_suite() {
  if [ -z "$NODE" ]; then echo "FAIL $1: node not found on PATH"; return 1; fi
  "$NODE" "$2"
}

run_suite lane bash "$here/lane.accept.sh"
run_suite combine bash "$here/combine.accept.sh"
run_suite fleet node_suite fleet "$here/fleet.accept.test.mjs"
run_suite guard node_suite guard "$here/guard.accept.test.mjs"
run_suite package node_suite package "$here/package.accept.test.mjs"

echo "TOTAL pass=$total_pass fail=$total_fail"
[ "$total_fail" -eq 0 ]
