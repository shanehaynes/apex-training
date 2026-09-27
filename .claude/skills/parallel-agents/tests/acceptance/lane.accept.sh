#!/usr/bin/env bash
# Acceptance tests for scripts/lane.sh (contract v2, section 1).
# Usage: SKILL_ROOT=<dir> bash lane.accept.sh
# Case names starting with KEPT/COMPAT cover v1 behaviour the contract keeps
# (they are expected to pass on v1); AMBIGUOUS marks a reading of the contract.
set -u
SKILL_ROOT=${SKILL_ROOT:-$(cd "$(dirname "$0")/../.." && pwd -P)}
COMPONENT=lane
# shellcheck source=tests/acceptance/lib.sh
. "$(dirname "$0")/lib.sh"

LANE="$SKILL_ROOT/scripts/lane.sh"
BASE=$(pick_port_base 47000)
export LANE_PORT_BASE="$BASE" LANE_PORT_SPAN=800

lane() { # lane <args…> — runs in ${CWD:-$PRIMARY}; sets RC, OUT, ERR
  (cd "${CWD:-$PRIMARY}" && to "${LANE_TO:-120}" bash "$LANE" "$@") >"$OUT" 2>"$ERR"
  RC=$?
}
field() { awk -F'\t' -v n="$1" -v c="$2" '$1==n{print $c; exit}' "$CLAIMS" 2>/dev/null; }
ncols() { awk -F'\t' -v n="$1" '$1==n{print NF; exit}' "$CLAIMS" 2>/dev/null; }
nrows() { awk -F'\t' -v n="$1" '$1==n' "$CLAIMS" 2>/dev/null | wc -l | tr -d ' '; }
hash_port() { echo $(( LANE_PORT_BASE + $(printf '%s' "$1" | cksum | awk '{print $1}') % LANE_PORT_SPAN )); }

# seed_lane <name> [status] [port] [kind] — a worktree made with plain git plus
# a 7-column claim row, so lifecycle tests do not depend on `lane.sh new`.
seed_lane() {
  local name=$1 status=${2:-active} port=${3:-} kind=${4:-branch}
  LANE_DIR="$WTS/$(printf '%s' "$name" | tr '/' '-')"
  mkdir -p "$WTS" "$STATE"
  if [ "$kind" = branch ]; then
    git -C "$PRIMARY" worktree add -q -b "$name" "$LANE_DIR" origin/main
  else
    git -C "$PRIMARY" worktree add -q --detach "$LANE_DIR" origin/main
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "2026-09-01T00:00:00Z" "$LANE_DIR" "intent of $name" \
    "$port" "$status" "$kind" >>"$CLAIMS"
}
# seed_v1 <name> — a worktree plus a v1 (4-column) claim row.
seed_v1() {
  LANE_DIR="$WTS/$1"
  mkdir -p "$WTS" "$STATE"
  git -C "$PRIMARY" worktree add -q -b "$1" "$LANE_DIR" origin/main
  printf '%s\t%s\t%s\t%s\n' "$1" "2026-01-01T00:00:00Z" "$LANE_DIR" "old v1 lane" >>"$CLAIMS"
}
push_lane() { git -C "$LANE_DIR" push -q -u origin "$1"; }
# Everything retire must leave alone when it refuses (remote-tracking refs may
# move: the contract requires a fetch).
snapshot() {
  {
    cat "$CLAIMS"
    echo "--"
    git -C "$PRIMARY" worktree list --porcelain
    echo "--"
    git -C "$PRIMARY" for-each-ref refs/heads
    echo "--"
    [ -d "$1" ] && git -C "$1" status --porcelain
  } 2>&1
}

# ── new ─────────────────────────────────────────────────────────────────────
t_new_row() {
  make_fixture
  lane new feat/a "owns src/a" --no-setup
  rc_is "new" 0
  eq "row count for feat/a" "$(nrows feat/a)" 1
  eq "columns" "$(ncols feat/a)" 7
  check "utc column is YYYY-MM-DDTHH:MM:SSZ" grep -Eq "^feat/a${tab}[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z${tab}" "$CLAIMS"
  eq "path column" "$(field feat/a 3)" "$WTS/feat-a"
  eq "intent column" "$(field feat/a 4)" "owns src/a"
  eq "port column" "$(field feat/a 5)" "$BASE"
  eq "status column" "$(field feat/a 6)" active
  eq "kind column" "$(field feat/a 7)" branch
  check "worktree exists" test -d "$WTS/feat-a"
}

t_new_intent() {
  make_fixture
  lane new feat/a "$(printf 'owns\tsrc/a\nand b')" --no-setup
  rc_is "new" 0
  eq "row count (a newline in intent must not split the row)" "$(wc -l <"$CLAIMS" | tr -d ' ')" 1
  eq "intent" "$(field feat/a 4)" "owns src/a and b"
}

t_new_ports() {
  make_fixture
  lane new feat/a --no-setup
  rc_is "new a" 0
  out_has "ready block" "── ready"
  out_has "ready block port line" "port:[[:space:]]+$BASE\$"
  lane new feat/b --no-setup
  rc_is "new b" 0
  out_has "ready block port line for b" "port:[[:space:]]+$((BASE + 1))\$"
  eq "claim port a" "$(field feat/a 5)" "$BASE"
  eq "claim port b" "$(field feat/b 5)" "$((BASE + 1))"
  lane port "$WTS/feat-a"
  eq "lane.sh port on a" "$(tr -d '[:space:]' <"$OUT")" "$BASE"
  lane port "$WTS/feat-b"
  eq "lane.sh port on b" "$(tr -d '[:space:]' <"$OUT")" "$((BASE + 1))"
}

t_port_done_taken() {
  make_fixture
  mkdir -p "$STATE" "$FX/still-here"
  printf 'old\t2026-09-01T00:00:00Z\t%s\tx\t%s\tdone\tbranch\n' "$FX/still-here" "$BASE" >"$CLAIMS"
  lane new feat/a --no-setup
  rc_is "new" 0
  eq "port skips the done claim whose path exists" "$(field feat/a 5)" "$((BASE + 1))"
}

t_port_gone_free() {
  make_fixture
  mkdir -p "$STATE"
  printf 'old\t2026-09-01T00:00:00Z\t%s\tx\t%s\tactive\tbranch\n' "$FX/was-deleted" "$BASE" >"$CLAIMS"
  lane new feat/a --no-setup
  rc_is "new" 0
  eq "port of a claim whose path is gone is reused" "$(field feat/a 5)" "$BASE"
}

t_port_retired_free() {
  make_fixture
  mkdir -p "$STATE" "$FX/still-here"
  printf 'old\t2026-09-01T00:00:00Z\t%s\tx\t%s\tretired\tbranch\n' "$FX/still-here" "$BASE" >"$CLAIMS"
  lane new feat/a --no-setup
  rc_is "new" 0
  eq "port of a retired claim is reused" "$(field feat/a 5)" "$BASE"
}

t_port_v1_row() {
  make_fixture
  seed_v1 old-a
  local before; before=$(cat "$CLAIMS")
  lane new feat/a --no-setup
  rc_is "new" 0
  eq "a v1 row blocks no port" "$(field feat/a 5)" "$BASE"
  eq "v1 row left byte-identical" "$(head -1 "$CLAIMS")" "$before"
}

t_port_exhausted() {
  make_fixture
  mkdir -p "$STATE" "$FX/still-here"
  printf 'old\t2026-09-01T00:00:00Z\t%s\tx\t%s\tactive\tbranch\n' "$FX/still-here" "$BASE" >"$CLAIMS"
  LANE_PORT_SPAN=1 lane new feat/a --no-setup
  rc_is "new with no free port" 1
  any_has "message names the range" "$BASE"
  eq "no claim written" "$(nrows feat/a)" 0
}

t_port_listening() {
  make_fixture
  if ! command -v lsof >/dev/null 2>&1; then return 0; fi # contract: only when lsof exists
  node -e "require('net').createServer().listen($BASE,'127.0.0.1');setTimeout(()=>{},60000)" &
  local pid=$! i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -iTCP:"$BASE" -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.5
  done
  lane new feat/a --no-setup
  kill "$pid" 2>/dev/null
  rc_is "new" 0
  eq "listening port skipped" "$(field feat/a 5)" "$((BASE + 1))"
}

t_new_concurrent() {
  make_fixture
  local i pids=""
  for i in 1 2 3 4 5; do
    (cd "$PRIMARY" && to 120 bash "$LANE" new "c$i" --no-setup >"$FX/o$i" 2>&1; echo $? >"$FX/rc$i") &
    pids="$pids $!"
  done
  # shellcheck disable=SC2086
  wait $pids
  for i in 1 2 3 4 5; do eq "exit of concurrent new c$i" "$(cat "$FX/rc$i")" 0; done
  eq "rows" "$(awk -F'\t' '$1 ~ /^c[1-5]$/' "$CLAIMS" | wc -l | tr -d ' ')" 5
  eq "distinct non-empty ports" "$(awk -F'\t' '$1 ~ /^c[1-5]$/ && $5 != "" {print $5}' "$CLAIMS" | sort -u | wc -l | tr -d ' ')" 5
  eq "ports are the lowest five" "$(awk -F'\t' '$1 ~ /^c[1-5]$/ {print $5}' "$CLAIMS" | sort -n | tr '\n' ' ')" \
    "$BASE $((BASE + 1)) $((BASE + 2)) $((BASE + 3)) $((BASE + 4)) "
}

t_new_fetch_lock() {
  make_fixture
  mkdir -p "$STATE/git_fetch.lock.d"
  sleep 60 &
  local holder=$!
  echo "$holder" >"$STATE/git_fetch.lock.d/pid"
  echo "test holder" >"$STATE/git_fetch.lock.d/holder"
  LOCK_WAIT=2 lane new feat/a --no-setup
  kill "$holder" 2>/dev/null
  any_has "new contends for the git_fetch lock" "git_fetch"
}

t_new_claims_lock() {
  make_fixture
  mkdir -p "$STATE/claims.lock.d"
  sleep 60 &
  local holder=$!
  echo "$holder" >"$STATE/claims.lock.d/pid"
  echo "test holder" >"$STATE/claims.lock.d/holder"
  LOCK_WAIT=2 lane new feat/a --no-setup
  eq "no row written while the claims lock is held" "$(nrows feat/a)" 0
  kill "$holder" 2>/dev/null
  rm -rf "$STATE/claims.lock.d"
  # and it works once the lock is free
  lane new feat/b --no-setup
  rc_is "new after lock released" 0
  eq "row written once the lock is free" "$(nrows feat/b)" 1
}

t_new_detach() {
  make_fixture
  local full short
  full=$(git -C "$PRIMARY" rev-parse origin/main~1)
  short=$(git -C "$PRIMARY" rev-parse --short origin/main~1)
  lane new --detach rv1 --base "$short" "review of x" --no-setup
  rc_is "new --detach" 0
  local dir="$WTS/review-rv1"
  check "worktree at .claude/worktrees/review-<slug>" test -d "$dir"
  check_not "HEAD is detached" git -C "$dir" symbolic-ref -q HEAD
  eq "checked out at the base" "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" "$full"
  out_has "ready block prints full sha" "sha:[[:space:]]+$full"
  out_lacks "ready block has no branch: line" "^[[:space:]]*branch:"
  eq "claim name" "$(nrows review-rv1)" 1
  eq "claim columns" "$(ncols review-rv1)" 7
  eq "claim status" "$(field review-rv1 6)" active
  eq "claim kind" "$(field review-rv1 7)" detached
  eq "claim path" "$(field review-rv1 3)" "$dir"
  eq "claim port" "$(field review-rv1 5)" "$BASE"
  check_not "no branch rv1 created" git -C "$PRIMARY" show-ref --verify --quiet refs/heads/rv1
  check_not "no branch review-rv1 created" git -C "$PRIMARY" show-ref --verify --quiet refs/heads/review-rv1
}

t_new_detach_nobase() {
  make_fixture
  lane new --detach rv1 --no-setup
  rc_is "new --detach without --base" 64
  check_not "no worktree" test -e "$WTS/review-rv1"
}

t_new_setup_kept() {
  make_fixture
  lane new feat/a --setup "touch setup-ran"
  rc_is "new --setup" 0
  check "setup command ran in the worktree" test -f "$WTS/feat-a/setup-ran"
}

# ── port ────────────────────────────────────────────────────────────────────
t_port_claimed() {
  make_fixture
  seed_lane feat/p active $((BASE + 7))
  lane port "$LANE_DIR"
  eq "claimed worktree → claim port" "$(tr -d '[:space:]' <"$OUT")" "$((BASE + 7))"
  CWD="$LANE_DIR" lane port
  eq "DIR defaults to ." "$(tr -d '[:space:]' <"$OUT")" "$((BASE + 7))"
  ln -s "$LANE_DIR" "$FX/link"
  lane port "$FX/link"
  eq "claim matched by resolved path (symlink)" "$(tr -d '[:space:]' <"$OUT")" "$((BASE + 7))"
}

t_port_primary() {
  make_fixture
  LANE_PORT_DEFAULT=6123 lane port "$PRIMARY"
  eq "primary → LANE_PORT_DEFAULT" "$(cat "$OUT")" 6123
  lane port "$PRIMARY"
  eq "primary → 5173 by default" "$(cat "$OUT")" 5173
}

t_port_unclaimed_hash() {
  make_fixture
  mkdir -p "$WTS"
  git -C "$PRIMARY" worktree add -q -b loose "$WTS/loose" origin/main
  lane port "$WTS/loose"
  eq "unclaimed worktree → cksum hash" "$(cat "$OUT")" "$(hash_port loose)"
}

t_port_v1_hash() {
  make_fixture
  seed_v1 old-a
  lane port "$LANE_DIR"
  eq "v1 row → cksum hash" "$(cat "$OUT")" "$(hash_port old-a)"
}

# ── release ─────────────────────────────────────────────────────────────────
t_release() {
  make_fixture
  seed_v1 old-a
  seed_lane feat/x active $((BASE + 1))
  seed_lane feat/r active $((BASE + 2))
  seed_lane feat/y active $((BASE + 3))
  local before; before=$(cat "$CLAIMS")
  lane release feat/r
  rc_is "release" 0
  eq "status → done" "$(field feat/r 6)" "done"
  local want
  want=$(printf '%s\n' "$before" | awk -F'\t' 'BEGIN{OFS="\t"} $1=="feat/r"{$6="done"} {print}')
  eq "every other byte of claims.tsv unchanged" "$(cat "$CLAIMS")" "$want"
  lane release feat/r
  rc_is "release again (idempotent)" 0
  eq "still done" "$(field feat/r 6)" "done"
  eq "no duplicate row" "$(nrows feat/r)" 1
}

t_release_path() {
  make_fixture
  seed_lane feat/r active $((BASE + 2))
  lane release "$LANE_DIR"
  rc_is "release by path" 0
  eq "status → done" "$(field feat/r 6)" "done"
}

t_release_unknown() {
  make_fixture
  seed_lane feat/r active $((BASE + 2))
  local before; before=$(cat "$CLAIMS")
  lane release nope
  rc_is "release unknown lane" 1
  eq "claims unchanged" "$(cat "$CLAIMS")" "$before"
}

t_release_v1() {
  make_fixture
  seed_v1 old-a
  local before; before=$(cat "$CLAIMS")
  lane release old-a
  rc_is "release of a v1 row (status already done)" 0
  eq "v1 row not rewritten (status unchanged)" "$(cat "$CLAIMS")" "$before"
}

# ── retire ──────────────────────────────────────────────────────────────────
retire_refuses() { # retire_refuses <what> <name> <dir>
  local before after
  before=$(snapshot "$3")
  lane retire "$2"
  rc_is "retire ($1)" 1
  after=$(snapshot "$3")
  eq "nothing changed ($1)" "$after" "$before"
  check "worktree still there ($1)" test -d "$3"
}

t_retire_active() {
  make_fixture
  seed_lane feat/r active $((BASE + 1))
  push_lane feat/r
  retire_refuses "active lane" feat/r "$LANE_DIR"
  any_has "tells you to release it first" "[Rr]elease"
}

t_retire_tracked() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  echo changed >>"$LANE_DIR/shared.txt"
  retire_refuses "tracked change" feat/r "$LANE_DIR"
}

t_retire_untracked() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  echo new >"$LANE_DIR/untracked.txt"
  retire_refuses "untracked file" feat/r "$LANE_DIR"
  check "untracked file kept" test -f "$LANE_DIR/untracked.txt"
}

t_retire_unpushed() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  commit_file "$LANE_DIR" r.txt r
  retire_refuses "unpushed commit" feat/r "$LANE_DIR"
}

t_retire_never_pushed() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  retire_refuses "branch never pushed" feat/r "$LANE_DIR"
}

t_retire_remote_moved() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  local o; o=$(other_clone)
  git -C "$o" fetch -q origin
  git -C "$o" checkout -q -b feat/r origin/feat/r
  commit_file "$o" remote.txt r "pushed from elsewhere"
  git -C "$o" push -q origin feat/r
  # local origin/feat/r still equals the local head; only a fetch shows the difference
  retire_refuses "origin/<branch> moved since the last fetch" feat/r "$LANE_DIR"
}

t_retire_ok() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  commit_file "$LANE_DIR" r.txt r
  push_lane feat/r
  local before; before=$(cat "$CLAIMS")
  lane retire feat/r
  rc_is "retire" 0
  check_not "worktree directory removed" test -e "$LANE_DIR"
  check_not "worktree unregistered" sh -c "git -C '$PRIMARY' worktree list --porcelain | grep -qF '$LANE_DIR'"
  eq "status → retired" "$(field feat/r 6)" retired
  local want
  want=$(printf '%s\n' "$before" | awk -F'\t' 'BEGIN{OFS="\t"} $1=="feat/r"{$6="retired"} {print}')
  eq "only the status column changed" "$(cat "$CLAIMS")" "$want"
  check "local branch kept" git -C "$PRIMARY" show-ref --verify --quiet refs/heads/feat/r
  check "remote branch kept" sh -c "git -C '$PRIMARY' ls-remote --exit-code origin refs/heads/feat/r"
}

t_retire_by_path() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  lane retire "$LANE_DIR"
  rc_is "retire by path" 0
  eq "status → retired" "$(field feat/r 6)" retired
}

t_retire_ignored() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  mkdir -p "$LANE_DIR/node_modules/pkg"
  echo x >"$LANE_DIR/node_modules/pkg/index.js"
  lane retire feat/r
  rc_is "retire with only ignored files" 0
  check_not "worktree removed" test -e "$LANE_DIR"
  eq "status → retired" "$(field feat/r 6)" retired
}

t_retire_no_force() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  mkdir -p "$FX/shim"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s"\nexec "%s" "$@"\n' "$FX/git.log" "$REAL_GIT" >"$FX/shim/git"
  chmod +x "$FX/shim/git"
  PATH="$FX/shim:$PATH" lane retire feat/r
  rc_is "retire" 0
  check "git worktree remove was called" grep -Eq '(^| )worktree remove' "$FX/git.log"
  check_not "never --force / -f" grep -Eq 'worktree remove.*( --force| -f( |$)|-ff)' "$FX/git.log"
}

t_retire_locked() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  git -C "$PRIMARY" worktree lock "$LANE_DIR"
  lane retire feat/r
  rc_is "retire of a locked worktree fails" 1
  check "locked worktree not removed" test -d "$LANE_DIR"
  eq "status not changed to retired" "$(field feat/r 6)" "done"
  git -C "$PRIMARY" worktree unlock "$LANE_DIR" 2>/dev/null
}

t_retire_detached() {
  make_fixture
  seed_lane review-x "done" $((BASE + 1)) detached
  lane retire review-x
  rc_is "retire detached lane" 0
  check_not "worktree removed" test -e "$LANE_DIR"
  eq "status → retired" "$(field review-x 6)" retired
  eq "kind kept" "$(field review-x 7)" detached
}

t_retire_detached_dirty() {
  make_fixture
  seed_lane review-x "done" $((BASE + 1)) detached
  echo x >"$LANE_DIR/notes.md"
  retire_refuses "dirty detached lane" review-x "$LANE_DIR"
}

t_retire_v1() {
  make_fixture
  seed_v1 old-a
  push_lane old-a
  lane retire old-a
  rc_is "retire a v1 lane" 0
  eq "rewritten with 7 columns" "$(ncols old-a)" 7
  eq "status retired" "$(field old-a 6)" retired
  eq "kind branch" "$(field old-a 7)" branch
  eq "port stays empty" "$(field old-a 5)" ""
  eq "columns 1-4 unchanged" "$(awk -F'\t' '$1=="old-a"{print $1"|"$2"|"$3"|"$4}' "$CLAIMS")" \
    "old-a|2026-01-01T00:00:00Z|$LANE_DIR|old v1 lane"
}

t_retire_unknown() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  lane retire nope
  rc_is "retire unknown lane" 1
}

# ── list ────────────────────────────────────────────────────────────────────
t_list_live() {
  make_fixture
  seed_lane feat/l active $((BASE + 4))
  commit_file "$LANE_DIR" l.txt l
  echo a >"$LANE_DIR/u1"; echo b >"$LANE_DIR/u2"
  lane list
  rc_is "list" 0
  local line; line=$(grep -E '(^|[[:space:]])feat/l([[:space:]]|$)' "$OUT" | head -1)
  check "LIVE line for feat/l (got: $line)" sh -c "printf '%s' \"\$1\" | grep -Eq '^[[:space:]]*LIVE'" _ "$line"
  check "fields in contract order: LIVE name status= port= kind= dirty= ahead= path intent (got: $line)" \
    sh -c "printf '%s' \"\$1\" | grep -Eq \"LIVE.*feat/l.*status=active.*port=$((BASE + 4)).*kind=branch.*dirty=2.*ahead=1.*$LANE_DIR.*intent of feat/l\"" _ "$line"
}

t_list_detached() {
  make_fixture
  seed_lane review-d "done" $((BASE + 5)) detached
  lane list
  local line; line=$(grep -E 'review-d' "$OUT" | head -1)
  check "detached lane: kind=detached and ahead=- (got: $line)" \
    sh -c "printf '%s' \"\$1\" | grep -Eq 'status=done.*kind=detached.*ahead=-([[:space:]]|$)'" _ "$line"
}

t_list_gone_v1() {
  make_fixture
  seed_v1 old-a
  seed_lane feat/g active $((BASE + 6))
  git -C "$PRIMARY" worktree remove "$LANE_DIR"
  lane list
  rc_is "list" 0
  local g v
  g=$(grep -E 'feat/g' "$OUT" | head -1)
  v=$(grep -E 'old-a' "$OUT" | head -1)
  check "GONE line for missing path (got: $g)" sh -c "printf '%s' \"\$1\" | grep -Eq '^[[:space:]]*GONE.*feat/g.*status=active'" _ "$g"
  check "v1 row listed as status=done kind=branch (got: $v)" \
    sh -c "printf '%s' \"\$1\" | grep -Eq '^[[:space:]]*LIVE.*old-a.*status=done.*kind=branch'" _ "$v"
}

# ── tidy ────────────────────────────────────────────────────────────────────
# Lane with one commit that has landed on origin/main as a squash merge (the
# case tidy's "merged" detection exists for; a fast-forward looks "fresh").
landed_lane() {
  seed_lane "$1" "$2" "$3"
  commit_file "$LANE_DIR" "$(echo "$1" | tr '/' '-').txt" x
  git -C "$LANE_DIR" push -q -u origin "$1"
  local o; o=$(other_clone)
  git -C "$o" fetch -q origin
  git -C "$o" checkout -q main
  git -C "$o" merge -q --ff-only origin/main
  git -C "$o" merge -q --squash "origin/$1" >/dev/null
  git -C "$o" commit -qm "squash $1"
  git -C "$o" push -q origin main
}

t_tidy_active() {
  make_fixture
  landed_lane feat/m active $((BASE + 1))
  local merged=$LANE_DIR
  seed_lane feat/n active $((BASE + 2)) # active, no commits of its own
  local fresh=$LANE_DIR
  lane tidy --yes
  rc_is "tidy --yes" 0
  check "merged active lane kept" test -d "$merged"
  check "its branch kept" git -C "$PRIMARY" show-ref --verify --quiet refs/heads/feat/m
  out_has "reported KEEP … (active …)" "KEEP[[:space:]]+${merged}[[:space:]].*active"
  out_has "fresh active lane reported as active" "KEEP[[:space:]]+${fresh}[[:space:]].*active"
  eq "claim still there" "$(nrows feat/m)" 1
}

t_tidy_done_removed() {
  make_fixture
  landed_lane feat/m "done" $((BASE + 1))
  lane tidy --yes
  rc_is "tidy --yes" 0
  check_not "merged done lane removed" test -e "$LANE_DIR"
}

# Amendment A3: a lane landed by a merge commit (tip is an ancestor of main)
# counts as landed when its claim says the worker finished (done/retired);
# while active, or unclaimed, the v1 rule (ancestor = "not started") holds.
merged_lane_noff() {
  seed_lane "$1" "$2" "$3"
  commit_file "$LANE_DIR" "$(echo "$1" | tr '/' '-').txt" x
  git -C "$LANE_DIR" push -q -u origin "$1"
  local o; o=$(other_clone)
  git -C "$o" fetch -q origin
  git -C "$o" checkout -q main
  git -C "$o" merge -q --ff-only origin/main
  git -C "$o" merge -q --no-ff -m "merge $1" "origin/$1" >/dev/null
  git -C "$o" push -q origin main
}

t_tidy_mergecommit_done() {
  make_fixture
  merged_lane_noff feat/mc "done" $((BASE + 1))
  local d=$LANE_DIR
  lane tidy --yes
  rc_is "tidy --yes" 0
  check_not "merge-commit-landed done lane removed" test -e "$d"
}

t_tidy_mergecommit_active() {
  make_fixture
  merged_lane_noff feat/mca active $((BASE + 1))
  local d=$LANE_DIR
  lane tidy --yes
  rc_is "tidy --yes" 0
  check "merge-commit-landed active lane kept" test -d "$d"
}

t_tidy_prune() {
  make_fixture
  seed_lane feat/keep active $((BASE + 1))
  seed_lane feat/gone "done" $((BASE + 2))
  git -C "$PRIMARY" worktree remove "$LANE_DIR"
  local keep; keep=$(awk -F'\t' '$1=="feat/keep"' "$CLAIMS")
  lane tidy
  eq "dry run prunes nothing" "$(nrows feat/gone)" 1
  lane tidy --yes
  eq "claim with gone path pruned" "$(nrows feat/gone)" 0
  eq "other row intact" "$(awk -F'\t' '$1=="feat/keep"' "$CLAIMS")" "$keep"
}

# ── misc ────────────────────────────────────────────────────────────────────
t_root() {
  make_fixture
  seed_lane feat/r active $((BASE + 1))
  CWD="$LANE_DIR" lane root
  eq "root from inside a lane" "$(cat "$OUT")" "$PRIMARY"
}

t_usage() {
  make_fixture
  lane frobnicate
  rc_is "unknown subcommand" 64
  lane new
  rc_is "new without a branch" 64
}

# ── round-2 amendments (A5–A13) ─────────────────────────────────────────────
# squash_land <branch>: land origin/<branch> on origin/main as a squash merge.
squash_land() {
  local o; o=$(other_clone)
  git -C "$o" fetch -q origin
  git -C "$o" checkout -q main
  git -C "$o" merge -q --ff-only origin/main
  git -C "$o" merge -q --squash "origin/$1" >/dev/null
  git -C "$o" commit -qm "squash $1"
  git -C "$o" push -q origin main
}
# Lines of $OUT that mention path $1 must all start with $2 (a regex).
lines_for_path_start_with() {
  local l bad=""
  while IFS= read -r l; do
    printf '%s' "$l" | grep -Eq "^[[:space:]]*$2" || bad="$bad | $l"
  done < <(grep -F -- "$1" "$OUT")
  eq "$3" "$bad" ""
}
hold_lock() { # hold_lock <name> — plants a lock held by a live pid; sets HOLDER
  mkdir -p "$STATE/$1.lock.d"
  sleep 120 &
  HOLDER=$!
  echo "$HOLDER" >"$STATE/$1.lock.d/pid"
  echo "acceptance test holder" >"$STATE/$1.lock.d/holder"
}
drop_lock() { kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -rf "$STATE/$1.lock.d"; }

t_a5_untracked_hidden() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  git -C "$PRIMARY" config status.showUntrackedFiles no
  echo new >"$LANE_DIR/untracked.txt"
  retire_refuses "untracked file with status.showUntrackedFiles=no" feat/r "$LANE_DIR"
  check "untracked file kept" test -f "$LANE_DIR/untracked.txt"
}

t_a5_skip_worktree() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  git -C "$LANE_DIR" update-index --skip-worktree shared.txt
  echo "local edit hidden by skip-worktree" >"$LANE_DIR/shared.txt"
  retire_refuses "skip-worktree file with local edits" feat/r "$LANE_DIR"
  eq "edit kept" "$(cat "$LANE_DIR/shared.txt" 2>/dev/null)" "local edit hidden by skip-worktree"
}

t_a5_assume_unchanged() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  push_lane feat/r
  git -C "$LANE_DIR" update-index --assume-unchanged shared.txt
  retire_refuses "assume-unchanged file (fail closed)" feat/r "$LANE_DIR"
}

t_a5_tidy() {
  make_fixture
  landed_lane feat/u "done" $((BASE + 1))
  local u=$LANE_DIR
  git -C "$PRIMARY" config status.showUntrackedFiles no
  echo keep >"$u/notes.txt"
  landed_lane feat/s "done" $((BASE + 2))
  local sdir=$LANE_DIR
  git -C "$sdir" update-index --skip-worktree shared.txt
  echo hidden >"$sdir/shared.txt"
  lane tidy --yes
  check "landed lane with a hidden untracked file kept" test -f "$u/notes.txt"
  check "landed lane with a skip-worktree edit kept" test -d "$sdir"
  out_has "untracked lane reported KEEP" "KEEP[[:space:]]+${u}[[:space:]]"
  out_has "skip-worktree lane reported KEEP" "KEEP[[:space:]]+${sdir}[[:space:]]"
}

t_a6_retire() {
  make_fixture
  seed_lane feat/r "done" $((BASE + 1))
  commit_file "$LANE_DIR" r.txt r
  push_lane feat/r
  commit_file "$LANE_DIR" lost.txt lost "only in the reflog after the reset"
  git -C "$LANE_DIR" reset -q --hard HEAD~1
  retire_refuses "HEAD reflog holds an unreachable commit" feat/r "$LANE_DIR"
  any_has "message names the count (1)" "(^|[^0-9])1([^0-9]|$).*(commit|reflog|unreachable)|(commit|reflog|unreachable).*(^|[^0-9])1([^0-9]|$)"
}

t_a6_detached() {
  make_fixture
  seed_lane review-x "done" $((BASE + 1)) detached
  commit_file "$LANE_DIR" a.txt a "detached work 1"
  commit_file "$LANE_DIR" b.txt b "detached work 2"
  git -C "$LANE_DIR" checkout -q --detach origin/main
  retire_refuses "detached lane whose reflog holds 2 unreachable commits" review-x "$LANE_DIR"
  any_has "message names the count (2)" "(^|[^0-9])2([^0-9]|$)"
}

t_a6_tidy() {
  make_fixture
  landed_lane feat/m "done" $((BASE + 1))
  commit_file "$LANE_DIR" lost.txt lost
  git -C "$LANE_DIR" reset -q --hard HEAD~1
  lane tidy --yes
  check "landed lane with an unreachable reflog commit kept" test -d "$LANE_DIR"
  out_has "reported KEEP" "KEEP[[:space:]]+${LANE_DIR}[[:space:]]"
}

# ── round 3 (orchestrator) ──────────────────────────────────────────────────
t_a5p_global_excludes() {
  make_fixture
  seed_lane feat/g "done" $((BASE + 1))
  push_lane feat/g
  printf '.DS_Store\n' >"$FX/global-excludes"
  git config --global core.excludesFile "$FX/global-excludes"
  echo finder >"$LANE_DIR/.DS_Store"
  lane retire feat/g
  rc_is "retire with only a globally ignored .DS_Store" 0
  check_not "worktree removed" test -e "$LANE_DIR"
  git config --global --unset core.excludesFile
}

t_a5p_sparse_absent() {
  make_fixture
  seed_lane feat/sp "done" $((BASE + 1))
  push_lane feat/sp
  git -C "$LANE_DIR" update-index --skip-worktree shared.txt
  rm -f "$LANE_DIR/shared.txt"
  lane retire feat/sp
  rc_is "retire with a skip-worktree file absent from disk" 0
}

t_a6p_override() {
  make_fixture
  seed_lane feat/o "done" $((BASE + 1))
  commit_file "$LANE_DIR" o.txt o
  push_lane feat/o
  commit_file "$LANE_DIR" gone.txt gone "superseded by an amend"
  local lost; lost=$(git -C "$LANE_DIR" rev-parse HEAD)
  git -C "$LANE_DIR" reset -q --hard HEAD~1
  lane retire feat/o
  rc_is "retire without the override" 1
  any_has "lists the commit (sha12 + subject)" "${lost:0:12}.*superseded by an amend"
  any_has "hints the override" "retire --discard-unreachable"
  check "still there after refusal" test -d "$LANE_DIR"
  lane retire --discard-unreachable feat/o
  rc_is "retire --discard-unreachable" 0
  check_not "worktree removed with the override" test -e "$LANE_DIR"
}

t_a6p_override_keeps_other_refusals() {
  make_fixture
  seed_lane feat/q "done" $((BASE + 1))
  commit_file "$LANE_DIR" q.txt q
  push_lane feat/q
  commit_file "$LANE_DIR" gone.txt gone "superseded"
  git -C "$LANE_DIR" reset -q --hard HEAD~1
  echo dirty >"$LANE_DIR/wip.txt"
  lane retire --discard-unreachable feat/q
  rc_is "override does not bypass the dirty refusal" 1
  check "untracked work kept" test -f "$LANE_DIR/wip.txt"
}

t_a6p_tidy_hint() {
  make_fixture
  landed_lane feat/t "done" $((BASE + 1))
  commit_file "$LANE_DIR" lost.txt lost
  git -C "$LANE_DIR" reset -q --hard HEAD~1
  lane tidy --yes
  check "kept" test -d "$LANE_DIR"
  any_has "tidy prints the override hint" "retire --discard-unreachable"
}

t_a7_locked() {
  make_fixture
  landed_lane feat/lk "done" $((BASE + 1))
  local lk=$LANE_DIR
  git -C "$PRIMARY" worktree lock "$lk"
  landed_lane feat/ok "done" $((BASE + 2))
  local okd=$LANE_DIR
  lane tidy --yes
  rc_is "tidy --yes with a locked worktree (nothing failed)" 0
  out_has "locked worktree reported KEEP … (locked)" "KEEP[[:space:]]+${lk}[[:space:]].*locked"
  check "locked worktree kept" test -d "$lk"
  check_not "the run continued: other landed lane removed" test -e "$okd"
  git -C "$PRIMARY" worktree unlock "$lk" 2>/dev/null
}

t_a7_remove_failed() {
  make_fixture
  git init -q -b main "$FX/subrepo"
  git -C "$FX/subrepo" commit -q --allow-empty -m sub
  seed_lane feat/a-sm "done" $((BASE + 1))
  local sm=$LANE_DIR
  git -C "$sm" -c protocol.file.allow=always submodule add -q "$FX/subrepo" sub >/dev/null 2>&1
  git -C "$sm" commit -qm "add submodule"
  git -C "$sm" push -q -u origin feat/a-sm
  squash_land feat/a-sm
  landed_lane feat/z-ok "done" $((BASE + 2))
  local okd=$LANE_DIR
  lane tidy --yes
  rc_is "tidy --yes when one removal fails" 1
  out_has "failed removal reported KEEP … (remove failed: …)" "KEEP[[:space:]]+${sm}[[:space:]].*remove failed"
  check "worktree whose removal failed is still there" test -d "$sm"
  check_not "the run continued: other landed lane removed" test -e "$okd"
}

t_a8_gone() {
  make_fixture
  landed_lane feat/gd "done" $((BASE + 1))
  local d=$LANE_DIR
  rm -rf "$d"
  lane tidy
  out_has "claimed worktree with a missing directory reported GONE" "GONE.*${d}"
  lines_for_path_start_with "$d" "GONE" "lines naming the missing worktree that are not GONE"
  lane tidy --yes
  rc_is "tidy --yes" 0
  lines_for_path_start_with "$d" "GONE" "lines naming the missing worktree that are not GONE (--yes)"
  eq "its claim pruned" "$(nrows feat/gd)" 0
}

t_a9_names() {
  make_fixture
  mkdir -p "$STATE" "$WTS"
  : >"$CLAIMS"
  local n bad="" before
  heads() { git -C "$PRIMARY" for-each-ref --format='%(refname)' refs/heads | sort; }
  before=$(heads)
  for n in "bad name" "a..b" "feat/" "x.lock" "$(printf 'a\tb')" "a~b" "a:b" "a^b" "@" "trail " "$(printf 'ctl\001x')"; do
    lane new "$n" --no-setup
    [ "$RC" = 64 ] || bad="$bad [$n → exit $RC]"
  done
  for n in "bad/slug" "x y" "a:b" "sl\$ug" ""; do
    lane new --detach "$n" --base origin/main --no-setup
    [ "$RC" = 64 ] || bad="$bad [--detach '$n' → exit $RC]"
  done
  eq "invalid names not rejected with 64" "$bad" ""
  eq "no claim written" "$(wc -c <"$CLAIMS" | tr -d ' ')" 0
  eq "no worktree created" "$(ls -A "$WTS")" ""
  eq "no branch created" "$(heads)" "$before"
  lane new --detach "ok.slug_1-x" --base origin/main --no-setup
  rc_is "a valid slug [A-Za-z0-9._-]+ is accepted" 0
}

A10_DIR='we ird $x (p) \b/primary'
t_a10_new() {
  make_fixture "$A10_DIR"
  lane new feat/a 'intent with \n and \t literally' --no-setup
  rc_is "new under a path with space, \$, (, ), backslash" 0
  eq "claim path" "$(field feat/a 3)" "$WTS/feat-a"
  eq "intent kept literally" "$(field feat/a 4)" 'intent with \n and \t literally'
  lane port "$WTS/feat-a"
  eq "port by path" "$(tr -d '[:space:]' <"$OUT")" "$BASE"
  CWD="$WTS/feat-a" lane port
  eq "port from inside the lane" "$(tr -d '[:space:]' <"$OUT")" "$BASE"
  lane list
  out_has "list shows it LIVE and active" "LIVE.*feat/a.*status=active.*port=$BASE"
}

t_a10_lifecycle() {
  make_fixture "$A10_DIR"
  seed_lane feat/r active $((BASE + 1))
  commit_file "$LANE_DIR" r.txt r
  push_lane feat/r
  lane release "$LANE_DIR"
  rc_is "release by path" 0
  eq "status done" "$(field feat/r 6)" "done"
  lane retire "$LANE_DIR"
  rc_is "retire by path" 0
  eq "status retired" "$(field feat/r 6)" retired
  check_not "worktree removed" test -e "$LANE_DIR"
  landed_lane feat/t "done" $((BASE + 2))
  lane tidy --yes
  rc_is "tidy --yes" 0
  check_not "landed lane removed by tidy" test -e "$LANE_DIR"
}

# seed_raw <name> <columns after intent> <lf|crlf> — worktree plus a hand-written row
seed_raw() {
  LANE_DIR="$WTS/$1"
  mkdir -p "$WTS" "$STATE"
  git -C "$PRIMARY" worktree add -q -b "$1" "$LANE_DIR" origin/main
  local eol='\n'; [ "$3" = crlf ] && eol='\r\n'
  # shellcheck disable=SC2059
  printf "%s\t2026-09-01T00:00:00Z\t%s\tintent%s$eol" "$1" "$LANE_DIR" "$2" >>"$CLAIMS"
}

t_a11_crlf() {
  make_fixture
  seed_raw crlf "$(printf '\t%s\tactive\tbranch' "$BASE")" crlf
  local d=$LANE_DIR
  lane port "$d"
  eq "port of a CRLF row" "$(tr -d '\n' <"$OUT")" "$BASE"
  lane list
  check_not "no carriage return in list output" grep -q "$(printf '\r')" "$OUT"
  out_has "CRLF row is active, kind=branch" "crlf.*status=active.*kind=branch"
  lane new feat/b --no-setup
  rc_is "new with a CRLF row present" 0
  eq "a CRLF active row still holds its port" "$(field feat/b 5)" "$((BASE + 1))"
  retire_refuses "CRLF row is active" crlf "$d"
}

t_a11_six_col() {
  make_fixture
  seed_raw six "$(printf '\t%s\tactive' "$BASE")" lf
  local d=$LANE_DIR
  lane new feat/b --no-setup
  rc_is "new with a 6-column row present" 0
  eq "6-column active row holds its port" "$(field feat/b 5)" "$((BASE + 1))"
  lane list
  out_has "6-column row listed active" "six.*status=active"
  retire_refuses "6-column active row" six "$d"
}

t_a11_five_col() {
  make_fixture
  seed_raw five "$(printf '\t%s' "$((BASE + 3))")" lf
  local d=$LANE_DIR
  lane port "$d"
  eq "5-column row: its port is used" "$(tr -d '[:space:]' <"$OUT")" "$((BASE + 3))"
  lane list
  out_has "5-column row listed status=done port=$((BASE + 3))" "five.*status=done.*port=$((BASE + 3))"
}

t_a12_tidy_lock() {
  make_fixture
  landed_lane feat/m "done" $((BASE + 1))
  seed_lane feat/gone "done" $((BASE + 2))
  git -C "$PRIMARY" worktree remove "$LANE_DIR"
  local m="$WTS/feat-m"
  hold_lock claims
  LOCK_WAIT=2 lane tidy --yes
  check "no removal while the claims lock is held" test -d "$m"
  eq "no prune while the claims lock is held" "$(nrows feat/gone)" 1
  drop_lock claims
  lane tidy --yes
  rc_is "tidy --yes once the lock is free" 0
  check_not "removal happens once the lock is free" test -e "$m"
}

with_lock() { # with_lock <args…> — sets RC/OUT/ERR
  (cd "$PRIMARY" && to 60 bash "$SKILL_ROOT/scripts/with-lock.sh" "$@") >"$OUT" 2>"$ERR"
  RC=$?
}

t_a13_nopid_old() {
  make_fixture
  mkdir -p "$STATE/wl.lock.d"
  touch -t 202001010000 "$STATE/wl.lock.d"
  LOCK_WAIT=8 with_lock wl sh -c 'echo ran'
  rc_is "old pid-less lock reaped (default grace 10s)" 0
  out_has "command ran" "^ran$"
  mkdir -p "$STATE/wl2.lock.d"
  LOCK_NOPID_GRACE=1 LOCK_WAIT=8 with_lock wl2 sh -c 'echo ran'
  rc_is "pid-less lock older than LOCK_NOPID_GRACE=1 reaped" 0
}

t_a13_nopid_young() {
  make_fixture
  mkdir -p "$STATE/wl.lock.d"
  LOCK_WAIT=3 with_lock wl sh -c 'echo ran'
  rc_is "fresh pid-less lock (holder mid-acquire) is not reaped: gives up" 75
  out_lacks "command did not run" "^ran$"
  check "lock dir untouched" test -d "$STATE/wl.lock.d"
}

t_a13_race() {
  make_fixture
  mkdir -p "$STATE"
  local cnt="$FX/count" viol="$FX/violations" inside="$FX/inside.d" rounds=10 n=6 i dead pids
  echo 0 >"$cnt"; : >"$viol"
  # shellcheck disable=SC2016
  local body='mkdir "$IN" 2>/dev/null || echo overlap >>"$VIOL"; v=$(cat "$CNT"); sleep 0.05; echo $((v + 1)) >"$CNT"; rmdir "$IN" 2>/dev/null; true'
  for _ in $(seq 1 "$rounds"); do
    mkdir -p "$STATE/ctr.lock.d"
    sh -c 'exit 0' & dead=$!; wait "$dead"
    echo "$dead" >"$STATE/ctr.lock.d/pid" # stale: its holder is dead
    pids=""
    for i in $(seq 1 "$n"); do
      (cd "$PRIMARY" && IN="$inside" VIOL="$viol" CNT="$cnt" LOCK_WAIT=30 to 60 bash "$SKILL_ROOT/scripts/with-lock.sh" ctr bash -c "$body" \
        >/dev/null 2>>"$FX/stderr" || echo "exit $?" >>"$FX/rcs") &
      pids="$pids $!"
    done
    # shellcheck disable=SC2086
    wait $pids
  done
  eq "no contender failed" "$(cat "$FX/rcs" 2>/dev/null)" ""
  eq "critical sections never overlapped" "$(wc -l <"$viol" | tr -d ' ')" 0
  eq "no lost update" "$(cat "$cnt")" "$((rounds * n))"
}

# ── round-4 amendments (A44–A53) ────────────────────────────────────────────
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
gitdir_of() { (cd "$1" && git rev-parse --absolute-git-dir); }

t_a44_intent_ctl() {
  make_fixture
  lane new feat/a "$(printf 'a\001b\037c\177d\033e')" --no-setup
  rc_is "new" 0
  eq "C0 controls (incl. 0x1F) and DEL in intent become spaces" "$(field feat/a 4)" "a b c d e"
  check_not "no control characters anywhere in claims.tsv" sh -c "LC_ALL=C tr -d '\\t\\n' <\"\$1\" | LC_ALL=C grep -q '[[:cntrl:]]'" _ "$CLAIMS"
}

t_a44_unknown_status() {
  make_fixture
  seed_lane feat/p paused "$BASE"
  local p=$LANE_DIR
  push_lane feat/p
  lane new feat/b --no-setup
  eq "a row with an unknown status holds its port (treated as active)" "$(field feat/b 5)" "$((BASE + 1))"
  retire_refuses "unknown status is treated as active" feat/p "$p"
  landed_lane feat/q weird $((BASE + 2))
  local q=$LANE_DIR
  lane tidy --yes
  check "landed lane with an unknown status is never removed" test -d "$q"
}

t_a45_nested() {
  make_fixture
  echo "nested/" >>"$PRIMARY/.git/info/exclude"
  seed_lane feat/n "done" $((BASE + 1))
  local n=$LANE_DIR
  push_lane feat/n
  git -C "$PRIMARY" worktree add -q -b nested "$n/nested" origin/main
  echo precious >"$n/nested/work.txt"
  retire_refuses "lane contains another registered worktree" feat/n "$n"
  check "nested worktree intact" test -f "$n/nested/work.txt"
  landed_lane feat/m "done" $((BASE + 2))
  local m=$LANE_DIR
  git -C "$PRIMARY" worktree add -q -b nested2 "$m/nested" origin/main
  echo precious >"$m/nested/work.txt"
  lane tidy --yes
  check "landed lane containing a worktree kept by tidy" test -d "$m"
  check "its nested worktree intact" test -f "$m/nested/work.txt"
  out_has "reported KEEP" "KEEP[[:space:]]+${m}[[:space:]]"
}

t_a46_unresolvable() {
  make_fixture
  seed_lane feat/h "done" $((BASE + 1))
  local h=$LANE_DIR gd
  gd=$(gitdir_of "$h")
  rm -rf "$h"
  echo "ref: refs/heads/does-not-exist" >"$gd/HEAD"
  seed_lane feat/r "done" $((BASE + 2))
  local r=$LANE_DIR gr
  gr=$(gitdir_of "$r")
  rm -rf "$r"
  rm -f "$gr/logs/HEAD"; mkdir -p "$gr/logs/HEAD" # reflog unreadable
  lane tidy --yes
  check "registration with unresolvable HEAD not pruned" test -d "$gd"
  check "registration with unreadable reflog not pruned" test -d "$gr"
  out_has "unresolvable HEAD reported KEEP (unknown)" "KEEP[[:space:]]+${h}[[:space:]].*unknown"
  out_has "unreadable reflog reported KEEP (unknown)" "KEEP[[:space:]]+${r}[[:space:]].*unknown"
}

t_a47_other_branch() {
  make_fixture
  seed_lane feat/x "done" $((BASE + 1))
  local x=$LANE_DIR
  git -C "$x" checkout -q -b someone-else origin/main
  lane tidy --yes
  check "done claim does not mark a worktree on another branch finished" test -d "$x"
}

t_a47_retired_row() {
  make_fixture
  seed_lane feat/y retired $((BASE + 1))
  local y=$LANE_DIR
  commit_file "$y" y.txt y
  git -C "$y" push -q -u origin feat/y
  git -C "$y" push -q origin feat/y:main # fast-forward: tip is an ancestor of main
  lane tidy --yes
  check "a retired row never marks an existing worktree finished" test -d "$y"
}

t_a48_outside() {
  make_fixture
  git -C "$PRIMARY" worktree add -q -b out "$FX/outside-wt" origin/main
  local gd; gd=$(gitdir_of "$FX/outside-wt")
  rm -rf "$FX/outside-wt"
  lane tidy --yes
  check "missing registration outside .claude/worktrees/ not pruned" test -d "$gd"
}

t_a48_locked() {
  make_fixture
  seed_lane feat/l "done" $((BASE + 1))
  local l=$LANE_DIR gd
  gd=$(gitdir_of "$l")
  git -C "$PRIMARY" worktree lock "$l"
  rm -rf "$l"
  lane tidy --yes
  check "locked missing registration not pruned" test -d "$gd"
  out_has "reported KEEP … (locked)" "KEEP[[:space:]]+${l}[[:space:]].*locked"
  eq "claim kept" "$(nrows feat/l)" 1
}

t_a49_exit() {
  make_fixture
  seed_lane feat/a active $((BASE + 1))
  git -C "$PRIMARY" remote set-url origin "$FX/no-such-origin.git"
  lane tidy
  rc_is "tidy when the fetch fails" 1
  git -C "$PRIMARY" remote set-url origin "$ORIGIN"
  hold_lock claims
  LOCK_WAIT=2 lane tidy --yes
  rc_is "tidy --yes when the claims lock times out" 1
  drop_lock claims
}

t_a50_big_reflog() {
  make_fixture
  seed_lane feat/big "done" $((BASE + 1))
  local b=$LANE_DIR n=60000 gd t0 t1
  push_lane feat/big
  gd=$(gitdir_of "$b")
  awk -v n="$n" 'BEGIN { for (i = 1; i <= n; i++) {
      printf "commit refs/tags/bigkeep\nmark :%d\ncommitter A <a@b> %d +0000\ndata 1\nx\n", i, 1000000000 + i
      if (i > 1) printf "from :%d\n", i - 1
      printf "\n" } }' | git -C "$b" fast-import --quiet
  git -C "$b" rev-list --reverse refs/tags/bigkeep |
    awk '{ printf "0000000000000000000000000000000000000000 %s A <a@b> %d +0000\tcheckout: bulk\n", $1, 1000000000 + NR }' >>"$gd/logs/HEAD"
  eq "fixture: reflog size" "$(($(wc -l <"$gd/logs/HEAD") >= n))" 1
  t0=$(date +%s)
  LANE_TO=60 lane retire feat/big
  t1=$(date +%s)
  rc_is "retire with a ${n}-entry reflog (all reachable from a tag)" 0
  check_not "no argument-list overflow" grep -qi "argument list too long" "$ERR"
  check "retire completed in under 45 s (took $((t1 - t0)) s)" test $((t1 - t0)) -lt 45
}

t_a51_no_optional_locks() {
  make_fixture
  seed_lane feat/i "done" $((BASE + 1))
  local i=$LANE_DIR idx before
  commit_file "$i" i.txt i # unpushed, so retire refuses after looking
  idx=$(cd "$i" && git rev-parse --path-format=absolute --git-path index)
  touch -t 202001010000 "$idx"
  touch "$i/README"
  before=$(mtime "$idx")
  lane list
  lane tidy
  lane retire feat/i
  eq "worktree index not rewritten by list/tidy/retire" "$(mtime "$idx")" "$before"
  git -C "$i" status --porcelain >/dev/null
  ne "fixture check: a plain git status rewrites that index" "$(mtime "$idx")" "$before"
}

t_a52_lock_env() {
  make_fixture
  LOCK_WAIT=abc with_lock wl sh -c 'echo ran'
  rc_is "LOCK_WAIT=abc" 64
  LOCK_WAIT=5s with_lock wl sh -c 'echo ran'
  rc_is "LOCK_WAIT=5s" 64
  LOCK_NOPID_GRACE=ten with_lock wl sh -c 'echo ran'
  rc_is "LOCK_NOPID_GRACE=ten" 64
  out_lacks "command never ran" "^ran$"
}

t_a53_messages() {
  make_fixture
  seed_lane review-d "done" $((BASE + 1)) detached
  lane retire review-d
  rc_is "retire detached" 0
  any_has "says (worktree removed)" "\\(worktree removed\\)"
  check_not "detached retire does not mention a branch" sh -c "cat \"\$1\" \"\$2\" | grep -qi branch" _ "$OUT" "$ERR"
  local all="$FX/all-output"
  : >"$all"
  seed_lane feat/o "done" $((BASE + 2))
  commit_file "$LANE_DIR" o.txt o
  push_lane feat/o
  commit_file "$LANE_DIR" gone.txt gone
  git -C "$LANE_DIR" reset -q --hard HEAD~1
  lane retire feat/o
  cat "$OUT" "$ERR" >>"$all"
  any_has "override hint names the real lane" "retire --discard-unreachable feat/o"
  seed_lane feat/u "done" $((BASE + 3))
  commit_file "$LANE_DIR" u.txt u
  lane retire feat/u
  cat "$OUT" "$ERR" >>"$all"
  seed_lane feat/w active $((BASE + 4))
  lane retire feat/w
  cat "$OUT" "$ERR" >>"$all"
  check_not "no placeholder like <name>/<branch> in refusal hints ($(grep -Eo '<[A-Za-z_-]+>' "$all" | sort -u | tr '\n' ' '))" \
    grep -Eq '<(name|branch|slug|path|lane|sha|id)>' "$all"
}

run_case "new: claim row has 7 columns (name utc path intent port active branch)" t_new_row
run_case "KEPT new: tabs/newlines in intent become spaces" t_new_intent
run_case "new: lowest free port, printed in ready block, returned by port" t_new_ports
run_case "new: port of a done claim whose path exists stays taken" t_port_done_taken
run_case "new: port of a claim whose path no longer exists is free again" t_port_gone_free
run_case "new: port of a retired claim is free again" t_port_retired_free
run_case "new: v1 4-column row blocks no port and is not rewritten" t_port_v1_row
run_case "new: no free port → exit 1 naming the range, no claim" t_port_exhausted
run_case "new: skips a port currently listening (lsof)" t_port_listening
run_case "new: 5 concurrent calls → 5 rows, 5 distinct lowest ports" t_new_concurrent
run_case "new: git fetch runs under with-lock.sh git_fetch" t_new_fetch_lock
run_case "new: claim written only under the claims lock" t_new_claims_lock
run_case "new --detach: detached worktree review-<slug> at full SHA, kind detached" t_new_detach
run_case "new --detach without --base → exit 64" t_new_detach_nobase
run_case "KEPT new --setup runs in the worktree" t_new_setup_kept
run_case "port: claimed worktree → claim port (default DIR, symlinked DIR)" t_port_claimed
run_case "KEPT port: primary → LANE_PORT_DEFAULT / 5173" t_port_primary
run_case "COMPAT port: unclaimed worktree → cksum hash" t_port_unclaimed_hash
run_case "COMPAT port: v1-row worktree → cksum hash" t_port_v1_hash
run_case "release: active → done, other bytes unchanged, idempotent" t_release
run_case "release: by path" t_release_path
run_case "release: unknown lane → exit 1, nothing changed" t_release_unknown
run_case "release: v1 row already done is not rewritten" t_release_v1
run_case "retire: refuses an active lane (exit 1, says release, nothing changed)" t_retire_active
run_case "retire: refuses a tracked change" t_retire_tracked
run_case "retire: refuses an untracked file" t_retire_untracked
run_case "retire: refuses an unpushed commit" t_retire_unpushed
run_case "retire: refuses a branch that was never pushed" t_retire_never_pushed
run_case "retire: refuses when origin/<branch> moved (compares after a fetch)" t_retire_remote_moved
run_case "retire: removes worktree, status retired, branches kept" t_retire_ok
run_case "retire: by path" t_retire_by_path
run_case "retire: ignored files (node_modules) do not block" t_retire_ignored
run_case "retire: never passes --force to git worktree remove" t_retire_no_force
run_case "AMBIGUOUS retire: locked worktree → exit 1, not removed, not marked retired" t_retire_locked
run_case "retire: detached lane (released, clean) is retired" t_retire_detached
run_case "retire: refuses a dirty detached lane" t_retire_detached_dirty
run_case "retire: v1 row rewritten as 7 columns, status retired, port empty" t_retire_v1
run_case "retire: unknown lane → exit 1" t_retire_unknown
run_case "list: LIVE status= port= kind= dirty= ahead= path intent" t_list_live
run_case "list: detached lane shows kind=detached ahead=-" t_list_detached
run_case "list: GONE for missing path; v1 row is status=done kind=branch" t_list_gone_v1
run_case "tidy: active lane is KEEP (active) even when merged; not removed, branch kept" t_tidy_active
run_case "KEPT tidy --yes removes a merged, released lane" t_tidy_done_removed
run_case "A3 tidy: merge-commit-landed lane with status done is removed" t_tidy_mergecommit_done
run_case "A3 tidy: merge-commit-landed lane still active is kept" t_tidy_mergecommit_active
run_case "KEPT tidy: prunes claims with gone paths only with --yes, other rows intact" t_tidy_prune
run_case "KEPT root: prints primary from inside a lane" t_root
run_case "KEPT usage: unknown subcommand / new without branch → 64" t_usage

run_case "A5 retire: untracked file counts even with status.showUntrackedFiles=no" t_a5_untracked_hidden
run_case "A5 retire: skip-worktree file with local edits counts as dirty" t_a5_skip_worktree
run_case "A5 retire: assume-unchanged file counts as dirty (fail closed)" t_a5_assume_unchanged
run_case "A5 tidy: hidden untracked / skip-worktree lanes are KEEP, not removed" t_a5_tidy
run_case "A6 retire: refuses when HEAD reflog holds an unreachable commit, naming the count" t_a6_retire
run_case "A6 retire: detached lane with unreachable reflog commits refused, count named" t_a6_detached
run_case "A6 tidy: landed lane with an unreachable reflog commit is KEEP" t_a6_tidy
run_case "A5' retire: a file ignored only by global core.excludesFile does not block" t_a5p_global_excludes
run_case "A5' retire: skip-worktree file absent from disk does not block" t_a5p_sparse_absent
run_case "A6' retire: lists reflog-only commits + hint; --discard-unreachable proceeds" t_a6p_override
run_case "A6' retire --discard-unreachable still refuses a dirty lane" t_a6p_override_keeps_other_refusals
run_case "A6' tidy: keeps and prints the override hint" t_a6p_tidy_hint
run_case "A7 tidy --yes: locked worktree KEEP (locked), run continues, exit 0" t_a7_locked
run_case "A7 tidy --yes: failed removal KEEP (remove failed: …), run continues, exit 1" t_a7_remove_failed
run_case "A8 tidy: claimed worktree with missing directory is only GONE; claim pruned" t_a8_gone
run_case "A9 new: invalid branch names / detach slugs → 64, nothing created" t_a9_names
run_case "A10 new/port/list under a primary path with space, \$, (, ), backslash" t_a10_new
run_case "A10 release/retire/tidy by path under a path with space, \$, (, ), backslash" t_a10_lifecycle
run_case "A11 CRLF claims row read correctly (port, list, active)" t_a11_crlf
run_case "A11 6-column row with active is active" t_a11_six_col
run_case "A11 5-column row uses its port, status done" t_a11_five_col
run_case "A12 tidy --yes removes/prunes only under the claims lock" t_a12_tidy_lock
run_case "A13 with-lock: stale pid-less lock (older than grace) is reaped" t_a13_nopid_old
run_case "A13 with-lock: fresh pid-less lock is never reaped" t_a13_nopid_young
run_case "A13 with-lock: 6 contenders x 10 rounds over a planted dead-pid lock never overlap" t_a13_race

run_case "A44 claims fields: C0 controls and DEL written as spaces" t_a44_intent_ctl
run_case "A44 unknown status is treated as active (port held, retire refuses, tidy keeps)" t_a44_unknown_status
run_case "A45 lane containing another registered worktree: retire refuses, tidy keeps" t_a45_nested
run_case "A46 missing dir + unresolvable HEAD / unreadable reflog → KEEP (unknown), never pruned" t_a46_unresolvable
run_case "A47 done claim does not finish a worktree now on another branch" t_a47_other_branch
run_case "A47 retired row never marks an existing worktree finished" t_a47_retired_row
run_case "A48 tidy never prunes a missing registration outside .claude/worktrees/" t_a48_outside
run_case "A48 tidy never prunes a locked missing registration: KEEP (locked), claim kept" t_a48_locked
run_case "A49 tidy exits 1 on fetch failure and on claims-lock timeout" t_a49_exit
run_case "A50 retire handles a 60,000-entry HEAD reflog (no ARG_MAX), < 45 s" t_a50_big_reflog
run_case "A51 list/tidy/retire never rewrite a worktree index (git status --no-optional-locks)" t_a51_no_optional_locks
run_case "A52 with-lock: non-numeric LOCK_WAIT / LOCK_NOPID_GRACE → 64" t_a52_lock_env
run_case "A53 detached retire says (worktree removed), no branch; hints use real ids" t_a53_messages

summary
