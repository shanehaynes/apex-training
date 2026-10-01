#!/usr/bin/env bash
# Tests for scripts/lane.sh (claims v2, ports, --detach, release, retire, tidy).
#
#   bash tests/lane.test.sh        # one PASS/FAIL line per case; exit 0 iff all pass
#   LANE_TEST_ONLY=REGEX            # run only the cases whose name matches
#   LANE_UNDER_TEST=/path/lane.sh   # test another copy (with-lock.sh beside it)
#
# Every case builds a throwaway fixture (a bare `origin` + a primary clone) under
# one mktemp -d directory, removed on exit. Nothing touches the repository this
# file lives in.
set -u

HERE=$(cd "$(dirname "$0")" && pwd -P)
LANE="${LANE_UNDER_TEST:-$HERE/../scripts/lane.sh}"
REAL_GIT=$(command -v git)
TMP_ROOT=$(mktemp -d)
TMP_ROOT=$(cd "$TMP_ROOT" && pwd -P)
trap 'rm -rf "$TMP_ROOT"' EXIT

# High, narrow range so real services on 5200+ never interfere.
export LANE_PORT_BASE=47310 LANE_PORT_SPAN=40 LANE_PORT_DEFAULT=5999 LOCK_WAIT=120
export GIT_AUTHOR_NAME=lane-test GIT_AUTHOR_EMAIL=lane-test@example.invalid
export GIT_COMMITTER_NAME=lane-test GIT_COMMITTER_EMAIL=lane-test@example.invalid
export GIT_CONFIG_NOSYSTEM=1 HOME="$TMP_ROOT/home"
mkdir -p "$HOME"
TAB=$(printf '\t')

pass=0; failn=0; n=0

# Kill a process and all its descendants (portable ps).
kill_tree() {
  local c
  for c in $(ps -A -o pid= -o ppid= | awk -v p="$1" '$2 == p { print $1 }'); do kill_tree "$c"; done
  kill "$1" 2>/dev/null || true
}

# ── helpers (run inside each case's subshell) ────────────────────────────────
fail() { echo "ASSERT: $*"; exit 1; }
eq() { [ "$1" = "$2" ] || fail "${3:-values differ}: expected [$2], got [$1]"; }
lane() { bash "$LANE" "$@"; }
# lane_rc CMD… → sets RC and OUT (stdout+stderr) without tripping set -e.
lane_rc() { RC=0; OUT=$(bash "$LANE" "$@" 2>&1) || RC=$?; }
claims() { cat "$P/.claude/state/claims.tsv"; }
field() { awk -F'\t' -v n="$1" -v c="$2" '$1 == n { v = $c } END { print v }' "$P/.claude/state/claims.tsv"; }
snapshot() {
  { cat "$P/.claude/state/claims.tsv" 2>/dev/null
    git -C "$P" worktree list --porcelain
    git -C "$P" for-each-ref --format='%(refname) %(objectname)'; } | cksum
}
hash_of() { local s; s=$(printf '%s' "$1" | cksum | awk '{print $1}'); echo $(( LANE_PORT_BASE + s % LANE_PORT_SPAN )); }

# Fresh fixture: $P primary clone of bare $O with main + .gitignore; cwd = $P.
# fixture [DIRNAME]: DIRNAME is an extra path component above the fixture.
fixture() {
  local d; d=$(mktemp -d "$TMP_ROOT/case.XXXXXX")
  if [ -n "${1:-}" ]; then d="$d/$1"; mkdir -p "$d"; fi
  O="$d/origin.git"; P="$d/primary"
  git init -q --bare -b main "$O"
  git init -q -b main "$d/seed"
  printf '.claude/worktrees/\n.claude/state/\nnode_modules/\n' > "$d/seed/.gitignore"
  echo hello > "$d/seed/README"
  git -C "$d/seed" add -A && git -C "$d/seed" commit -qm init
  git -C "$d/seed" push -q "$O" main
  git clone -q "$O" "$P"
  P=$(cd "$P" && pwd -P)
  WT="$P/.claude/worktrees"
  cd "$P"
}
# Squash-merge a branch into main and push: what tidy recognises as "landed"
# (a fast-forwarded tip is indistinguishable from a lane that just started).
squash_merge() { git merge -q --squash "$1" >/dev/null && git commit -qm "squash $1" && git push -q origin main; }
commit_in() { echo "$2" > "$1/$2.txt"; git -C "$1" add -A; git -C "$1" commit -qm "$2"; }

run() {
  local name=$1 log rc
  n=$((n + 1)); log="$TMP_ROOT/log.$n"
  ( set -e; "$name" ) > "$log" 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then echo "PASS $name"; pass=$((pass + 1))
  else echo "FAIL $name"; sed 's/^/     /' "$log" | tail -n 25; failn=$((failn + 1)); fi
}

# ── cases ────────────────────────────────────────────────────────────────────
t_new_branch_allocates_lowest_port_and_writes_7col_active_claim() {
  fixture
  lane new feat/a "owns ${TAB}the api" --no-setup > out.log
  eq "$(claims | wc -l | tr -d ' ')" 1 "row count"
  eq "$(claims | awk -F'\t' '{print NF}')" 7 "columns"
  eq "$(field feat/a 3)" "$WT/feat-a" "path"
  eq "$(field feat/a 4)" "owns  the api" "intent tabs replaced"
  eq "$(field feat/a 5)" "$LANE_PORT_BASE" "port"
  eq "$(field feat/a 6)" active "status"
  eq "$(field feat/a 7)" branch "kind"
  field feat/a 2 | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || fail "utc format"
  eq "$(git -C "$WT/feat-a" rev-parse --abbrev-ref HEAD)" feat/a "branch checked out"
  grep -q "── ready" out.log || fail "ready block"
  grep -q "branch:   feat/a" out.log || fail "branch line"
  grep -q "port:     $LANE_PORT_BASE" out.log || fail "port line"
  grep -q "cd $WT/feat-a && " out.log || fail "cd line"
}

t_two_sequential_news_get_different_ports() {
  fixture
  lane new feat/a --no-setup >/dev/null
  lane new feat/b --no-setup > out.log
  eq "$(field feat/a 5)" "$LANE_PORT_BASE" "first"
  eq "$(field feat/b 5)" "$((LANE_PORT_BASE + 1))" "second"
  grep -q "feat/a \[active\]" out.log || fail "other claims listed"
}

t_port_primary_claimed_unclaimed() {
  fixture
  eq "$(lane port)" 5999 "primary"
  eq "$(lane port "$P")" 5999 "primary by path"
  lane new feat/a --no-setup >/dev/null
  lane new feat/b --no-setup >/dev/null
  eq "$(lane port "$WT/feat-b")" "$((LANE_PORT_BASE + 1))" "claimed"
  mkdir -p "$WT/feat-b/sub"
  eq "$(cd "$WT/feat-b/sub" && lane port)" "$((LANE_PORT_BASE + 1))" "claimed, from a subdirectory"
  git worktree add -q "$TMP_ROOT/unclaimed-$n" -b loose >/dev/null 2>&1
  eq "$(lane port "$TMP_ROOT/unclaimed-$n")" "$(hash_of "unclaimed-$n")" "unclaimed → hash"
  git worktree remove "$TMP_ROOT/unclaimed-$n"
}

t_v1_rows_list_port_alloc_release_tidy() {
  fixture
  mkdir -p .claude/state
  git worktree add -q "$WT/old-one" -b old/one
  commit_in "$WT/old-one" oldwork
  printf 'old/one\t2025-01-01T00:00:00Z\t%s\tv1 lane\n' "$WT/old-one" > .claude/state/claims.tsv
  printf 'old/gone\t2025-01-01T00:00:00Z\t%s\t\n' "$WT/old-gone" >> .claude/state/claims.tsv
  h=$(hash_of old-one)
  eq "$(lane port "$WT/old-one")" "$h" "v1 port = hash"
  lane list > list.log
  grep -qE "^LIVE old/one +status=done port=$h kind=branch dirty=0 ahead=1 +$WT/old-one +— v1 lane$" list.log || { cat list.log; fail "v1 LIVE list line"; }
  grep -qE "^GONE old/gone +status=done " list.log || fail "v1 GONE list line"
  before=$(claims)
  lane release old/one > rel.log
  eq "$(claims)" "$before" "release of a v1 (done) row rewrites nothing"
  lane new feat/new --no-setup >/dev/null
  eq "$(field feat/new 5)" "$LANE_PORT_BASE" "v1 rows hold no recorded port"
  eq "$(sed -n 1p .claude/state/claims.tsv | awk -F'\t' '{print NF}')" 4 "v1 row left as 4 columns"
  # merge old/one into main; tidy removes it and prunes gone claims
  squash_merge old/one
  lane tidy > dry.log 2>&1
  grep -q "REMOVE $WT/old-one" dry.log || { cat dry.log; fail "tidy dry-run REMOVE"; }
  [ -d "$WT/old-one" ] || fail "dry run removed something"
  lane tidy --yes > tidy.log 2>&1
  [ ! -d "$WT/old-one" ] || fail "merged v1 worktree kept"
  grep -q "PRUNE claim old/gone" tidy.log || fail "gone claim not pruned"
  claims | grep -q '^old/' && fail "v1 claims not pruned"
  [ -d "$WT/feat-new" ] || fail "fresh active lane removed"
  claims | grep -q '^feat/new' || fail "active claim pruned"
}

t_v1_row_retire_writes_7_columns() {
  fixture
  mkdir -p .claude/state
  git worktree add -q "$WT/old-two" -b old/two
  commit_in "$WT/old-two" w
  git -C "$WT/old-two" push -q -u origin old/two
  printf 'old/two\t2025-01-01T00:00:00Z\t%s\tv1\n' "$WT/old-two" > .claude/state/claims.tsv
  lane retire old/two >/dev/null
  eq "$(claims)" "old/two${TAB}2025-01-01T00:00:00Z${TAB}$WT/old-two${TAB}v1${TAB}${TAB}retired${TAB}branch" "v1 row rewritten in full"
}

t_new_detach_requires_base_and_creates_detached_worktree() {
  fixture
  lane_rc new --detach rev1 --no-setup
  eq "$RC" 64 "missing --base exit code"
  [ ! -e "$WT/review-rev1" ] || fail "worktree created without --base"
  [ ! -s .claude/state/claims.tsv ] || fail "claim written without --base"
  commit_in "$P" second; git push -q origin main
  sha=$(git rev-parse HEAD~1)
  lane new --detach rev1 --base "$(git rev-parse --short HEAD~1)" "review api" --no-setup > out.log
  eq "$(git -C "$WT/review-rev1" rev-parse HEAD)" "$sha" "checked out at SHA"
  git -C "$WT/review-rev1" symbolic-ref -q HEAD >/dev/null && fail "not detached"
  eq "$(field review-rev1 7)" detached "kind"
  eq "$(field review-rev1 6)" active "status"
  eq "$(field review-rev1 5)" "$LANE_PORT_BASE" "port"
  grep -q "sha:      $sha" out.log || fail "sha line"
  grep -q "branch:" out.log && fail "branch line on detached"
  lane list | grep -qE "^LIVE review-rev1 +status=active port=$LANE_PORT_BASE kind=detached dirty=0 ahead=- " || fail "list line"
  lane_rc new --detach rev2 --base no-such-ref --no-setup
  eq "$RC" 1 "bad base"
}

t_release() {
  fixture
  lane new feat/a --no-setup >/dev/null
  lane release feat/a >/dev/null
  eq "$(field feat/a 6)" "done" "active → done"
  before=$(claims)
  (cd "$WT/feat-a" && bash "$LANE" release .) >/dev/null
  eq "$(claims)" "$before" "idempotent on done (by relative path)"
  lane_rc release nope
  eq "$RC" 1 "unknown lane"
  lane_rc release
  eq "$RC" 64 "missing argument"
}

t_retire_refusals_change_nothing() {
  fixture
  lane new feat/a --no-setup >/dev/null
  commit_in "$WT/feat-a" work
  git -C "$WT/feat-a" push -q -u origin feat/a
  # active
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "active refused"; echo "$OUT" | grep -q "release it first" || fail "active message: $OUT"
  eq "$(snapshot)" "$s" "active: state changed"
  lane release feat/a >/dev/null
  # untracked (not ignored) file
  echo x > "$WT/feat-a/scratch.txt"
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "untracked refused"; eq "$(snapshot)" "$s" "untracked: state changed"
  [ -f "$WT/feat-a/scratch.txt" ] || fail "untracked file lost"
  rm "$WT/feat-a/scratch.txt"
  # tracked modification
  echo changed >> "$WT/feat-a/README"
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "modified refused"; eq "$(snapshot)" "$s" "modified: state changed"
  git -C "$WT/feat-a" checkout -q -- README
  # unpushed commit
  commit_in "$WT/feat-a" more
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "unpushed refused"; echo "$OUT" | grep -q "unpushed" || fail "unpushed message: $OUT"
  eq "$(snapshot)" "$s" "unpushed: state changed"
  # never pushed at all
  lane new feat/b --no-setup >/dev/null; lane release feat/b >/dev/null
  commit_in "$WT/feat-b" b
  s=$(snapshot); lane_rc retire feat/b
  eq "$RC" 1 "never-pushed refused"; eq "$(snapshot)" "$s" "never-pushed: state changed"
  [ -d "$WT/feat-a" ] && [ -d "$WT/feat-b" ] || fail "worktree removed"
  eq "$(field feat/a 6)" "done" "status unchanged"
}

t_retire_success_keeps_branch() {
  fixture
  lane new feat/a --no-setup >/dev/null
  commit_in "$WT/feat-a" work
  git -C "$WT/feat-a" push -q -u origin feat/a
  mkdir -p "$WT/feat-a/node_modules/x" && echo y > "$WT/feat-a/node_modules/x/i.js"
  lane release feat/a >/dev/null
  (cd "$WT" && bash "$LANE" retire ./feat-a) > out.log
  [ ! -e "$WT/feat-a" ] || fail "worktree still there"
  git worktree list --porcelain | grep -q "feat-a" && fail "worktree still registered"
  git show-ref --verify -q refs/heads/feat/a || fail "local branch deleted"
  git ls-remote --exit-code origin feat/a >/dev/null || fail "remote branch deleted"
  eq "$(field feat/a 6)" retired "status"
  lane list | grep -qE "^GONE feat/a +status=retired " || fail "list shows retired"
  lane retire feat/a >/dev/null || fail "retire of retired lane should be a no-op"
}

t_retire_detached() {
  fixture
  lane new --detach r --base HEAD --no-setup >/dev/null
  lane release review-r >/dev/null
  lane retire review-r >/dev/null
  [ ! -e "$WT/review-r" ] || fail "detached worktree kept"
  eq "$(field review-r 6)" retired "status"
  # a detached lane with commits on no ref is refused
  lane new --detach s --base HEAD --no-setup >/dev/null
  commit_in "$WT/review-s" orphan
  lane release review-s >/dev/null
  s=$(snapshot); lane_rc retire review-s
  eq "$RC" 1 "orphan commit refused"; eq "$(snapshot)" "$s" "orphan: state changed"
}

t_tidy_never_removes_active_lane_even_when_merged() {
  fixture
  lane new feat/a --no-setup >/dev/null
  commit_in "$WT/feat-a" work
  squash_merge feat/a
  lane tidy --yes > tidy.log 2>&1
  grep -q "KEEP   $WT/feat-a  (active — a worker may still be using it)" tidy.log || { cat tidy.log; fail "KEEP active line"; }
  [ -d "$WT/feat-a" ] || fail "active worktree removed"
  git show-ref --verify -q refs/heads/feat/a || fail "active lane's branch deleted"
  eq "$(field feat/a 6)" active "claim kept"
  # control: once released, the same lane is tidied
  lane release feat/a >/dev/null
  lane tidy --yes > tidy2.log 2>&1
  [ ! -e "$WT/feat-a" ] || { cat tidy2.log; fail "released merged lane not removed"; }
  git show-ref --verify -q refs/heads/feat/a && fail "merged branch kept after release"
  true
}

t_tidy_keeps_active_branch_when_worktree_detached_from_it() {
  fixture
  lane new feat/a --no-setup >/dev/null
  commit_in "$WT/feat-a" work
  squash_merge feat/a
  # detach the worktree from the branch so only the claim protects it
  git -C "$WT/feat-a" checkout -q --detach
  lane tidy --yes > tidy.log 2>&1
  git show-ref --verify -q refs/heads/feat/a || { cat tidy.log; fail "active lane's branch deleted"; }
  [ -d "$WT/feat-a" ] || fail "active worktree removed"
}

t_port_freed_by_retired_lane_is_reused() {
  fixture
  lane new feat/a --no-setup >/dev/null
  lane new feat/b --no-setup >/dev/null
  git -C "$WT/feat-a" push -q -u origin feat/a
  lane release feat/a >/dev/null
  lane new feat/c --no-setup >/dev/null
  eq "$(field feat/c 5)" "$((LANE_PORT_BASE + 2))" "done lane still holds its port"
  lane retire feat/a >/dev/null
  lane new feat/d --no-setup >/dev/null
  eq "$(field feat/d 5)" "$LANE_PORT_BASE" "retired port reused"
}

t_no_free_port_exits_1_naming_range() {
  fixture
  LANE_PORT_SPAN=1 lane new feat/a --no-setup >/dev/null
  RC=0; OUT=$(LANE_PORT_SPAN=1 bash "$LANE" new feat/b --no-setup 2>&1) || RC=$?
  eq "$RC" 1 "exit code"
  echo "$OUT" | grep -q "\[$LANE_PORT_BASE, $((LANE_PORT_BASE + 1)))" || fail "range not named: $OUT"
  [ ! -e "$WT/feat-b" ] || fail "worktree created without a port"
  git show-ref --verify -q refs/heads/feat/b && fail "branch created without a port"
  eq "$(claims | wc -l | tr -d ' ')" 1 "row written"
}

t_concurrent_new_never_duplicates_port_or_loses_row() {
  fixture
  local i pids="" rc=0
  # Widen the window between port allocation and the claim append: a slow
  # post-checkout hook runs inside `git worktree add`. Without the claims lock
  # the four racers then allocate the same port.
  printf '#!/bin/sh\nsleep 1\n' > .git/hooks/post-checkout; chmod +x .git/hooks/post-checkout
  for i in 1 2 3 4; do
    bash "$LANE" new "feat/c$i" --no-setup > "c$i.log" 2>&1 &
    pids="$pids $!"
  done
  for i in $pids; do wait "$i" || rc=1; done
  [ "$rc" -eq 0 ] || { cat c*.log; fail "a concurrent new failed"; }
  eq "$(claims | wc -l | tr -d ' ')" 4 "rows"
  eq "$(claims | cut -f5 | sort -u | wc -l | tr -d ' ')" 4 "distinct ports"
  eq "$(claims | cut -f5 | sort -n | tr '\n' ' ')" "$LANE_PORT_BASE $((LANE_PORT_BASE+1)) $((LANE_PORT_BASE+2)) $((LANE_PORT_BASE+3)) " "lowest four ports"
  for i in 1 2 3 4; do [ -d "$WT/feat-c$i" ] || fail "worktree c$i missing"; done
  [ ! -e .claude/state/claims.lock.d ] || fail "lock left behind"
}

# ── A3: done/retired lanes whose tip is an ancestor of main count as landed ─
# Merge feature branch $1 into origin/main with a merge commit (--no-ff), or
# fast-forward when $2 = ff, and bring the primary's main along.
merge_into_main() {
  if [ "${2:-}" = ff ]; then git merge -q --ff-only "$1"
  else git merge -q --no-ff -m "merge $1" "$1" >/dev/null; fi
  git push -q origin main
}

t_a3_mergecommit_done_lane_removed_and_branch_deleted() {
  fixture
  lane new feat/mc --no-setup >/dev/null
  commit_in "$WT/feat-mc" work
  git -C "$WT/feat-mc" push -q -u origin feat/mc
  merge_into_main feat/mc
  lane release feat/mc >/dev/null
  lane tidy > dry.log 2>&1
  grep -q "REMOVE $WT/feat-mc" dry.log || { cat dry.log; fail "dry run REMOVE"; }
  grep -q "DELETE feat/mc" dry.log || { cat dry.log; fail "dry run DELETE"; }
  [ -d "$WT/feat-mc" ] || fail "dry run removed the worktree"
  git show-ref --verify -q refs/heads/feat/mc || fail "dry run deleted the branch"
  lane tidy --yes > tidy.log 2>&1
  [ ! -e "$WT/feat-mc" ] || { cat tidy.log; fail "merge-commit-landed done lane kept"; }
  git show-ref --verify -q refs/heads/feat/mc && fail "landed done lane's branch kept"
  true
}

t_a3_fastforward_done_lane_removed_and_branch_deleted() {
  fixture
  lane new feat/ff --no-setup >/dev/null
  commit_in "$WT/feat-ff" work
  merge_into_main feat/ff ff
  lane release feat/ff >/dev/null
  lane tidy --yes > tidy.log 2>&1
  [ ! -e "$WT/feat-ff" ] || { cat tidy.log; fail "fast-forwarded done lane kept"; }
  git show-ref --verify -q refs/heads/feat/ff && fail "branch kept"
  true
}

t_a3_active_v1_unclaimed_ancestors_keep_v1_rule() {
  fixture
  # active, merged with a merge commit
  lane new feat/act --no-setup >/dev/null
  commit_in "$WT/feat-act" a
  merge_into_main feat/act
  # v1 row, merged with a merge commit
  git worktree add -q "$WT/old-v1" -b old/v1
  commit_in "$WT/old-v1" v
  merge_into_main old/v1
  printf 'old/v1\t2025-01-01T00:00:00Z\t%s\tv1\n' "$WT/old-v1" >> .claude/state/claims.tsv
  # unclaimed worktree under .claude/worktrees, merged
  git worktree add -q "$WT/loose" -b loose
  commit_in "$WT/loose" l
  merge_into_main loose
  # unclaimed branch with no worktree, merged
  git branch bare-br HEAD~1
  lane tidy --yes > tidy.log 2>&1
  grep -q "KEEP   $WT/feat-act  (active" tidy.log || { cat tidy.log; fail "active KEEP line"; }
  grep -q "KEEP   $WT/old-v1  (old/v1 — no commits yet" tidy.log || { cat tidy.log; fail "v1 KEEP line"; }
  grep -q "KEEP   $WT/loose  (loose — no commits yet" tidy.log || { cat tidy.log; fail "unclaimed KEEP line"; }
  for d in feat-act old-v1 loose; do [ -d "$WT/$d" ] || fail "$d removed"; done
  for b in feat/act old/v1 loose bare-br; do git show-ref --verify -q "refs/heads/$b" || fail "branch $b deleted"; done
}

t_a3_retired_lane_branch_on_main_is_deleted() {
  fixture
  lane new feat/r --no-setup >/dev/null
  commit_in "$WT/feat-r" work
  git -C "$WT/feat-r" push -q -u origin feat/r
  lane release feat/r >/dev/null
  lane retire feat/r >/dev/null
  git show-ref --verify -q refs/heads/feat/r || fail "retire deleted the branch"
  merge_into_main feat/r
  lane tidy > dry.log 2>&1
  grep -q "DELETE feat/r" dry.log || { cat dry.log; fail "dry run DELETE"; }
  git show-ref --verify -q refs/heads/feat/r || fail "dry run deleted the branch"
  lane tidy --yes >/dev/null 2>&1
  git show-ref --verify -q refs/heads/feat/r && fail "retired, landed branch kept"
  true
}

t_a3_done_lane_still_fail_closed() {
  fixture
  # done + ancestor but dirty → KEEP
  lane new feat/dirty --no-setup >/dev/null
  commit_in "$WT/feat-dirty" d
  merge_into_main feat/dirty
  lane release feat/dirty >/dev/null
  echo scratch > "$WT/feat-dirty/scratch.txt"
  # done + ancestor but with a commit not on main → KEEP (not landed)
  lane new feat/ahead --no-setup >/dev/null
  commit_in "$WT/feat-ahead" a1
  merge_into_main feat/ahead
  commit_in "$WT/feat-ahead" a2
  lane release feat/ahead >/dev/null
  lane tidy --yes > tidy.log 2>&1
  grep -q "KEEP   $WT/feat-dirty  (feat/dirty — uncommitted changes" tidy.log || { cat tidy.log; fail "dirty KEEP"; }
  [ -f "$WT/feat-dirty/scratch.txt" ] || fail "dirty worktree removed"
  [ -d "$WT/feat-ahead" ] || fail "lane with unmerged commit removed"
  git show-ref --verify -q refs/heads/feat/dirty || fail "dirty lane's branch deleted"
  git show-ref --verify -q refs/heads/feat/ahead || fail "ahead lane's branch deleted"
}

# ── round 2: A5–A12 ──────────────────────────────────────────────────────────
# A released lane on its own pushed branch, ready to retire: $1 = branch.
retirable() {
  lane new "$1" --no-setup >/dev/null
  commit_in "$WT/$(printf '%s' "$1" | tr '/' '-')" "$(printf '%s' "$1" | tr '/' '-')-work"
  git -C "$WT/$(printf '%s' "$1" | tr '/' '-')" push -q -u origin "$1"
  lane release "$1" >/dev/null
}
# A released lane fast-forwarded into main: tidy --yes would remove it (A3).
landed_done() {
  lane new "$1" --no-setup >/dev/null
  commit_in "$WT/$(printf '%s' "$1" | tr '/' '-')" "$(printf '%s' "$1" | tr '/' '-')-work"
  merge_into_main "$1" ff
  lane release "$1" >/dev/null
}

t_a5_retire_refuses_untracked_hidden_by_showUntrackedFiles() {
  fixture
  retirable feat/a
  git config status.showUntrackedFiles no
  echo precious > "$WT/feat-a/NOTES.md"
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "retire exit"; eq "$(snapshot)" "$s" "state changed"
  [ -f "$WT/feat-a/NOTES.md" ] || fail "NOTES.md deleted"
}

# A5′: the user's global excludes are honoured (a .DS_Store never blocks).
t_a5p_retire_honours_global_excludes() {
  fixture
  retirable feat/a
  printf '.DS_Store\n' > "$TMP_ROOT/gexcl.$n"
  printf '[core]\n\texcludesFile = %s\n' "$TMP_ROOT/gexcl.$n" > "$TMP_ROOT/gcfg.$n"
  export GIT_CONFIG_GLOBAL="$TMP_ROOT/gcfg.$n"
  echo junk > "$WT/feat-a/.DS_Store"
  lane_rc retire feat/a
  eq "$RC" 0 "retire exit ($OUT)"
  [ ! -e "$WT/feat-a" ] || fail "not removed"
}

# A5′: a skip-worktree file absent from disk (sparse checkout) never blocks.
t_a5p_retire_skip_worktree_absent_does_not_block() {
  fixture
  retirable feat/a
  git -C "$WT/feat-a" update-index --skip-worktree README
  rm "$WT/feat-a/README"
  lane_rc retire feat/a
  eq "$RC" 0 "retire exit ($OUT)"
  [ ! -e "$WT/feat-a" ] || fail "not removed"
}

t_a5_retire_refuses_skip_worktree_and_assume_unchanged() {
  fixture
  retirable feat/a
  echo local-edit >> "$WT/feat-a/README"
  git -C "$WT/feat-a" update-index --skip-worktree README
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "skip-worktree: retire exit"; eq "$(snapshot)" "$s" "skip-worktree: state changed"
  git -C "$WT/feat-a" update-index --no-skip-worktree README
  git -C "$WT/feat-a" update-index --assume-unchanged README
  lane_rc retire feat/a
  eq "$RC" 1 "assume-unchanged: retire exit"
  grep -q local-edit "$WT/feat-a/README" || fail "hidden edit lost"
}

t_a5_tidy_keeps_done_lane_with_hidden_untracked_file() {
  fixture
  landed_done feat/a
  git config status.showUntrackedFiles no
  echo precious > "$WT/feat-a/NOTES.md"
  lane tidy --yes > tidy.log 2>&1 || { cat tidy.log; fail "tidy exit"; }
  [ -f "$WT/feat-a/NOTES.md" ] || { cat tidy.log; fail "NOTES.md deleted by tidy"; }
  grep -q "KEEP   $WT/feat-a  (feat/a — uncommitted changes" tidy.log || { cat tidy.log; fail "KEEP line"; }
}

t_a6_retire_refuses_detached_reflog_orphans() {
  fixture
  base=$(git rev-parse HEAD)
  lane new --detach r --base HEAD --no-setup >/dev/null
  commit_in "$WT/review-r" orphan
  git -C "$WT/review-r" checkout -q --detach "$base"
  lane release review-r >/dev/null
  s=$(snapshot); lane_rc retire review-r
  eq "$RC" 1 "retire exit"; eq "$(snapshot)" "$s" "state changed"
  echo "$OUT" | grep -q "1 commit(s)" || fail "count not named: $OUT"
}

t_a6_tidy_keeps_lane_with_reflog_orphans() {
  fixture
  landed_done feat/a
  commit_in "$WT/feat-a" doomed
  git -C "$WT/feat-a" reset -q --hard HEAD~1
  lane tidy --yes > tidy.log 2>&1 || { cat tidy.log; fail "tidy exit"; }
  [ -d "$WT/feat-a" ] || { cat tidy.log; fail "worktree with reflog-only commit removed"; }
  grep -q "KEEP   $WT/feat-a .*1 commit(s) in HEAD's reflog" tidy.log || { cat tidy.log; fail "KEEP line with count"; }
  git show-ref --verify -q refs/heads/feat/a || fail "branch deleted"
}

# A6′: retire lists each reflog-only commit and the override; the override
# proceeds but no other refusal is bypassed.
t_a6p_retire_lists_commits_and_override_proceeds() {
  fixture
  retirable feat/a
  commit_in "$WT/feat-a" amended-away
  lost=$(git -C "$WT/feat-a" rev-parse HEAD)
  git -C "$WT/feat-a" reset -q --hard HEAD~1
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "without the override"; eq "$(snapshot)" "$s" "state changed on refusal"
  echo "$OUT" | grep -q "$(printf '%s' "$lost" | cut -c1-12) amended-away" || fail "commit not listed: $OUT"
  echo "$OUT" | grep -q "lane.sh retire --discard-unreachable feat/a" || fail "no hint: $OUT"
  # the override still refuses a dirty lane
  echo wip > "$WT/feat-a/wip.txt"
  lane_rc retire --discard-unreachable feat/a
  eq "$RC" 1 "override bypassed the dirty refusal"
  [ -f "$WT/feat-a/wip.txt" ] || fail "wip lost"
  rm "$WT/feat-a/wip.txt"
  # ... and an unpushed commit
  commit_in "$WT/feat-a" unpushed
  lane_rc retire --discard-unreachable feat/a
  eq "$RC" 1 "override bypassed the unpushed refusal"
  git -C "$WT/feat-a" push -q origin feat/a
  lane_rc retire --discard-unreachable feat/a
  eq "$RC" 0 "override ($OUT)"
  [ ! -e "$WT/feat-a" ] || fail "not removed"
  eq "$(field feat/a 6)" retired "status"
}

t_a6p_tidy_keeps_and_prints_override_hint() {
  fixture
  landed_done feat/a
  commit_in "$WT/feat-a" doomed
  git -C "$WT/feat-a" reset -q --hard HEAD~1
  lane tidy --yes > tidy.log 2>&1 || { cat tidy.log; fail "tidy exit"; }
  [ -d "$WT/feat-a" ] || fail "removed"
  grep -q "retire --discard-unreachable" tidy.log || { cat tidy.log; fail "no hint"; }
}

t_a7_tidy_keeps_locked_worktree_and_continues() {
  fixture
  landed_done feat/a
  landed_done feat/b
  git worktree lock "$WT/feat-a"
  RC=0; lane tidy --yes > tidy.log 2>&1 || RC=$?
  eq "$RC" 0 "tidy exit"
  grep -q "KEEP   $WT/feat-a  (locked)" tidy.log || { cat tidy.log; fail "KEEP (locked) line"; }
  [ -d "$WT/feat-a" ] || fail "locked worktree removed"
  [ ! -e "$WT/feat-b" ] || { cat tidy.log; fail "tidy stopped before the next lane"; }
  git show-ref --verify -q refs/heads/feat/a || fail "locked lane's branch deleted"
}

t_a7_tidy_reports_remove_failure_continues_exit_1() {
  fixture
  landed_done feat/a
  landed_done feat/b
  lane new feat/gone --no-setup >/dev/null
  rm -rf "$WT/feat-gone"
  mkdir -p "$TMP_ROOT/shim.$n"
  printf '#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = remove ] && [ "$3" = "$FAIL_REMOVE" ]; then echo "fatal: simulated failure" >&2; exit 128; fi\nexec "%s" "$@"\n' "$REAL_GIT" > "$TMP_ROOT/shim.$n/git"
  chmod +x "$TMP_ROOT/shim.$n/git"
  RC=0; PATH="$TMP_ROOT/shim.$n:$PATH" FAIL_REMOVE="$WT/feat-a" bash "$LANE" tidy --yes > tidy.log 2>&1 || RC=$?
  eq "$RC" 1 "tidy exit"
  grep -q "KEEP   $WT/feat-a  (feat/a — remove failed: fatal: simulated failure" tidy.log || { cat tidy.log; fail "remove failed line"; }
  [ ! -e "$WT/feat-b" ] || { cat tidy.log; fail "tidy stopped part-way"; }
  git show-ref --verify -q refs/heads/feat/a || fail "branch of the failed removal deleted"
  claims | grep -q '^feat/gone' && { cat tidy.log; fail "claims prune skipped"; }
  true
}

t_a8_tidy_gone_claimed_worktree_is_not_classified() {
  fixture
  landed_done feat/a
  rm -rf "$WT/feat-a"
  RC=0; lane tidy --yes > tidy.log 2>&1 || RC=$?
  eq "$RC" 0 "tidy exit"
  grep -q "GONE   $WT/feat-a" tidy.log || { cat tidy.log; fail "GONE line"; }
  grep -q "REMOVE $WT/feat-a" tidy.log && { cat tidy.log; fail "gone worktree classified"; }
  claims | grep -q '^feat/a' && fail "claim not pruned"
  git worktree list --porcelain | grep -q "feat-a" && fail "registration not pruned"
  true
}

t_a8_tidy_gone_worktree_with_orphan_head_is_not_pruned() {
  fixture
  lane new --detach r --base HEAD --no-setup >/dev/null
  commit_in "$WT/review-r" orphan
  orphan=$(git -C "$WT/review-r" rev-parse HEAD)
  lane release review-r >/dev/null
  rm -rf "$WT/review-r"
  lane tidy --yes > tidy.log 2>&1 || { cat tidy.log; fail "tidy exit"; }
  grep -q "KEEP   $WT/review-r  (directory missing; 1 commit(s)" tidy.log || { cat tidy.log; fail "KEEP line with count"; }
  grep -q "git branch rescue-review-r worktrees/review-r/HEAD" tidy.log || { cat tidy.log; fail "recovery hint without the real id"; }
  git cat-file -e "$orphan" || fail "orphan commit object gone"
  git worktree list --porcelain | grep -q "review-r" || fail "registration pruned (its HEAD was the only ref to $orphan)"
}

t_a9_new_rejects_bad_names_exit_64_nothing_created() {
  fixture
  for bad in "has space" "a..b" "@{-1}" "@" "HEAD" "x.lock" "ends/" "$(printf 'ta\tb')" "$(printf 'nl\nx')" "$(printf 'cr\rx')"; do
    s=$(snapshot); lane_rc new "$bad" --no-setup
    eq "$RC" 64 "branch [$bad]"; eq "$(snapshot)" "$s" "branch [$bad]: state changed"
  done
  for bad in "a/b" "sp ace" "$(printf 'ta\tb')" "$(printf 'nl\nx')" 'dollar$x' 'back\slash' ""; do
    s=$(snapshot); lane_rc new --detach "$bad" --base HEAD --no-setup
    eq "$RC" 64 "slug [$bad]"; eq "$(snapshot)" "$s" "slug [$bad]: state changed"
  done
  [ ! -e .claude/state/claims.tsv ] || fail "claims written"
  [ -z "$(ls -A "$WT" 2>/dev/null)" ] || fail "worktree created: $(ls -A "$WT")"
  lane new --detach ok.slug_1-x --base HEAD --no-setup >/dev/null || fail "valid slug refused"
  lane new 'feat/ok($x)' --no-setup >/dev/null || fail "valid branch with \$ ( ) refused"
  lane new 'user@topic' --no-setup >/dev/null || fail "valid branch with @ refused"
}

t_a10_paths_with_backslash_space_dollar_parens() {
  fixture 'we ird\tab$y(z)'
  case "$P" in *'\tab$y(z)'*) ;; *) fail "fixture path lacks the specials: $P" ;; esac
  lane new feat/a --no-setup >/dev/null
  lane new feat/b --no-setup >/dev/null
  eq "$(lane port "$WT/feat-b")" "$((LANE_PORT_BASE + 1))" "port by path"
  eq "$(cd "$WT/feat-b" && bash "$LANE" port)" "$((LANE_PORT_BASE + 1))" "port from inside"
  git -C "$WT/feat-a" push -q -u origin feat/a
  lane release "$WT/feat-a" >/dev/null || fail "release by path"
  eq "$(field feat/a 6)" "done" "released"
  lane list | grep -qF "LIVE feat/b  status=active port=$((LANE_PORT_BASE + 1)) kind=branch dirty=0 ahead=0  $WT/feat-b" || { lane list; fail "list line"; }
  lane retire "$WT/feat-a" >/dev/null || fail "retire by path"
  [ ! -e "$WT/feat-a" ] || fail "not removed"
  lane new feat/c --no-setup >/dev/null
  eq "$(field feat/c 5)" "$LANE_PORT_BASE" "retired port reused"
  lane tidy --yes >/dev/null 2>&1 || fail "tidy"
  [ -d "$WT/feat-b" ] && [ -d "$WT/feat-c" ] || fail "tidy removed an active lane"
}

t_a11_crlf_and_short_rows() {
  fixture
  mkdir -p .claude/state
  git worktree add -q --detach "$WT/review-x" HEAD
  git worktree add -q "$WT/feat-six" -b feat/six
  commit_in "$WT/feat-six" six
  squash_merge feat/six
  printf 'review-x\t2026-01-01T00:00:00Z\t%s\t\t%s\tactive\tdetached\r\n' "$WT/review-x" "$((LANE_PORT_BASE + 7))" > .claude/state/claims.tsv
  printf 'feat/six\t2026-01-01T00:00:00Z\t%s\tsix cols\t%s\tactive\r\n' "$WT/feat-six" "$((LANE_PORT_BASE + 3))" >> .claude/state/claims.tsv
  eq "$(lane port "$WT/review-x")" "$((LANE_PORT_BASE + 7))" "CRLF port"
  lane list > list.log
  grep -qE "^LIVE review-x +status=active port=$((LANE_PORT_BASE + 7)) kind=detached dirty=0 ahead=- " list.log || { od -c list.log | head; fail "CRLF kind"; }
  grep -qE "^LIVE feat/six +status=active port=$((LANE_PORT_BASE + 3)) kind=branch " list.log || { cat list.log; fail "6-column active row"; }
  lane tidy --yes > tidy.log 2>&1
  grep -q "KEEP   $WT/feat-six  (active" tidy.log || { cat tidy.log; fail "6-column active row not treated as active"; }
  [ -d "$WT/feat-six" ] || fail "6-column active lane removed"
  git show-ref --verify -q refs/heads/feat/six || fail "6-column active lane's branch deleted"
  lane new feat/n --no-setup >/dev/null
  eq "$(field feat/n 5)" "$LANE_PORT_BASE" "allocation"
  lane new feat/m --no-setup >/dev/null
  eq "$(field feat/m 5)" "$((LANE_PORT_BASE + 1))" "allocation 2"
  lane release feat/six >/dev/null
  eq "$(awk -F'\t' '$1 == "feat/six" { print NF, $6, $7 }' .claude/state/claims.tsv)" "7 done branch" "6-column row rewritten in full"
  eq "$(grep -c "$(printf '\r')" .claude/state/claims.tsv)" 1 "other CRLF row left byte-for-byte"
}

t_a11_append_after_unterminated_last_line() {
  fixture
  mkdir -p .claude/state
  printf 'old/x\t2025-01-01T00:00:00Z\t/nowhere\tv1' > .claude/state/claims.tsv
  lane new feat/a --no-setup >/dev/null
  eq "$(wc -l < .claude/state/claims.tsv | tr -d ' ')" 2 "rows"
  eq "$(field feat/a 6)" active "new row intact"
  eq "$(field old/x 4)" v1 "old row intact"
}

t_a12_tidy_yes_waits_for_the_claims_lock() {
  fixture
  landed_done feat/a
  bash "$(dirname "$LANE")/with-lock.sh" claims sleep 6 &
  holder=$!
  sleep 1
  RC=0; LOCK_WAIT=2 bash "$LANE" tidy --yes > tidy.log 2>&1 || RC=$?
  wait "$holder"
  [ "$RC" -ne 0 ] || { cat tidy.log; fail "tidy --yes ran without the claims lock"; }
  [ -d "$WT/feat-a" ] || { cat tidy.log; fail "removed while another process held the claims lock"; }
  lane tidy --yes >/dev/null 2>&1 || fail "tidy after release of the lock"
  [ ! -e "$WT/feat-a" ] || fail "not removed once the lock was free"
}

# ── round 4: A44–A53 ─────────────────────────────────────────────────────────
t_a44_control_chars_in_intent_never_shift_fields() {
  fixture
  lane new feat/a "x$(printf '\037')y$(printf '\001')z$(printf '\177')w" --no-setup >/dev/null
  commit_in "$WT/feat-a" work
  git -C "$WT/feat-a" push -q -u origin feat/a
  eq "$(LC_ALL=C tr -d '\t\n' < .claude/state/claims.tsv | LC_ALL=C tr -d '\040-\176' | wc -c | tr -d ' ')" 0 "control bytes written to claims.tsv"
  eq "$(field feat/a 4)" "x y z w" "intent"
  lane list | grep -qE "^LIVE feat/a +status=active port=$LANE_PORT_BASE " || { lane list; fail "list"; }
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "retire of an active lane"; eq "$(snapshot)" "$s" "state changed"
}

t_a44_stray_us_in_existing_row_and_unknown_status_read_as_active() {
  fixture
  retirable feat/a
  # a row written by an older lane.sh: US inside the intent, status "done"
  awk -F'\t' -v OFS='\t' '$1 == "feat/a" { $4 = "a" sprintf("%c", 31) "b"; $6 = "active" } { print }' \
    .claude/state/claims.tsv > c.tmp && mv c.tmp .claude/state/claims.tsv
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "US-shifted active row retired"; eq "$(snapshot)" "$s" "state changed"
  awk -F'\t' -v OFS='\t' '$1 == "feat/a" { $4 = "plain"; $6 = "paused" } { print }' \
    .claude/state/claims.tsv > c.tmp && mv c.tmp .claude/state/claims.tsv
  lane_rc retire feat/a
  eq "$RC" 1 "unknown status retired"
  merge_into_main feat/a ff
  lane tidy --yes > tidy.log 2>&1
  grep -q "KEEP   $WT/feat-a  (active" tidy.log || { cat tidy.log; fail "unknown status not kept as active"; }
  [ -d "$WT/feat-a" ] || fail "removed"
}

t_a45_nested_worktree_blocks_retire_and_tidy() {
  fixture
  retirable feat/a
  git worktree add -q "$WT/feat-a/.claude/worktrees/inner" -b inner
  echo precious > "$WT/feat-a/.claude/worktrees/inner/PRECIOUS"
  s=$(snapshot); lane_rc retire feat/a
  eq "$RC" 1 "retire exit"; eq "$(snapshot)" "$s" "state changed"
  echo "$OUT" | grep -q "contains another registered worktree" || fail "message: $OUT"
  merge_into_main feat/a ff
  lane tidy --yes > tidy.log 2>&1
  [ -f "$WT/feat-a/.claude/worktrees/inner/PRECIOUS" ] || { cat tidy.log; fail "nested worktree's work deleted by tidy"; }
  grep -q "KEEP   $WT/feat-a  (feat/a — contains another registered worktree" tidy.log || { cat tidy.log; fail "KEEP line"; }
}

t_a46_missing_dir_with_unreadable_head_is_kept() {
  fixture
  lane new --detach r --base HEAD --no-setup >/dev/null
  commit_in "$WT/review-r" orphan
  orphan=$(git -C "$WT/review-r" rev-parse HEAD)
  lane release review-r >/dev/null
  echo "garbage" > .git/worktrees/review-r/HEAD
  rm -rf "$WT/review-r"
  RC=0; lane tidy --yes > tidy.log 2>&1 || RC=$?
  [ -d .git/worktrees/review-r ] || { cat tidy.log; fail "registration pruned"; }
  [ -f .git/worktrees/review-r/logs/HEAD ] || fail "reflog pruned"
  grep -q "$orphan" .git/worktrees/review-r/logs/HEAD || fail "orphan commit no longer in the kept reflog"
  grep -q "KEEP   $WT/review-r  (unknown" tidy.log || { cat tidy.log; fail "KEEP (unknown) line"; }
  claims | grep -q '^review-r' || fail "claim pruned"
}

t_a46_missing_dir_with_unreadable_reflog_is_kept() {
  fixture
  lane new --detach r --base HEAD --no-setup >/dev/null
  lane release review-r >/dev/null
  rm -rf "$WT/review-r"
  rm -f .git/worktrees/review-r/logs/HEAD; mkdir -p .git/worktrees/review-r/logs/HEAD
  lane tidy --yes > tidy.log 2>&1
  [ -d .git/worktrees/review-r ] || { cat tidy.log; fail "registration with an unreadable reflog pruned"; }
  grep -q "KEEP   $WT/review-r  (unknown" tidy.log || { cat tidy.log; fail "KEEP (unknown) line"; }
}

t_a47_retired_row_never_marks_a_new_worktree_finished() {
  fixture
  retirable feat/a
  lane retire feat/a >/dev/null
  # something else now lives at the same path, on an ancestor of main
  git worktree add -q "$WT/feat-a" -b other HEAD
  lane tidy --yes > tidy.log 2>&1
  [ -d "$WT/feat-a" ] || { cat tidy.log; fail "fresh unclaimed worktree at a retired path removed"; }
  git show-ref --verify -q refs/heads/other || fail "its branch deleted"
}

t_a47_done_claim_counts_only_while_on_the_claimed_branch() {
  fixture
  lane new feat/a --no-setup >/dev/null
  lane release feat/a >/dev/null
  git -C "$WT/feat-a" checkout -q -b other
  lane tidy --yes > tidy.log 2>&1
  [ -d "$WT/feat-a" ] || { cat tidy.log; fail "worktree switched to another branch treated as the finished lane"; }
  grep -q "KEEP   $WT/feat-a  (other — no commits yet" tidy.log || { cat tidy.log; fail "KEEP line"; }
}

t_a48_hand_moved_worktree_outside_canon_is_not_pruned() {
  fixture
  git worktree add -q "$TMP_ROOT/outside-$n" -b ext
  commit_in "$TMP_ROOT/outside-$n" ext-work
  mv "$TMP_ROOT/outside-$n" "$TMP_ROOT/moved-$n"
  lane tidy --yes > tidy.log 2>&1
  git worktree repair "$TMP_ROOT/moved-$n" >/dev/null 2>&1 || { cat tidy.log; fail "registration gone: repair impossible"; }
  grep -q "KEEP   $TMP_ROOT/outside-$n  (directory missing, outside .claude/worktrees/" tidy.log || { cat tidy.log; fail "KEEP line"; }
  eq "$(git -C "$TMP_ROOT/moved-$n" rev-parse --abbrev-ref HEAD)" ext "repaired worktree"
  git worktree remove "$TMP_ROOT/moved-$n"
}

t_a48_locked_missing_worktree_keeps_claim_and_port() {
  fixture
  landed_done feat/a
  git worktree lock "$WT/feat-a"
  rm -rf "$WT/feat-a"
  lane tidy --yes > tidy.log 2>&1
  claims | grep -q '^feat/a' || { cat tidy.log; fail "claim of a locked worktree pruned"; }
  grep -q "KEEP   $WT/feat-a  (locked" tidy.log || { cat tidy.log; fail "KEEP (locked) line"; }
  git worktree list --porcelain | grep -q "feat-a" || fail "registration pruned"
}

t_a49_tidy_exit_codes_only_0_1_64() {
  fixture
  landed_done feat/a
  git remote set-url origin "$TMP_ROOT/no-such-remote-$n"
  RC=0; lane tidy --yes >/dev/null 2>&1 || RC=$?; eq "$RC" 1 "fetch failure"
  [ -d "$WT/feat-a" ] || fail "removed after a failed fetch"
  git remote set-url origin "$O"
  bash "$(dirname "$LANE")/with-lock.sh" claims sleep 5 &
  holder=$!; sleep 1
  RC=0; LOCK_WAIT=1 bash "$LANE" tidy --yes >/dev/null 2>&1 || RC=$?
  wait "$holder"
  eq "$RC" 1 "claims-lock timeout"
  RC=0; lane tidy --bogus >/dev/null 2>&1 || RC=$?; eq "$RC" 64 "unknown flag"
}

t_a50_huge_reflog_goes_through_stdin() {
  fixture
  retirable feat/a
  # 20,000 distinct commits on a branch, then a 20,000-entry HEAD reflog.
  { i=1; while [ "$i" -le 20000 ]; do
      printf 'commit refs/heads/bulk\nmark :%d\ncommitter t <t@t> %d +0000\ndata 2\nc\n' "$i" "$((1700000000 + i))"
      [ "$i" -gt 1 ] && printf 'from :%d\n' "$((i - 1))"
      printf '\n'; i=$((i + 1)); done; } | git fast-import --quiet
  git rev-list --reverse bulk | awk -v z=0000000000000000000000000000000000000000 '
    { printf "%s %s t <t@t> %d +0000\tcheckout: x\n", (NR == 1 ? z : prev), $1, 1700000000 + NR; prev = $1 }' \
    > .git/worktrees/feat-a/logs/HEAD
  eq "$(wc -l < .git/worktrees/feat-a/logs/HEAD | tr -d ' ')" 20000 "reflog size"
  # land HEAD back on the lane's own commit, as the last reflog entry
  printf '%s %s t <t@t> 1800000000 +0000\tcheckout: back\n' "$(git rev-parse bulk)" "$(git rev-parse feat/a)" >> .git/worktrees/feat-a/logs/HEAD
  start=$(date +%s)
  bash "$LANE" retire feat/a > retire.log 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null && [ $(( $(date +%s) - start )) -lt 60 ]; do sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then kill_tree "$pid"; fail "retire still running after 60s"; fi
  rc=0; wait "$pid" || rc=$?
  took=$(( $(date +%s) - start ))
  eq "$rc" 0 "retire exit ($(cat retire.log))"
  [ "$took" -lt 30 ] || fail "retire took ${took}s"
}

t_a51_every_git_status_uses_no_optional_locks() {
  fixture
  retirable feat/a
  lane new feat/b --no-setup >/dev/null
  mkdir -p "$TMP_ROOT/shim.$n"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\nexec "%s" "$@"\n' "$TMP_ROOT/gitlog.$n" "$REAL_GIT" > "$TMP_ROOT/shim.$n/git"
  chmod +x "$TMP_ROOT/shim.$n/git"
  PATH="$TMP_ROOT/shim.$n:$PATH" bash "$LANE" list >/dev/null
  PATH="$TMP_ROOT/shim.$n:$PATH" bash "$LANE" tidy >/dev/null 2>&1
  PATH="$TMP_ROOT/shim.$n:$PATH" bash "$LANE" retire feat/a >/dev/null
  grep -qw status "$TMP_ROOT/gitlog.$n" || fail "shim saw no git status"
  bad=$(grep -w status "$TMP_ROOT/gitlog.$n" | grep -v -- '--no-optional-locks' || true)
  [ -z "$bad" ] || fail "git status without --no-optional-locks: $bad"
}

t_a53_detached_retire_message_and_real_hints() {
  fixture
  lane new --detach r --base HEAD --no-setup >/dev/null
  lane release review-r >/dev/null
  out=$(lane retire review-r)
  echo "$out" | grep -q "(worktree removed)" || fail "message: $out"
  echo "$out" | grep -qi branch && fail "detached retire mentions a branch: $out"
  retirable feat/a
  commit_in "$WT/feat-a" gone
  lost=$(git -C "$WT/feat-a" rev-parse HEAD | cut -c1-12)
  git -C "$WT/feat-a" reset -q --hard HEAD~1
  lane_rc retire feat/a
  echo "$OUT" | grep -q "git branch rescue-$lost $lost" || fail "hint without the real sha: $OUT"
  echo "$OUT" | grep -q '<[a-z]*>' && fail "placeholder in hint: $OUT"
  true
}

t_internal_op_refuses_without_lock() {
  fixture
  lane_rc __locked release x
  eq "$RC" 1 "__locked outside the lock"
}

for t in $(declare -F | awk '{print $3}' | grep '^t_' | grep -E "${LANE_TEST_ONLY:-.}"); do run "$t"; done
echo "── $pass passed, $failn failed ($n cases)"
[ "$failn" -eq 0 ]
