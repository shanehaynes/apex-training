#!/usr/bin/env bash
# shellcheck disable=SC2034  # variables here are used by the sourcing suites
# Shared helpers for the bash acceptance suites. Sourced, not executed.
#
# A case is a function run in its own subshell with `set +e`. Assertions record
# failures into a per-case file instead of aborting, so one broken command
# never takes the harness down: every case ends in exactly one PASS or FAIL
# line, and each suite ends with a SUMMARY line that run.sh reads.

: "${SKILL_ROOT:?SKILL_ROOT must be set}"
: "${COMPONENT:?COMPONENT must be set}"

REAL_GIT=$(command -v git)
T_PASS=0
T_FAIL=0
SUITE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/accept.XXXXXX")
SUITE_TMP=$(cd "$SUITE_TMP" && pwd -P)
trap 'rm -rf "$SUITE_TMP"' EXIT

# Isolated git identity and config: never read or write the user's.
cat >"$SUITE_TMP/gitconfig" <<'CFG'
[user]
	name = Acceptance Test
	email = accept@example.invalid
[init]
	defaultBranch = main
[advice]
	detachedHead = false
[safe]
	directory = *
[commit]
	gpgsign = false
CFG
export GIT_CONFIG_GLOBAL="$SUITE_TMP/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR LOCK_STATE_DIR || true
unset LANE_PORT_DEFAULT LANE_PORT_BASE LANE_PORT_SPAN || true
export LOCK_WAIT=60

# Run with a timeout when one is available, so a hung implementation fails the
# case instead of hanging the suite.
to() {
  local secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

# ── assertions (inside a case) ──────────────────────────────────────────────
note() { printf '%s\n' "$*" >>"$CASE_FAILS"; }
check() { # check "description" <command…>   — passes when the command succeeds
  local d=$1; shift
  "$@" >/dev/null 2>&1 || note "$d"
}
check_not() {
  local d=$1; shift
  if "$@" >/dev/null 2>&1; then note "$d"; fi
}
eq() { # eq "description" actual expected
  [ "$2" = "$3" ] || note "$1 (got '$2', want '$3')"
}
ne() {
  [ "$2" != "$3" ] || note "$1 (got '$2', which must differ)"
}
rc_is() { # rc_is "what" expected — against $RC of the last run
  [ "$RC" = "$2" ] || note "$1: exit $RC, want $2; stderr: $(head -c 160 "$ERR" 2>/dev/null | tr '\n' ' ')"
}
out_has() { grep -Eq -- "$2" "$OUT" || note "$1: stdout lacks /$2/"; }
out_lacks() { if grep -Eq -- "$2" "$OUT"; then note "$1: stdout has /$2/"; fi; }
any_has() { cat "$OUT" "$ERR" | grep -Eq -- "$2" || note "$1: output lacks /$2/"; }

# ── case runner ─────────────────────────────────────────────────────────────
run_case() { # run_case "name" function
  local name=$1 fn=$2 rc
  # ONLY=<regex> runs just the matching cases (for debugging one amendment).
  if [ -n "${ONLY:-}" ] && ! printf '%s' "$name" | grep -Eq -- "$ONLY"; then return 0; fi
  CASE_FAILS="$SUITE_TMP/fails.$$.$RANDOM"
  : >"$CASE_FAILS"
  (
    set +e +u
    FX=""
    cleanup_fx() { [ -n "$FX" ] && [ -d "$FX" ] && rm -rf "$FX"; }
    trap cleanup_fx EXIT
    "$fn"
  ) >"$SUITE_TMP/case.log" 2>&1
  rc=$?
  if [ ! -s "$CASE_FAILS" ] && [ "$rc" -ne 0 ]; then
    echo "case aborted with exit $rc" >>"$CASE_FAILS"
  fi
  if [ -s "$CASE_FAILS" ]; then
    T_FAIL=$((T_FAIL + 1))
    echo "FAIL $COMPONENT: $name — $(head -3 "$CASE_FAILS" | tr '\n' ';' | sed 's/;$//')"
  else
    T_PASS=$((T_PASS + 1))
    echo "PASS $COMPONENT: $name"
  fi
  rm -f "$CASE_FAILS"
}

summary() {
  echo "SUMMARY $COMPONENT pass=$T_PASS fail=$T_FAIL"
  [ "$T_FAIL" -eq 0 ]
}

# ── fixtures ────────────────────────────────────────────────────────────────
# make_fixture [clone-dir]: $FX (deleted after the case), $ORIGIN (bare), $PRIMARY (clone,
# resolved), $OUT/$ERR (last command's output). main has two commits:
#   1: README        2: .gitignore (.claude/worktrees/, .claude/state/, node_modules/) + shared.txt
make_fixture() {
  FX=$(mktemp -d "$SUITE_TMP/fx.XXXXXX")
  FX=$(cd "$FX" && pwd -P)
  ORIGIN="$FX/origin.git"
  OUT="$FX/out"; ERR="$FX/err"; : >"$OUT"; : >"$ERR"
  git init -q --bare -b main "$ORIGIN"
  git init -q -b main "$FX/seed"
  (
    cd "$FX/seed" || exit 1
    echo "readme" >README
    git add README && git commit -qm "first"
    printf '.claude/worktrees/\n.claude/state/\nnode_modules/\n' >.gitignore
    echo "base" >shared.txt
    git add .gitignore shared.txt && git commit -qm "second"
    git remote add origin "$ORIGIN"
    git push -q origin main
  )
  # $1: optional path of the clone relative to $FX (may contain spaces etc.)
  local rel=${1:-primary}
  mkdir -p "$(dirname "$FX/$rel")"
  git clone -q "$ORIGIN" "$FX/$rel"
  PRIMARY=$(cd "$FX/$rel" && pwd -P)
  STATE="$PRIMARY/.claude/state"
  CLAIMS="$STATE/claims.tsv"
  WTS="$PRIMARY/.claude/worktrees"
}

# A second clone, for pushing "from elsewhere".
other_clone() {
  [ -d "$FX/other" ] || git clone -q "$ORIGIN" "$FX/other"
  echo "$FX/other"
}

# commit_file <dir> <file> <content> [message]
commit_file() {
  printf '%s\n' "$3" >"$1/$2"
  git -C "$1" add "$2" && git -C "$1" commit -qm "${4:-add $2}"
}

# Lowest port P such that nothing listens on [P, P+20) — keeps port assertions
# stable on a busy machine.
pick_port_base() {
  local b=${1:-47000} p ok
  while :; do
    ok=1
    if command -v lsof >/dev/null 2>&1; then
      for p in $(seq "$b" $((b + 19))); do
        if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then ok=0; break; fi
      done
    fi
    [ "$ok" -eq 1 ] && { echo "$b"; return; }
    b=$((b + 20))
  done
}

tab=$(printf '\t')
