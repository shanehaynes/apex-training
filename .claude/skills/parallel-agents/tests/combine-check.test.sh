#!/usr/bin/env bash
# Self-contained tests for scripts/combine-check.sh.
# Builds throwaway fixture repos (bare origin + clone) under mktemp -d, runs the
# script against them, prints one PASS/FAIL line per case, exits 0 iff all pass.
set -u

here=$(cd "$(dirname "$0")" && pwd -P)
script="$here/../scripts/combine-check.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/combine-check-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# Isolate from the user's git config; fixtures carry their own identity.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$tmp/gitconfig"
: > "$GIT_CONFIG_GLOBAL"
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_DIR GIT_WORK_TREE

pass=0 fail=0
ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/      | /'; fail=$((fail + 1)); }

g() { git -C "$prim" "$@"; }
commit_file() {  # commit_file <file> <content> <msg>
  printf '%s\n' "$2" > "$prim/$1"; g add "$1"; g commit -q -m "$3"
}

# ── fixture ────────────────────────────────────────────────────────────────
# A14: the primary's path has a space, and a sibling dir shares the prefix before it.
origin="$tmp/origin.git" prim="$tmp/my repo/p" sibling="$tmp/my"
mkdir -p "$prim" "$sibling"; echo keep > "$sibling/keep"
git init -q --bare "$origin"
git -C "$origin" symbolic-ref HEAD refs/heads/main
git init -q "$prim"
g symbolic-ref HEAD refs/heads/main
g config user.name "Fixture"; g config user.email "fixture@example.invalid"
g remote add origin "$origin"
commit_file shared.txt "line one" "base"
g push -q -u origin main
g remote set-head origin main

branch() {  # branch <name> <file> <content> [push]
  g checkout -q -b "$1" main
  commit_file "$2" "$3" "$1"
  [ "${4:-push}" = push ] && g push -q origin "$1"
  g checkout -q main
}
branch conf1 shared.txt "conf1 edit"     # (a) conf1 × conf2 conflict textually
branch conf2 shared.txt "conf2 edit"
branch sem1  x.flag "x"                  # (b) merge cleanly, break SEMCHECK together
branch sem2  y.flag "y"
branch clean1 c1.txt "c1"                # (c) clean
branch clean2 c2.txt "c2"
branch localonly l.txt "l" nopush        # never pushed: resolves as a local branch
branch mover m.txt "m1"                  # advanced after its SHA is taken
mover_old=$(g rev-parse mover)
g checkout -q mover; commit_file late.txt "late" "mover late"; g push -q origin mover; g checkout -q main
# newtest adds a failing test script that does not exist on base.
g checkout -q -b newtest main
printf '#!/bin/sh\nexit 1\n' > "$prim/new-test.sh"; chmod +x "$prim/new-test.sh"
g add new-test.sh; g commit -q -m newtest; g push -q origin newtest; g checkout -q main
# orphan shares no history with anything (merge-tree exits 128).
g checkout -q --orphan orphan; g rm -rq --cached .; commit_file o.txt "o" "orphan"
g push -q origin orphan; g checkout -q -f main; g clean -qfd
# la: pushed, then the local branch moves ahead of origin/la.
branch la la.txt "pushed"
g checkout -q la; commit_file la2.txt "local only" "la ahead"; g checkout -q main
# headlane: an unpushed branch checked out in a linked worktree, upstream origin/clean1.
hwt="$tmp/head wt"
g worktree add -q -b headlane "$hwt" main
printf 'h\n' > "$hwt/h.txt"; git -C "$hwt" add h.txt; git -C "$hwt" commit -q -m headlane
git -C "$hwt" branch -q --set-upstream-to=origin/clean1 headlane

SEMCHECK='test ! -f x.flag || test ! -f y.flag'
sha() { g rev-parse --verify "$1^{commit}"; }
base_sha=$(sha origin/main)

# run_at <dir> <args…>: runs the script from <dir>; sets $out (stdout then
# stderr), $err (stderr only) and $rc. run <args…> runs it from the primary.
run_at() {
  local d=$1; shift
  out=$(cd "$d" && bash "$script" "$@" 2>"$tmp/stderr"); rc=$?
  err=$(cat "$tmp/stderr"); out="$out"$'\n'"$err"
}
run() { run_at "$prim" "$@"; }
has()  { printf '%s\n' "$out" | grep -qF -- "$1"; }
has_err() { printf '%s\n' "$err" | grep -qF -- "$1"; }
count() { printf '%s\n' "$out" | grep -cE -- "$1" || true; }
no_leftovers() {  # every run must leave no _combine-* worktree behind
  local left
  left=$( (ls -d "$prim"/.claude/worktrees/_combine-* 2>/dev/null; g worktree list --porcelain | grep _combine-) || true)
  [ -f "$sibling/keep" ] || left="$left sibling dir $sibling was deleted (A14)"
  [ -z "$left" ] || { bad "no _combine-* worktree after: $1" "$left"; return 1; }
}
expect() {  # expect <name> <rc> <predicate…>: checks rc, runs predicate, checks leftovers
  local name=$1 want=$2; shift 2
  if [ "$rc" -ne "$want" ]; then bad "$name (exit $rc, want $want)" "$out"
  elif ! "$@"; then bad "$name" "$out"
  else ok "$name"; fi
  no_leftovers "$name" || true
}
yes_() { :; }

# ── cases ──────────────────────────────────────────────────────────────────
run clean1 clean2
pins() { has "   base origin/main = $base_sha" && has "   ref  clean1 = $(sha clean1)" && has "   ref  clean2 = $(sha clean2)"; }
expect "clean pair exits 0 and pins base and each ref with full SHAs" 0 pins

full=$(sha clean1) short=$(sha clean2 | cut -c1-8)
run "$full" "$short"
sha_args() { has "   ref  $full = $full" && has "   ref  $short = $(sha clean2)" && has "   ok        $full × $short"; }
expect "full and short SHAs as arguments resolve and pin to full SHAs" 0 sha_args

run --check 'test ! -f late.txt && test -f m.txt' "$mover_old"
pinned_old() { has "   ref  $mover_old = $mover_old"; }
expect "a SHA argument is what gets folded, not the branch's newer head" 0 pinned_old

run localonly clean1
local_ok() { has "   ref  localonly = $(sha localonly)"; }
expect "unpushed local branch resolves as given" 0 local_ok

run conf1 conf2
conflict() { has "   CONFLICT  conf1 × conf2" && has "shared.txt"; }
expect "pairwise conflict exits 1 and names the file" 1 conflict

run clean1 clean2 sem1
three() { [ "$(count '^   ok        ')" -eq 3 ] && has "(3 branches, 3 pairs)"; }
expect "without --against, N branches give N(N-1)/2 pairs" 0 three

run --against conf1 clean1 clean2 conf2 sem1
against_pairs() {
  [ "$(count '^   (ok|CONFLICT)  ')" -eq 4 ] && has "── pairwise against conf1 (4 pairs)" \
    && has "   CONFLICT  conf1 × conf2" && has "   ok        conf1 × clean1" \
    && ! has "clean1 × clean2" && has "   ref  conf1 = $(sha conf1)" && ! has "── fold"
}
expect "--against checks exactly N pairs (REF × each) and pins REF" 1 against_pairs

run --against clean1 sem1 sem2 --check "test -f c1.txt && $SEMCHECK && test ! -f x.flag && test ! -f y.flag"
against_fold() { [ "$(count '^   folded    ')" -eq 1 ] && has "   folded    clean1" && has "── the fold passes"; }
expect "--against with --check folds base + REF only" 0 against_fold

run --check "$SEMCHECK" sem1 sem2
sem_fail() { has "── the fold FAILS: the lanes are individually green but not together" && ! has "baseline:" && ! has "running the baseline"; }
expect "--check: branches that break the check together exit 1" 1 sem_fail

run --baseline --check "$SEMCHECK" sem1 sem2
base_pass() { has "baseline: $SEMCHECK passes on base — the combination breaks it" && ! has "also fails on base"; }
expect "--baseline: only the fold fails → exit 1" 1 base_pass

run --baseline --check 'test -f never.txt' clean1 clean2
no_blame() { has "── the fold FAILS (exit 1); running the baseline to see whether main fails too" && ! has "individually green"; }
expect "--baseline: the fold-failure line blames no one before the verdict (A87)" 3 no_blame
base_fail() { has "baseline: test -f never.txt also fails on base — the lanes may still have broken it too; compare the failures" && ! has "not caused by these lanes"; }
expect "--baseline: CMD also fails on base → exit 3, wording does not clear the lanes (A63)" 3 base_fail

for code in 127 126; do
  run --baseline --check "if test -f c1.txt; then exit 1; else exit $code; fi" clean1
  inconclusive() { has "baseline: inconclusive — CMD cannot run on base (exit $code)" && ! has "also fails on base"; }
  expect "--baseline: CMD exits $code on base → inconclusive, exit 1 (A2)" 1 inconclusive
done

run --baseline --check 'if test -f c1.txt; then exit 1; else exit 2; fi' clean1
other_code() { has "also fails on base" && ! has "inconclusive"; }
expect "--baseline: any other non-zero exit on base (2) → exit 3" 3 other_code

run --baseline --check './new-test.sh' newtest
missing() { has "fold CMD exit = 1" && has "base CMD exit = 127" && has "baseline: inconclusive — CMD cannot run on base (exit 127)"; }
expect "--baseline: a check script the lane adds, missing on base (real 127), is inconclusive" 1 missing

run --baseline --check 'test -f never.txt' conf1 conf2 --sequential
seq_stop() { has "   STOP      conf2 does not fold" && ! has "baseline:"; }
expect "fold that does not merge textually is a conflict (exit 1), no baseline run" 1 seq_stop

run --baseline --check 'test -f never.txt' --against conf1 conf2
conflict_wins() { has "CONFLICT  conf1 × conf2" && has "also fails on base"; }
expect "pairwise conflict keeps exit 1 even when base fails too" 1 conflict_wins

run --baseline --check 'test -f c1.txt && test -f c2.txt' clean1 clean2
clean_check() { has "── the fold passes" && ! has "baseline:" && [ "$(count '^   folded    ')" -eq 2 ]; }
expect "clean fold with --check (and --baseline) exits 0" 0 clean_check

run --sequential clean1 clean2
seq() { ! has "── pairwise" && has "   folded    clean2"; }
expect "--sequential folds without pairs" 0 seq

run --check 'echo junk > untracked.tmp; mkdir -p d && echo x > d/f; false' clean1
expect "failing check that leaves untracked files still cleans up" 1 yes_

run --check 'kill -TERM $PPID; sleep 5' clean1
expect "script killed by TERM mid-check still cleans up" 143 yes_

# ── round-2 amendments ─────────────────────────────────────────────────────
run --check 'test -f c1.txt' clean1
spaced() { has "── the fold passes" && [ -f "$sibling/keep" ]; }
expect "A14 primary path with a space: fold runs, sibling dir survives, worktree removed" 0 spaced

run --check 'git worktree lock "$(pwd)" --reason test' clean1
expect "A22 CMD that locks its worktree leaves no registration behind" 0 yes_

run_at "$hwt" --check 'test -f h.txt' HEAD
headsha=$(git -C "$hwt" rev-parse HEAD)
head_rel() { has "   ref  HEAD = $headsha" && has "── the fold passes"; }
expect "A15 HEAD resolves in the invoking worktree, not origin/HEAD" 0 head_rel

run_at "$hwt" @ HEAD~1 "@{u}"
at_rel() { has "   ref  @ = $headsha" && has "   ref  HEAD~1 = $base_sha" && has "   ref  @{u} = $(sha origin/clean1)"; }
expect "A15 @, HEAD~1 and @{u} resolve in the invoking worktree" 0 at_rel

run --check 'false; test -z "$UNSET_X"; yes | head -1 >/dev/null' clean1
opts() { has "fold CMD exit = 0"; }
expect "A16 CMD runs without inherited -e/-u/pipefail on the fold" 0 opts

run --baseline --check 'test ! -f c1.txt || exit 5; test -z "$UNSET_X"; yes | head -1 >/dev/null' clean1
opts_base() { has "base CMD exit = 0" && has "passes on base — the combination breaks it"; }
expect "A16 ... and on the base (--baseline → exit 1, not 3)" 1 opts_base

run la clean1
la_warn() {
  has_err "WARN la: local $(sha la | cut -c1-12) differs from origin/la $(sha origin/la | cut -c1-12); testing origin" \
    && has "   ref  la (origin/la) = $(sha origin/la)" && has "   ref  clean1 = $(sha clean1)"
}
expect "A18 local branch ahead of origin: WARN on stderr, pin line names origin" 0 la_warn

run orphan clean1 clean2
unrelated() {
  [ "$(count '^   ERROR orphan × clean[12]: .*unrelated histories')" -eq 2 ] \
    && has "   ok        clean1 × clean2" && ! has "CONFLICT"
}
expect "A20 merge-tree failure (unrelated histories) is ERROR, all pairs still run" 1 unrelated

run --sequential orphan
fold_err() { has "   ERROR fold × orphan: " && has "unrelated histories"; }
expect "A20 merge-tree failure in the fold is ERROR, exit 1" 1 fold_err

run --check './nope.sh' clean1
cant_run() { has "fold CMD exit = 127" && has "── the check cannot run on the fold (exit 127)" && ! has "individually green"; }
expect "A21 CMD missing on the fold: cannot run (exit 127), exit 1" 1 cant_run

run --baseline --check 'exit 126' clean1
cant_run_b() { has "── the check cannot run on the fold (exit 126)" && ! has "baseline:" && ! has "individually green"; }
expect "A21 ... with --baseline: exit 1, no baseline verdict" 1 cant_run_b

run --check true clean1
pass_rc() { has "   fold CMD exit = 0"; }
expect "A21 fold CMD exit code printed on success" 0 pass_rc

run clean1
one() { has_err "nothing to check: one branch and no --check" && ! has "── pairwise"; }
expect "A23 one branch without --check says it checks nothing, exit 0" 0 one

# A19: origin/HEAD unset → the remote's HEAD via ls-remote, never a guessed origin/main.
origin2="$tmp/origin2.git"; git clone -q --mirror "$origin" "$origin2"
git -C "$origin2" symbolic-ref HEAD refs/heads/clean1
p2="$tmp/p2"; git clone -q "$origin2" "$p2"; git -C "$p2" remote set-head origin -d
run_at "$p2" clean2 conf1
remote_head() { has "   base origin/clean1 = $(sha origin/clean1)"; }
expect "A19 no origin/HEAD: default branch from ls-remote --symref" 0 remote_head

origin3="$tmp/origin3.git"; git clone -q --mirror "$origin" "$origin3"
git -C "$origin3" symbolic-ref HEAD refs/heads/nope
p3="$tmp/p3"; git clone -q "$origin3" "$p3" 2>/dev/null; git -C "$p3" remote set-head origin -d 2>/dev/null
run_at "$p3" clean1 clean2
no_head() { has_err "cannot determine the default branch" && ! has "base origin/main"; }
expect "A19 no origin/HEAD and no remote HEAD → exit 64 naming the problem" 64 no_head

# A24: an unexpected git failure (throwaway worktree cannot be created) → exit 2.
p4="$tmp/p4"; git clone -q "$origin" "$p4"; mkdir -p "$p4/.claude"; : > "$p4/.claude/worktrees"
run_at "$p4" --check true clean1
internal() { has_err "combine-check: error: create throwaway worktree: "; }
expect "A24 unexpected internal failure → exit 2 with step and message" 2 internal
if git -C "$p4" worktree list --porcelain | grep -q _combine-; then bad "A24 no registration left after the internal failure"
else ok "A24 no registration left after the internal failure"; fi

run_at "$sibling" clean1 clean2
expect "not inside a git repository → exit 64" 64 yes_

# Fold commits must not depend on any configured identity.
noid="$tmp/noid"
git clone -q "$origin" "$noid"
git -C "$noid" config user.useConfigOnly true
out=$(cd "$noid" && bash "$script" --check true clean1 clean2 2>&1); rc=$?
if [ "$rc" -eq 0 ] && has "── the fold passes"; then ok "fold works with no git identity configured"
else bad "fold works with no git identity configured (exit $rc)" "$out"; fi

# ── round-4 amendments ─────────────────────────────────────────────────────
leftover_list() { ls -d "$1"/.claude/worktrees/_combine-* 2>/dev/null || true; }

# A54: a read-only tree left by CMD is made writable and removed; the verdict stands.
run --check 'mkdir -p ro/sub && echo x > ro/sub/f && chmod -R a-w ro' clean1
expect "A54 read-only tree left by CMD is removed, exit 0" 0 yes_

# A54: a throwaway that cannot be removed → WARN, exit code is the verdict's (3),
# and the other throwaway is still removed. Shim rm to fail on _combine-* and make
# the fold CMD delete .git so `git worktree remove` fails too.
mkdir -p "$tmp/shim"; realrm=$(command -v rm)
printf '#!/bin/sh\nfor a; do case "$a" in *_combine-*) exit 1 ;; esac; done\nexec %s "$@"\n' "$realrm" > "$tmp/shim/rm"
chmod +x "$tmp/shim/rm"
PATH="$tmp/shim:$PATH" run --baseline --check 'if test -f c1.txt; then rm -f .git; fi; exit 1' clean1
left=$(leftover_list "$prim")
if [ "$rc" -eq 3 ] && has_err "WARN could not remove throwaway worktree" && [ "$(printf '%s\n' "$left" | grep -c _combine-fold)" -eq 1 ] \
   && ! printf '%s\n' "$left" | grep -q _combine-base && has "also fails on base"; then
  ok "A54 unremovable throwaway → WARN, verdict exit 3 kept, other throwaway removed"
else bad "A54 unremovable throwaway → WARN, verdict exit 3 kept, other throwaway removed (exit $rc)" "$out
left: $left"; fi
printf '%s\n' "$left" | while IFS= read -r w; do [ -z "$w" ] || { chmod -R u+w "$w"; rm -rf "$w"; }; done; g worktree prune
no_leftovers "A54 cleanup" || true

# A55: local branches named origin/<x> never shadow the remote-tracking refs.
p5="$tmp/p5"; git clone -q "$origin" "$p5"
git -C "$p5" branch origin/clean1 "$(sha conf1)"; git -C "$p5" branch origin/main "$(sha clean2)"
run_at "$p5" clean1 origin/clean1 2>/dev/null
shadow() { has "   base origin/main = $base_sha" && has "   ref  clean1 = $(sha clean1)" && has "   ref  origin/clean1 = $(sha clean1)"; }
expect "A55 local origin/<x> branches do not shadow remote refs (base and lanes)" 0 shadow

# A56: inside a submodule, the submodule is the repository.
sup="$tmp/super"; git init -q "$sup"; git -C "$sup" symbolic-ref HEAD refs/heads/main
git -C "$sup" config user.name F; git -C "$sup" config user.email f@example.invalid
git -C "$sup" commit -q --allow-empty -m super
git -C "$sup" -c protocol.file.allow=always submodule -q add "$origin" sub 2>/dev/null
git -C "$sup" commit -q -m sub
run_at "$sup/sub" --check 'test -f c1.txt && test -f c2.txt' clean1 clean2
submod() { has "   ref  clean1 = $(sha clean1)" && has "── the fold passes" && [ ! -e "$sup/.git/modules/.claude" ] && [ -z "$(leftover_list "$sup/sub")" ]; }
expect "A56 inside a submodule: tests the submodule, leaves nothing in .git/modules" 0 submod

git clone -q --bare "$origin" "$tmp/bare.git"; git -C "$tmp/bare.git" worktree add -q "$tmp/bare wt" main 2>/dev/null
run_at "$tmp/bare wt" clean1 clean2
bare_l() { has_err "bare"; }
expect "A56 worktree of a bare repository → exit 64" 64 bare_l
run_at "$tmp/bare.git" clean1 clean2
expect "A56 inside a bare repository → exit 64" 64 bare_l

# A57: a pre-existing (locked) worktree at the name v2.1 would pick (_combine-<pid>)
# is never touched: this run only removes what it created.
pwf="$tmp/precious.path"
( pw="$prim/.claude/worktrees/_combine-$BASHPID"; echo "$pw" > "$pwf"
  git -C "$prim" worktree add -q --detach "$pw" main && git -C "$prim" worktree lock "$pw"
  cd "$prim" && exec bash "$script" --check true clean1 ) >/dev/null 2>&1; rc=$?
pw=$(cat "$pwf")
if [ -d "$pw" ] && g worktree list --porcelain | grep -qF "worktree $pw" && [ "$rc" -eq 0 ]; then
  ok "A57 a pre-existing _combine-* worktree is never removed"
else bad "A57 a pre-existing _combine-* worktree is never removed (exit $rc)" "$(g worktree list)"; fi
g worktree unlock "$pw" 2>/dev/null; g worktree remove --force "$pw" 2>/dev/null; rm -rf "$pw"; g worktree prune
no_leftovers "A57 cleanup" || true

# A59: network steps are bounded (no GNU timeout needed).
p6="$tmp/p6"; git clone -q "$origin" "$p6"
git -C "$p6" config remote.origin.uploadpack 'sleep 30; git-upload-pack'
t0=$SECONDS; COMBINE_GIT_TIMEOUT=2 run_at "$p6" clean1 clean2; took=$((SECONDS - t0))
slow_fetch() { has_err "WARN fetch from origin timed out after 2s; using local refs" && [ "$took" -le 12 ]; }
expect "A59 hung fetch times out → WARN, local refs, exit 0 (took ${took}s)" 0 slow_fetch
git -C "$p6" remote set-head origin -d
t0=$SECONDS; COMBINE_GIT_TIMEOUT=2 run_at "$p6" clean1 clean2; took=$((SECONDS - t0))
slow_ls() { has_err "timed out" && [ "$took" -le 16 ]; }
expect "A59 hung ls-remote needed for the default branch → exit 64 (took ${took}s)" 64 slow_ls
COMBINE_GIT_TIMEOUT=abc run clean1 clean2
expect "A59 non-numeric COMBINE_GIT_TIMEOUT → exit 64" 64 yes_

# A60: INT/TERM/HUP stop CMD and its children and clean up within 5 s.
sig_case() {  # sig_case <SIG> <want-rc>
  local pidf="$tmp/cmd.pid" sp child i t0 took src=0
  rm -f "$pidf"
  set -m
  ( cd "$prim" && exec bash "$script" --check "sleep 60 & echo \$! > '$pidf'; sleep 60" clean1 ) >"$tmp/sig.out" 2>&1 &
  sp=$!
  set +m
  i=0; while [ ! -s "$pidf" ] && [ "$i" -lt 200 ]; do sleep 0.1; i=$((i + 1)); done
  child=$(cat "$pidf" 2>/dev/null)
  t0=$SECONDS; kill "-$1" "$sp"
  i=0; while kill -0 "$sp" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  took=$((SECONDS - t0))
  if kill -0 "$sp" 2>/dev/null; then kill -KILL -- "-$sp" 2>/dev/null; fi
  wait "$sp" 2>/dev/null || src=$?
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    bad "A60 $1: CMD's child is still running after the script exited" "$(cat "$tmp/sig.out")"; kill -KILL "$child" 2>/dev/null
  elif [ "$took" -gt 5 ] || [ "$src" -ne "$2" ]; then
    bad "A60 $1 during CMD: exit $src (want $2) after ${took}s (≤5)" "$(cat "$tmp/sig.out")"
  else ok "A60 $1 during CMD: CMD and children stopped, exit $2 within ${took}s"; fi
  leftover_list "$prim" | while IFS= read -r w; do [ -z "$w" ] || rm -rf "$w"; done
  no_leftovers "A60 $1" || g worktree prune
}
sig_case INT 130
sig_case TERM 143
sig_case HUP 129

# A61: only git's special refs resolve in the invoking checkout; fix_HEAD is a branch.
branch fix_HEAD fh.txt "pushed"
g checkout -q fix_HEAD; commit_file fh2.txt "local" "fix_HEAD ahead"; g checkout -q main
run fix_HEAD clean1
fixhead() { has_err "WARN fix_HEAD: local $(sha fix_HEAD | cut -c1-12) differs from origin/fix_HEAD" && has "   ref  fix_HEAD (origin/fix_HEAD) = $(sha origin/fix_HEAD)"; }
expect "A61 a branch named fix_HEAD resolves by name (A18 applies)" 0 fixhead
git -C "$hwt" update-ref ORIG_HEAD "$(sha clean2)"
run_at "$hwt" ORIG_HEAD clean1
orig() { has "   ref  ORIG_HEAD = $(sha clean2)"; }
expect "A61 ORIG_HEAD still resolves in the invoking checkout" 0 orig

# A64: a conflict found before an internal failure keeps exit 1.
run_at "$p4" --against conf1 conf2 --check true
conflict_then_err() { has "CONFLICT  conf1 × conf2" && has_err "combine-check: error: create throwaway worktree"; }
expect "A64 conflict then internal failure → exit 1, error still printed" 1 conflict_then_err

# A58: @{u}, @{upstream} and @{push} resolve after the fetch (the upstream moved remotely).
branch upmove u.txt "u1"
other="$tmp/other"; git clone -q "$origin" "$other"; git -C "$other" checkout -q upmove
printf 'u2\n' > "$other/u.txt"; git -C "$other" -c user.name=o -c user.email=o@x commit -qam u2; git -C "$other" push -q origin upmove
u2=$(git -C "$other" rev-parse HEAD)
git -C "$hwt" branch -q --set-upstream-to=origin/upmove headlane; g config push.default upstream
run_at "$hwt" "@{u}" "headlane@{upstream}" "@{push}"
upstream() { has "   ref  @{u} = $u2" && has "   ref  headlane@{upstream} = $u2" && has "   ref  @{push} = $u2"; }
expect "A58 @{u}/@{upstream}/@{push} resolve to the upstream after the fetch" 0 upstream

# Usage errors → 64.
for args in "" "--bogus clean1" "--check" "--against" "--against clean1" "--check ''" "--against '' clean1" \
            "no-such-branch" "--against no-such-ref clean1" "--against clean1 --sequential clean2" \
            "--check --baseline clean1 clean2" "--against --check true clean1" \
            "--check ' ' clean1" "--check '	 ' clean1" "--check true --check false clean1" "--baseline --baseline --check true clean1" \
            "--sequential --sequential clean1" "--against clean1 --against clean2 conf1"; do
  eval "run $args"
  if [ "$rc" -eq 64 ]; then ok "usage error exits 64 (A17): combine-check.sh $args"
  else bad "usage error exits 64: combine-check.sh $args (got $rc)" "$out"; fi
  no_leftovers "usage: $args" || true
done

echo "── $pass passed, $fail failed"
[ "$fail" -eq 0 ]
