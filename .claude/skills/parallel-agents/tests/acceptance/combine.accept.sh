#!/usr/bin/env bash
# Acceptance tests for scripts/combine-check.sh (contract v2, section 2).
# Usage: SKILL_ROOT=<dir> bash combine.accept.sh
# KEPT = v1 behaviour the contract keeps; AMBIGUOUS = a reading of the contract.
set -u
SKILL_ROOT=${SKILL_ROOT:-$(cd "$(dirname "$0")/../.." && pwd -P)}
COMPONENT=combine
# shellcheck source=tests/acceptance/lib.sh
. "$(dirname "$0")/lib.sh"

CC="$SKILL_ROOT/scripts/combine-check.sh"

combine() { # combine <args…> — runs in ${CWD:-$PRIMARY}; sets RC, OUT, ERR
  (cd "${CWD:-$PRIMARY}" && to "${COMBINE_TO:-120}" bash "$CC" "$@") >"$OUT" 2>"$ERR"
  RC=$?
}

# mkbranch <name> <file> <content> [push=1]
mkbranch() {
  git -C "$PRIMARY" checkout -q -b "$1" origin/main
  commit_file "$PRIMARY" "$2" "$3" "$1: $2"
  [ "${4:-1}" = 1 ] && git -C "$PRIMARY" push -q origin "$1"
  git -C "$PRIMARY" checkout -q main
}

# Branches (all pushed unless noted):
#   feat/a    adds a.txt            feat/b    adds b.txt
#   feat/c    shared.txt = c        feat/d    shared.txt = d   (conflicts with c)
#   feat/dep  adds dep.txt          feat/depx shared.txt = x   (conflicts with c, d)
#   feat/local adds local.txt, never pushed
combine_fixture() { # [clone-dir]
  make_fixture "${1:-}"
  mkbranch feat/a a.txt a
  mkbranch feat/b b.txt b
  mkbranch feat/c shared.txt c
  mkbranch feat/d shared.txt d
  mkbranch feat/dep dep.txt dep
  mkbranch feat/depx shared.txt x
  mkbranch feat/local local.txt l 0
  BASE_SHA=$(git -C "$PRIMARY" rev-parse origin/main)
  LOG="$FX/cmd.log"
  : >"$LOG"
}
sha() { git -C "$PRIMARY" rev-parse "$1^{commit}"; }
pair_lines() { grep -c '×' "$OUT" | tr -d ' '; }
no_throwaway() {
  local left
  left=$(ls -d "$WTS"/_combine-* 2>/dev/null)
  eq "throwaway dirs left under .claude/worktrees ($1)" "$left" ""
  check_not "throwaway worktree still registered ($1)" \
    sh -c "git -C '$PRIMARY' worktree list --porcelain | grep -q '_combine-'"
}
first_line() { grep -nE -- "$1" "$OUT" | head -1 | cut -d: -f1; }
pin_ref_re() { printf '^[[:space:]]*ref[[:space:]]+(origin/)?%s = %s[[:space:]]*$' "$1" "$2"; }
pin_base_re() { printf '^[[:space:]]*base origin/main = %s[[:space:]]*$' "$1"; }

# ── pinning ─────────────────────────────────────────────────────────────────
t_pin() {
  combine_fixture
  combine feat/a feat/b feat/local
  rc_is "combine a b local" 0
  out_has "base pinned with full sha" "$(pin_base_re "$BASE_SHA")"
  out_has "feat/a pinned" "$(pin_ref_re feat/a "$(sha feat/a)")"
  out_has "feat/b pinned" "$(pin_ref_re feat/b "$(sha feat/b)")"
  out_has "unpushed local branch pinned" "$(pin_ref_re feat/local "$(sha feat/local)")"
  local pin pair
  pin=$(first_line "^[[:space:]]*ref[[:space:]]")
  pair=$(first_line "pairwise")
  check "pins printed before the pairwise check (pin line ${pin:-none}, pairwise line ${pair:-none})" \
    test -n "$pin" -a -n "$pair" -a "${pin:-0}" -lt "${pair:-0}"
}

t_pin_fold() {
  combine_fixture
  combine --sequential --check true feat/a feat/b
  rc_is "sequential fold" 0
  out_has "base pinned" "$(pin_base_re "$BASE_SHA")"
  local pin fold
  pin=$(first_line "^[[:space:]]*base origin/main = ")
  fold=$(first_line "fold")
  check "pins printed before the fold (pin line ${pin:-none}, fold line ${fold:-none})" \
    test -n "$pin" -a -n "$fold" -a "${pin:-0}" -lt "${fold:-0}"
}

t_sha_args() {
  combine_fixture
  local a b short full
  a=$(sha feat/a); b=$(sha feat/b)
  short=$(git -C "$PRIMARY" rev-parse --short feat/a)
  combine "$short" "$b"
  rc_is "short + full SHA arguments" 0
  full="[0-9a-f]{40}"
  out_has "short SHA pinned as its full SHA" "^[[:space:]]*ref[[:space:]]+[^ ]+ = ${a}[[:space:]]*\$"
  out_has "full SHA pinned" "^[[:space:]]*ref[[:space:]]+[^ ]+ = ${b}[[:space:]]*\$"
  out_lacks "no ref pinned to a non-40-hex value" "^[[:space:]]*ref[[:space:]]+[^ ]+ = ([0-9a-f]{0,39}|${full}[0-9a-f]+)[[:space:]]*\$"
  eq "one pair checked" "$(pair_lines)" 1
}

# ── pairwise ────────────────────────────────────────────────────────────────
t_pairwise_kept() {
  combine_fixture
  combine feat/a feat/b feat/c feat/d
  rc_is "c and d conflict" 1
  eq "N(N-1)/2 pairs" "$(pair_lines)" 6
  out_has "conflict reported" "CONFLICT.*feat/c.*feat/d"
}

t_against_count() {
  combine_fixture
  combine --against feat/dep feat/a feat/b feat/c
  rc_is "--against, no conflicts with REF" 0
  eq "exactly N pairs" "$(pair_lines)" 3
  eq "every pair involves REF" "$(grep '×' "$OUT" | grep -c 'feat/dep' | tr -d ' ')" 3
  out_lacks "no pair between listed branches" "feat/a[^/]*×[^/]*feat/b|feat/b[^/]*×[^/]*feat/a"
}

t_against_listed_conflict() {
  combine_fixture
  combine --against feat/dep feat/c feat/d
  rc_is "--against: listed branches conflict only with each other" 0
  out_lacks "listed×listed not checked" "CONFLICT"
  eq "exactly N pairs" "$(pair_lines)" 2
}

t_against_conflict() {
  combine_fixture
  combine --against feat/depx feat/a feat/c
  rc_is "--against: REF conflicts with a listed branch" 1
  out_has "conflict names REF and the branch" "CONFLICT.*(feat/depx.*feat/c|feat/c.*feat/depx)"
  eq "exactly N pairs" "$(pair_lines)" 2
}

t_against_pin() {
  combine_fixture
  combine --against feat/dep feat/a
  rc_is "--against" 0
  out_has "REF pinned" "$(pin_ref_re feat/dep "$(sha feat/dep)")"
  out_has "listed branch pinned" "$(pin_ref_re feat/a "$(sha feat/a)")"
}

t_against_fold() {
  combine_fixture
  combine --against feat/dep feat/a feat/b --check "ls > '$LOG'"
  rc_is "--against --check" 0
  check "fold contains REF (dep.txt)" grep -qx dep.txt "$LOG"
  check "fold contains base (shared.txt)" grep -qx shared.txt "$LOG"
  check_not "listed branch a not folded" grep -qx a.txt "$LOG"
  check_not "listed branch b not folded" grep -qx b.txt "$LOG"
  no_throwaway "--against --check"
}

# ── fold (kept) ─────────────────────────────────────────────────────────────
t_fold_kept() {
  combine_fixture
  combine --check "ls > '$LOG'; pwd -P > '$FX/where'; git rev-parse HEAD > '$FX/head'" feat/a feat/b feat/dep
  rc_is "--check" 0
  check "fold has a.txt" grep -qx a.txt "$LOG"
  check "fold has b.txt" grep -qx b.txt "$LOG"
  check "fold has dep.txt" grep -qx dep.txt "$LOG"
  check "ran under <primary>/.claude/worktrees/_combine-*" grep -q "^$WTS/_combine-" "$FX/where"
  check "fold descends from the pinned base" git -C "$PRIMARY" merge-base --is-ancestor "$BASE_SHA" "$(cat "$FX/head" 2>/dev/null || echo x)"
  no_throwaway "after a passing check"
}

t_fold_fail_cleanup() {
  combine_fixture
  combine --check "touch junk; mkdir -p d/e; echo x > d/e/f; false" feat/a
  rc_is "failing --check" 1
  no_throwaway "after a failing check with untracked junk"
}

# ── baseline ────────────────────────────────────────────────────────────────
t_baseline_3() {
  combine_fixture
  combine --baseline --check "test -f nowhere.txt" feat/a
  rc_is "fold fails and base fails too" 3
  out_has "baseline verdict" "baseline:.*also fails on base"
  no_throwaway "--baseline, exit 3"
}

t_baseline_1() {
  combine_fixture
  combine --baseline --check "pwd -P >> '$FX/where'; git rev-parse HEAD >> '$LOG'; (git symbolic-ref -q HEAD || echo detached) >> '$FX/det'; test ! -f a.txt" feat/a
  rc_is "fold fails, base passes" 1
  out_has "baseline verdict" "baseline:.*passes on base"
  eq "CMD ran twice (fold, then base)" "$(wc -l <"$LOG" | tr -d ' ')" 2
  eq "second run is on the base commit" "$(sed -n 2p "$LOG")" "$BASE_SHA"
  eq "both runs detached" "$(grep -c detached "$FX/det" 2>/dev/null | tr -d ' ')" 2
  eq "both runs under _combine-*" "$(grep -c "^$WTS/_combine-" "$FX/where" 2>/dev/null | tr -d ' ')" 2
  no_throwaway "--baseline, exit 1"
}

# Amendment A2: a baseline where CMD cannot run on base (126/127) is
# inconclusive, never "not caused by these lanes".
t_baseline_inconclusive() {
  combine_fixture
  combine --baseline --check "if test -f a.txt; then exit 1; else exit 127; fi" feat/a
  rc_is "fold fails, CMD cannot run on base (127)" 1
  out_has "inconclusive verdict" "baseline:.*inconclusive"
  out_lacks "never blames main" "also fails on base"
  combine --baseline --check "if test -f a.txt; then exit 1; else exit 126; fi" feat/a
  rc_is "fold fails, CMD cannot run on base (126)" 1
  out_has "inconclusive verdict (126)" "baseline:.*inconclusive"
  no_throwaway "--baseline, inconclusive"
}

t_baseline_pass() {
  combine_fixture
  combine --baseline --check "echo run >> '$LOG'" feat/a
  rc_is "fold passes" 0
  eq "CMD ran once (no baseline when the fold passes)" "$(wc -l <"$LOG" | tr -d ' ')" 1
  out_lacks "no baseline verdict" "baseline:"
}

t_baseline_conflict() {
  combine_fixture
  combine --baseline --check "echo run >> '$LOG'; false" feat/c feat/d
  rc_is "textual conflict is caused by the lanes" 1
  out_lacks "no baseline verdict for a conflict" "baseline:.*also fails"
}

t_signal_cleanup() {
  combine_fixture
  command -v setsid >/dev/null 2>&1 || return 0
  (cd "$PRIMARY" && exec setsid bash "$CC" --check "sleep 30" feat/a) >"$OUT" 2>"$ERR" &
  local pid=$!
  for _ in $(seq 1 40); do
    ls -d "$WTS"/_combine-* >/dev/null 2>&1 && break
    sleep 0.25
  done
  check "throwaway worktree appeared while CMD ran" sh -c "ls -d '$WTS'/_combine-* >/dev/null 2>&1"
  sleep 0.5
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -KILL -- "-$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  no_throwaway "after SIGTERM during CMD"
}

# ── usage (kept) ────────────────────────────────────────────────────────────
t_usage() {
  combine_fixture
  combine
  rc_is "no branches" 64
  combine feat/nope
  rc_is "unresolvable ref" 64
  combine --bogus feat/a
  rc_is "unknown flag" 64
}

# ── round-2 amendments (A14–A24) ────────────────────────────────────────────
t_a14_spaces() {
  combine_fixture "proj x"
  mkdir -p "$FX/proj/.claude/worktrees/_combine-1"
  echo keep >"$FX/proj/keep.txt"
  echo keep >"$FX/proj/.claude/worktrees/_combine-1/keep.txt"
  mkdir -p "$WTS"
  git -C "$PRIMARY" worktree add -q --detach "$WTS/other-lane" origin/main
  combine --check "ls > '$LOG'" feat/a
  rc_is "--check under a primary path with a space" 0
  check "fold ran (a.txt listed)" grep -qx a.txt "$LOG"
  combine --baseline --check "test ! -f a.txt" feat/a
  rc_is "--baseline under a primary path with a space" 1
  check "sibling sharing the prefix untouched" test -f "$FX/proj/keep.txt"
  check "sibling's own _combine-* dir untouched" test -f "$FX/proj/.claude/worktrees/_combine-1/keep.txt"
  check "unrelated worktree untouched" test -d "$WTS/other-lane"
  check "unrelated worktree still registered" sh -c "git -C \"\$1\" worktree list --porcelain | grep -qF \"\$2\"" _ "$PRIMARY" "$WTS/other-lane"
  no_throwaway "path with a space"
}

t_a15_head() {
  combine_fixture
  mkdir -p "$WTS"
  git -C "$PRIMARY" worktree add -q "$WTS/la" feat/a
  commit_file "$WTS/la" extra.txt extra "local, unpushed"
  local head parent
  head=$(git -C "$WTS/la" rev-parse HEAD)
  parent=$(git -C "$WTS/la" rev-parse HEAD~1)
  CWD="$WTS/la" combine HEAD feat/b
  rc_is "HEAD from a lane" 0
  out_has "HEAD pinned to the invoking worktree's HEAD" "^[[:space:]]*ref[[:space:]]+HEAD.* = ${head}[[:space:]]*\$"
  CWD="$WTS/la" combine @ feat/b
  out_has "@ pinned to the invoking worktree's HEAD" "^[[:space:]]*ref[[:space:]]+@.* = ${head}[[:space:]]*\$"
  CWD="$WTS/la" combine HEAD~1 feat/b
  out_has "HEAD~1 pinned to its parent" "^[[:space:]]*ref[[:space:]]+HEAD~1.* = ${parent}[[:space:]]*\$"
  CWD="$WTS/la" combine --check "test -f extra.txt" HEAD
  rc_is "the fold contains the invoking HEAD's unpushed commit" 0
}

opts_cmd() { # records $- and pipefail for each run, then fails only where a.txt exists
  printf '%s' "echo \"flags=\$- pipefail=\$(set -o | awk '\$1==\"pipefail\"{print \$2}')\" >> '$LOG'; test ! -f a.txt"
}
t_a16_shellopts() {
  combine_fixture
  combine --baseline --check "$(opts_cmd)" feat/a
  rc_is "fold fails, base passes" 1
  eq "CMD ran on fold and base" "$(wc -l <"$LOG" | tr -d ' ')" 2
  check_not "no -e or -u inherited ($(tr '\n' ' ' <"$LOG"))" grep -Eq 'flags=[^ ]*[eu]' "$LOG"
  check_not "pipefail not inherited ($(tr '\n' ' ' <"$LOG"))" grep -q 'pipefail=on' "$LOG"
  combine --check 'false; echo "$UNSET_VAR_A16" >/dev/null; false | true' feat/a
  rc_is "CMD with a failing statement mid-way and an unset variable passes" 0
}

t_a17_flags() {
  combine_fixture
  local bad="" args
  while IFS= read -r args; do
    eval "set -- $args"
    combine "$@"
    [ "$RC" = 64 ] || bad="$bad [$args → exit $RC]"
  done <<'LIST'
--check --baseline feat/a
--check true --check false feat/a
--check '' feat/a
--against '' feat/a
--against --check true feat/a
--baseline --baseline --check true feat/a
--sequential --sequential feat/a feat/b
--against feat/dep --against feat/b feat/a
LIST
  eq "invocations not rejected with 64" "$bad" ""
  no_throwaway "usage errors"
}

t_a18_local_differs() {
  combine_fixture
  git -C "$PRIMARY" checkout -q feat/a
  commit_file "$PRIMARY" local-only.txt x "local commit on feat/a"
  git -C "$PRIMARY" checkout -q main
  local l o
  l=$(git -C "$PRIMARY" rev-parse feat/a | cut -c1-12)
  o=$(git -C "$PRIMARY" rev-parse origin/feat/a | cut -c1-12)
  combine feat/a feat/b
  rc_is "combine" 0
  check "WARN on stderr" grep -Eq "WARN feat/a: local $l differs from origin/feat/a $o; testing origin" "$ERR"
  out_has "pin names the source" "^[[:space:]]*ref[[:space:]]+feat/a \\(origin/feat/a\\) = $(sha origin/feat/a)[[:space:]]*\$"
}

t_a19_default_branch() {
  combine_fixture
  local o; o=$(other_clone)
  git -C "$o" checkout -q -b trunk origin/main
  commit_file "$o" trunk.txt t
  git -C "$o" push -q origin trunk
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/trunk
  git -C "$PRIMARY" remote set-head origin -d
  git -C "$PRIMARY" fetch -q origin
  combine feat/a
  out_has "default from the remote's HEAD (trunk)" "^[[:space:]]*base origin/trunk = $(sha origin/trunk)[[:space:]]*\$"
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/nope
  combine feat/a feat/b
  rc_is "no origin/HEAD and remote HEAD unresolvable" 64
  check "names the problem on stderr" grep -Eiq "HEAD|default" "$ERR"
  out_lacks "never silently falls back to origin/main" "base origin/main"
}

t_a20_merge_tree_error() {
  combine_fixture
  git -C "$PRIMARY" checkout -q --orphan feat/orphan
  git -C "$PRIMARY" rm -rqf .
  commit_file "$PRIMARY" orphan.txt o "unrelated history"
  git -C "$PRIMARY" push -q origin feat/orphan
  git -C "$PRIMARY" checkout -q -f main
  combine feat/orphan feat/a feat/b
  rc_is "merge-tree error" 1
  any_has "ERROR line with git's message" "ERROR feat/orphan × feat/a: .*unrelated"
  any_has "second failing pair still run" "ERROR feat/orphan × feat/b: "
  out_has "remaining pair still run" "ok[[:space:]]+feat/a × feat/b"
}

t_a21_cannot_run() {
  combine_fixture
  combine --check "no-such-command-a21" feat/a
  rc_is "CMD not found on the fold" 1
  any_has "verdict" "the check cannot run on the fold \\(exit 127\\)"
  out_lacks "not blamed on the lanes" "individually green"
  combine --baseline --check "no-such-command-a21" feat/a
  rc_is "CMD not found on the fold, with --baseline" 1
  any_has "verdict with --baseline" "the check cannot run on the fold \\(exit 127\\)"
  out_lacks "not blamed on main" "also fails on base"
  combine --check "exit 42" feat/a
  rc_is "ordinary failure" 1
  out_has "the fold's exit code is printed" "(^|[^0-9])42([^0-9]|$)"
  no_throwaway "cannot-run verdicts"
}

t_a22_locked_throwaway() {
  combine_fixture
  combine --check 'git worktree lock "$(pwd -P)"' feat/a
  rc_is "CMD locks its worktree" 0
  no_throwaway "after CMD locked the throwaway"
  combine --baseline --check 'git worktree lock "$(pwd -P)"; test ! -f a.txt' feat/a
  no_throwaway "after CMD locked both throwaways"
}

t_a23_nothing() {
  combine_fixture
  combine feat/a
  rc_is "one branch, no --check" 0
  check "nothing-to-check notice on stderr" grep -q "nothing to check: one branch and no --check" "$ERR"
}

t_a24_internal() {
  combine_fixture
  mkdir -p "$PRIMARY/.claude"
  echo "not a directory" >"$WTS"
  combine --check true feat/a
  rc_is "throwaway worktree cannot be created" 2
  check "error line on stderr" grep -Eq "^combine-check: error: [^:]+: " "$ERR"
}

# ── round-4 amendments (A54–A64) ────────────────────────────────────────────
t_a54_unremovable() {
  combine_fixture
  command -v chattr >/dev/null 2>&1 || { note "fixture needs chattr (not available here)"; return; }
  local cmd="pwd -P >> '$FX/where'; if test -f a.txt; then touch stuck && chattr +i stuck; exit 1; fi; exit 0"
  combine --baseline --check "$cmd" feat/a
  local fold base
  fold=$(sed -n 1p "$FX/where"); base=$(sed -n 2p "$FX/where")
  check "fixture: fold throwaway made unremovable" sh -c "lsattr \"\$1/stuck\" 2>/dev/null | grep -q '^[^ ]*i'" _ "$fold"
  rc_is "verdict kept when a throwaway cannot be removed (fold fails, base passes)" 1
  any_has "WARN about the throwaway" "WARN"
  check_not "cleanup continued: base throwaway removed" test -e "$base"
  chattr -i "$fold/stuck" 2>/dev/null
  git -C "$PRIMARY" worktree remove --force --force "$fold" >/dev/null 2>&1
  : >"$FX/where"
  combine --check "pwd -P >> '$FX/where'; touch stuck && chattr +i stuck" feat/a
  fold=$(sed -n 1p "$FX/where")
  rc_is "passing verdict kept when its throwaway cannot be removed" 0
  any_has "WARN about the throwaway" "WARN"
  chattr -i "$fold/stuck" 2>/dev/null
}

t_a55_shadow() {
  combine_fixture
  local oa om
  oa=$(git -C "$PRIMARY" rev-parse refs/remotes/origin/feat/a)
  om=$(git -C "$PRIMARY" rev-parse refs/remotes/origin/main)
  git -C "$PRIMARY" branch origin/feat/a feat/b
  git -C "$PRIMARY" branch origin/main feat/c
  combine feat/a feat/dep
  rc_is "combine with shadowing local branches" 0
  out_has "base is refs/remotes/origin/main" "^[[:space:]]*base origin/main = ${om}[[:space:]]*\$"
  out_has "feat/a is refs/remotes/origin/feat/a" "^[[:space:]]*ref[[:space:]]+feat/a.* = ${oa}[[:space:]]*\$"
}

t_a56_submodule() {
  combine_fixture
  git init -q --bare -b main "$FX/sub.git"
  git init -q -b main "$FX/subseed"
  commit_file "$FX/subseed" .gitignore ".claude/"
  git -C "$FX/subseed" remote add origin "$FX/sub.git"
  git -C "$FX/subseed" push -q origin main
  git -C "$FX/subseed" checkout -q -b feat/s
  commit_file "$FX/subseed" s.txt s
  git -C "$FX/subseed" push -q origin feat/s
  git -C "$PRIMARY" -c protocol.file.allow=always submodule add -q "$FX/sub.git" vendor/sub >/dev/null 2>&1
  local subsha; subsha=$(git -C "$FX/subseed" rev-parse HEAD)
  CWD="$PRIMARY/vendor/sub" combine --check "test -f s.txt" feat/s
  rc_is "combine inside a submodule tests the submodule" 0
  out_has "pinned from the submodule's origin" "^[[:space:]]*ref[[:space:]]+feat/s.* = ${subsha}[[:space:]]*\$"
  eq "no throwaway left anywhere" "$(find "$FX" -maxdepth 8 -name '_combine-*' 2>/dev/null)" ""
  a56_bare
}

a56_bare() {
  git clone -q --bare "$ORIGIN" "$FX/bare.git"
  git -C "$FX/bare.git" rev-parse --verify -q feat/a >/dev/null || note "fixture: bare clone lacks feat/a"
  CWD="$FX/bare.git" combine feat/a feat/b
  rc_is "bare repository layout (branches resolvable locally)" 64
  CWD="$FX/bare.git" combine --check true feat/a
  rc_is "bare repository layout with --check" 64
  eq "nothing created next to the bare repository" "$(find "$FX" -maxdepth 4 -name '_combine-*' 2>/dev/null)" ""
}

t_a57_planted() {
  combine_fixture
  mkdir -p "$WTS"
  git -C "$PRIMARY" worktree add -q --detach "$WTS/_combine-1" origin/main
  git -C "$PRIMARY" worktree add -q --detach "$WTS/_combine-old" origin/main
  git -C "$PRIMARY" worktree add -q --detach "$WTS/away-lane" origin/main
  local away; away=$(cd "$WTS/away-lane" && git rev-parse --absolute-git-dir)
  mv "$WTS/away-lane" "$FX/away-lane-moved" # e.g. on a drive that is not mounted right now
  mkdir -p "$WTS/_combine-stale"; echo keep >"$WTS/_combine-stale/keep.txt"
  combine --check true feat/a
  rc_is "--check" 0
  combine --baseline --check false feat/a
  check "another worktree's registration is not pruned" test -d "$away"
  check "unregistered _combine-stale dir untouched" test -f "$WTS/_combine-stale/keep.txt"
  local w
  for w in _combine-1 _combine-old; do
    check "pre-existing $w not removed" test -d "$WTS/$w"
    check "pre-existing $w still registered" sh -c "git -C \"\$1\" worktree list --porcelain | grep -qF \"\$2\"" _ "$PRIMARY" "$WTS/$w"
  done
  a57_concurrent
}

a57_concurrent() {
  (cd "$PRIMARY" && to 120 bash "$CC" --check 'd=$(pwd -P); sleep 5; test -f "$d/a.txt" && test -e "$d/.git"' feat/a >"$FX/a.out" 2>&1; echo $? >"$FX/a.rc") &
  local apid=$!
  sleep 1.5
  combine --check true feat/b
  combine --baseline --check false feat/b
  wait "$apid"
  eq "a concurrent run's throwaway survives another run's cleanup (exit of run A)" "$(cat "$FX/a.rc")" 0
}

t_a58_upstream() {
  combine_fixture
  mkdir -p "$WTS"
  git -C "$PRIMARY" worktree add -q "$WTS/la" feat/a
  git -C "$WTS/la" branch -q --set-upstream-to origin/feat/a
  local o new
  o=$(other_clone)
  git -C "$o" fetch -q origin
  git -C "$o" checkout -q -b feat/a origin/feat/a
  commit_file "$o" upstream.txt u "moved upstream"
  git -C "$o" push -q origin feat/a
  new=$(git -C "$o" rev-parse HEAD)
  local spec
  for spec in '@{u}' '@{upstream}' 'feat/a@{upstream}' '@{push}'; do
    CWD="$WTS/la" combine "$spec" feat/b
    rc_is "$spec" 0
    out_has "$spec resolves to the upstream after the fetch" "^[[:space:]]*ref[[:space:]]+.*= ${new}[[:space:]]*\$"
  done
}

# A dir of symlinks to every command on PATH except timeout/gtimeout.
no_timeout_path() {
  local d="$FX/nt-bin" p f
  mkdir -p "$d"
  local IFS=:
  for p in $PATH; do
    [ -d "$p" ] || continue
    for f in "$p"/*; do
      case "${f##*/}" in timeout | gtimeout) continue ;; esac
      [ -x "$f" ] && [ ! -e "$d/${f##*/}" ] && ln -s "$f" "$d/${f##*/}"
    done
  done
  echo "$d"
}
t_a59_network() {
  combine_fixture
  node -e "const s=require('net').createServer(()=>{});s.listen(0,'127.0.0.1',()=>require('fs').writeFileSync(process.argv[1],String(s.address().port)));setTimeout(()=>process.exit(0),180000)" "$FX/port" &
  local lpid=$! t0 t1 nt
  for _ in $(seq 1 40); do [ -s "$FX/port" ] && break; sleep 0.25; done
  git -C "$PRIMARY" remote set-url origin "http://127.0.0.1:$(cat "$FX/port")/silent.git"
  t0=$(date +%s)
  COMBINE_TO=40 COMBINE_GIT_TIMEOUT=3 combine feat/a feat/b
  t1=$(date +%s)
  rc_is "fetch against a silent remote falls back to local refs" 0
  check "bounded by COMBINE_GIT_TIMEOUT=3 (took $((t1 - t0)) s, allowed < 30)" test $((t1 - t0)) -lt 30
  check "WARN about the fetch" sh -c "cat \"\$1\" \"\$2\" | grep -i 'WARN' | grep -qi 'fetch'" _ "$OUT" "$ERR"
  nt=$(no_timeout_path)
  t0=$(date +%s)
  (cd "$PRIMARY" && COMBINE_GIT_TIMEOUT=3 to 40 env PATH="$nt" bash "$CC" feat/a feat/b) >"$OUT" 2>"$ERR"
  RC=$?; t1=$(date +%s)
  rc_is "same without a timeout command on PATH" 0
  check "bounded without GNU timeout (took $((t1 - t0)) s, allowed < 30)" test $((t1 - t0)) -lt 30
  git -C "$PRIMARY" remote set-head origin -d
  t0=$(date +%s)
  COMBINE_TO=40 COMBINE_GIT_TIMEOUT=3 combine feat/a feat/b
  t1=$(date +%s)
  rc_is "ls-remote for the default branch times out" 64
  check "bounded (took $((t1 - t0)) s, allowed < 30)" test $((t1 - t0)) -lt 30
  kill "$lpid" 2>/dev/null
}

t_a60_signals() {
  combine_fixture
  local sig pid cpid kpid dsig=""
  env --default-signal=INT true 2>/dev/null && dsig="--default-signal=INT"
  for sig in TERM HUP INT; do
    if [ "$sig" = INT ] && [ -z "$dsig" ]; then continue; fi
    rm -f "$FX/cmdpid" "$FX/childpid"
    # shellcheck disable=SC2086
    (cd "$PRIMARY" && exec env $dsig bash "$CC" --check "echo \$\$ > '$FX/cmdpid'; sleep 60 & echo \$! > '$FX/childpid'; wait" feat/a) >"$OUT" 2>"$ERR" &
    pid=$!
    for _ in $(seq 1 80); do [ -s "$FX/childpid" ] && break; sleep 0.25; done
    cpid=$(cat "$FX/cmdpid" 2>/dev/null); kpid=$(cat "$FX/childpid" 2>/dev/null)
    if [ -z "$cpid" ] || [ -z "$kpid" ]; then note "$sig: CMD never started"; kill -KILL "$pid" 2>/dev/null; continue; fi
    kill -"$sig" "$pid"
    for _ in $(seq 1 20); do
      kill -0 "$cpid" 2>/dev/null || kill -0 "$kpid" 2>/dev/null || ! ls -d "$WTS"/_combine-* >/dev/null 2>&1 || break
      sleep 0.25
    done
    check_not "$sig: CMD shell gone within 5 s" kill -0 "$cpid"
    check_not "$sig: CMD's child gone within 5 s" kill -0 "$kpid"
    check_not "$sig: no _combine-* within 5 s" sh -c "ls -d '$WTS'/_combine-* >/dev/null 2>&1"
    kill -KILL "$cpid" "$kpid" "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    rm -rf "$WTS"/_combine-*; git -C "$PRIMARY" worktree prune
  done
}

t_a61_names() {
  combine_fixture
  mkbranch fix_HEAD fix.txt f
  local origin_fix
  origin_fix=$(git -C "$PRIMARY" rev-parse refs/remotes/origin/fix_HEAD)
  git -C "$PRIMARY" checkout -q fix_HEAD
  commit_file "$PRIMARY" local.txt l "local only"
  git -C "$PRIMARY" checkout -q main
  combine fix_HEAD feat/a
  rc_is "fix_HEAD" 0
  out_has "fix_HEAD resolves by name to origin (A18)" "^[[:space:]]*ref[[:space:]]+fix_HEAD.* = ${origin_fix}[[:space:]]*\$"
  mkdir -p "$WTS"
  git -C "$PRIMARY" worktree add -q "$WTS/la" feat/a
  commit_file "$WTS/la" extra.txt e
  local extra; extra=$(git -C "$WTS/la" rev-parse HEAD)
  git -C "$WTS/la" reset -q --hard HEAD~1
  CWD="$WTS/la" combine ORIG_HEAD feat/b
  rc_is "ORIG_HEAD" 0
  out_has "ORIG_HEAD resolves in the invoking worktree" "^[[:space:]]*ref[[:space:]]+ORIG_HEAD.* = ${extra}[[:space:]]*\$"
}

t_a62_blank_check() {
  combine_fixture
  combine --check "   " feat/a
  rc_is "--check of spaces" 64
  combine --check "$(printf '\t ')" feat/a
  rc_is "--check of tab+space" 64
}

t_a63_wording() {
  combine_fixture
  combine --baseline --check "test -f nowhere.txt" feat/a
  rc_is "fold and base fail" 3
  out_has "exit-3 wording" "baseline: .*also fails on base — the lanes may still have broken it too; compare the failures"
}

t_a64_conflict_then_internal() {
  combine_fixture
  mkdir -p "$PRIMARY/.claude"
  echo "not a directory" >"$WTS"
  combine --against feat/depx feat/c --check true
  rc_is "pairwise conflict + later internal failure" 1
  check "internal error still printed" grep -q "combine-check: error:" "$ERR"
  out_has "the conflict was reported" "CONFLICT"
}

run_case "pin: base and every ref printed with full SHA, before the pairwise check" t_pin
run_case "pin: printed before the fold (--sequential --check)" t_pin_fold
run_case "pin: short and full SHA arguments resolve as commits, pinned full" t_sha_args
run_case "KEPT pairwise: N(N-1)/2 pairs, conflict → exit 1" t_pairwise_kept
run_case "--against: exactly N pairs, each with REF, none between listed" t_against_count
run_case "--against: conflict between listed branches is not checked → exit 0" t_against_listed_conflict
run_case "--against: conflict with REF → exit 1, named" t_against_conflict
run_case "--against: REF and listed branches are pinned" t_against_pin
run_case "--against --check: fold is base + REF only" t_against_fold
run_case "KEPT --check: fold of all lanes, in _combine-* under primary, removed" t_fold_kept
run_case "KEPT --check failing with untracked junk: throwaway still removed" t_fold_fail_cleanup
run_case "--baseline: fold fails and base fails → exit 3, verdict line" t_baseline_3
run_case "--baseline: fold fails, base passes → exit 1, CMD re-run on base in detached _combine-*" t_baseline_1
run_case "A2 --baseline: CMD cannot run on base (126/127) → inconclusive, exit 1" t_baseline_inconclusive
run_case "--baseline: fold passes → exit 0, CMD not re-run" t_baseline_pass
run_case "AMBIGUOUS --baseline: a textual conflict is exit 1, never 3" t_baseline_conflict
run_case "AMBIGUOUS throwaway removed when killed by SIGTERM during CMD" t_signal_cleanup
run_case "KEPT usage: no branch / unresolvable ref / unknown flag → 64" t_usage

run_case "A14 primary path with a space: only throwaways removed, sibling with shared prefix untouched" t_a14_spaces
run_case "A15 HEAD / @ / HEAD~1 resolve in the invoking worktree, never origin/HEAD" t_a15_head
run_case "A16 CMD runs with default shell options on fold and base" t_a16_shellopts
run_case "A17 flag as value, repeated flag, empty --check/--against → 64" t_a17_flags
run_case "A18 local branch differs from origin: WARN on stderr, pin names the source" t_a18_local_differs
run_case "A19 default branch from remote HEAD when origin/HEAD unset; unresolvable → 64" t_a19_default_branch
run_case "A20 merge-tree error → ERROR a × b: message, other pairs still run, exit 1" t_a20_merge_tree_error
run_case "A21 CMD exit printed; 126/127 → cannot run on the fold, exit 1" t_a21_cannot_run
run_case "A22 throwaway locked by CMD is still removed" t_a22_locked_throwaway
run_case "A23 one branch, no --check → notice on stderr, exit 0" t_a23_nothing
run_case "A24 internal failure → exit 2 with combine-check: error: <step>: <message>" t_a24_internal

run_case "A54 unremovable throwaway: WARN, verdict exit kept, other throwaways still removed" t_a54_unremovable
run_case "A55 local branches named origin/<x> never shadow remote refs (base and lanes)" t_a55_shadow
run_case "A56 inside a submodule the submodule is the repository; bare layout → 64" t_a56_submodule
run_case "A57 only this run's throwaways are removed (planted _combine-*, other registrations, a concurrent run)" t_a57_planted
run_case "A58 @{u} / @{upstream} / <b>@{upstream} / @{push} resolve to the upstream after the fetch" t_a58_upstream
run_case "A59 silent remote: fetch bounded by COMBINE_GIT_TIMEOUT (WARN, local refs), ls-remote → 64, no GNU timeout needed" t_a59_network
run_case "A60 TERM/HUP/INT to the script pid stop CMD and its child and clean up within 5 s" t_a60_signals
run_case "A61 fix_HEAD resolves by name; ORIG_HEAD resolves in the invoking worktree" t_a61_names
run_case "A62 whitespace-only --check → 64" t_a62_blank_check
run_case "A63 exit-3 wording" t_a63_wording
run_case "A64 pairwise conflict then internal failure → exit 1, error still printed" t_a64_conflict_then_internal

summary
