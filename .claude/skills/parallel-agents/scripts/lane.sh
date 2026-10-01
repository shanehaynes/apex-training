#!/usr/bin/env bash
# Lanes: one worktree + one claim + one port per parallel agent.
#
#   lane.sh new <branch> ["intent"] [--base REF] [--setup CMD | --no-setup]
#   lane.sh new --detach <slug> --base <SHA> ["intent"] [--setup CMD | --no-setup]
#   lane.sh list                 # every claim: LIVE/GONE, status, port, kind, dirty, ahead
#   lane.sh port [DIR]           # the dev port for a worktree
#   lane.sh release <name|path>  # the worker has finished: status active -> done
#   lane.sh retire [--discard-unreachable] <name|path>   # remove a released, clean, pushed lane
#   lane.sh tidy [--yes]         # remove merged lanes (dry run by default); exit 1 if a removal failed
#   lane.sh root                 # print the primary checkout
#
# Works from the primary checkout or any worktree; everything anchors on the
# primary checkout (the parent of the shared .git), so lanes never nest and
# every session sees the same claims file.
#
# Layout (git-ignore both in the project):
#   <primary>/.claude/worktrees/<branch-with-slashes-as-dashes>/   (review-<slug>/ for --detach)
#   <primary>/.claude/state/claims.tsv
#     name<TAB>utc<TAB>path<TAB>intent<TAB>port<TAB>status<TAB>kind
#     status: active (a worker is on it) | done (released) | retired (worktree removed)
#     kind:   branch | detached.  4-column v1 rows read as port=hash, done, branch;
#     5/6-column rows use the columns present (status defaults to done only
#     below 6 columns). CRLF line endings are tolerated.
#
# Ports: `new` records the lowest port in [LANE_PORT_BASE (5200),
# LANE_PORT_BASE + LANE_PORT_SPAN (800)) not held by a live active/done claim
# and not listening (lsof, when installed). Every read-modify-write of
# claims.tsv runs under `with-lock.sh claims`; `git fetch` under `git_fetch`.
#
# Removal paths fail closed: retire never passes --force, tidy never touches
# an active or locked lane, and neither deletes a branch that is not provably
# merged. "Dirty" does not depend on display settings (showUntrackedFiles);
# every ignore source (.gitignore, info/exclude, global excludesFile) is
# honoured; a skip-worktree/assume-unchanged file present on disk counts as
# dirty. A worktree whose HEAD reflog holds commits on no branch, remote
# branch or tag is kept (retire --discard-unreachable overrides, after looking).
#
# Exit codes: 0 ok, 1 refused/failed, 64 usage.
# Portable bash 3.2+ (macOS default); needs git >= 2.38 for tidy's squash check.
set -euo pipefail

die() { echo "lane: $*" >&2; exit 1; }
usage() { sed -n '2,12p' "$SELF" | sed 's/^# \{0,1\}//' >&2; exit 64; }

# Resolved once, because cmd_new and friends cd to the primary checkout.
SELF_DIR=$(cd "$(dirname "$0")" && pwd -P)
SELF="$SELF_DIR/$(basename "$0")"
US=$(printf '\037')   # field separator for normalized rows (non-whitespace: empty fields survive `read`)

# with-lock.sh is run through bash so it needs no exec bit.
with_lock() { "${BASH:-bash}" "$SELF_DIR/with-lock.sh" "$@"; }
# Re-enter this script under the claims lock (see `__locked` at the bottom).
locked() { with_lock claims "${BASH:-bash}" "$SELF" __locked "$@"; }

primary_root() {
  local common
  common=$(git rev-parse --git-common-dir 2>/dev/null) || die "not inside a git repository"
  (cd "$common/.." && pwd -P)
}

default_branch() {
  local b
  b=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  b=${b#origin/}
  if [ -z "$b" ]; then
    if git show-ref --quiet --verify refs/remotes/origin/main; then b=main
    elif git show-ref --quiet --verify refs/remotes/origin/master; then b=master
    else b=main; fi
  fi
  echo "$b"
}

# ── claims ──────────────────────────────────────────────────────────────────
claims_file() { echo "$(primary_root)/.claude/state/claims.tsv"; }

# Every claim as name US utc US path US intent US port US status US kind US
# lineno US explicit, missing columns filled with their defaults (port empty,
# status done, kind branch). explicit=1 when the row states its own status
# (6+ columns). A trailing CR is stripped; a stray US byte in a field becomes
# a space so it cannot shift the fields after it. A stated status other than
# active/done/retired reads as active: an unknown lane is never removed.
claims_rows() {
  local f=$1
  [ -f "$f" ] || return 0
  awk -F'\t' -v OFS="$US" '
    { sub(/\r$/, ""); gsub(/\037/, " ") }
    $1 == "" { next }
    NF >= 6 { st = $6; if (st != "active" && st != "done" && st != "retired") st = "active" }
    NF >= 7 { print $1, $2, $3, $4, $5, st, $7, NR, 1; next }
    NF == 6 { print $1, $2, $3, $4, $5, st, "branch", NR, 1; next }
    NF == 5 { print $1, $2, $3, $4, $5, "done", "branch", NR, 0; next }
    { print $1, $2, $3, $4, "", "done", "branch", NR, 0 }' "$f"
}

# A claims field as written: every C0 control character and DEL -> space.
clean_field() { printf '%s' "$1" | LC_ALL=C tr '\001-\037\177' ' '; }

# The latest claim for a name or path (literal, or resolved when it exists).
# Later rows win: a lane re-created at the same path supersedes the old claim.
# RESOLVED, when given, is KEY already resolved from the caller's directory.
claim_find() {
  local f=$1 key=$2 resolved=${3-}
  [ $# -ge 3 ] || { [ ! -d "$key" ] || resolved=$(cd "$key" && pwd -P); }
  # ENVIRON, not awk -v: -v would interpret backslashes in names and paths.
  claims_rows "$f" | LANE_K="$key" LANE_R="$resolved" awk -F"$US" '
    BEGIN { k = ENVIRON["LANE_K"]; r = ENVIRON["LANE_R"] }
    $1 == k || $3 == k || (r != "" && $3 == r) { last = $0 }
    END { if (last != "") print last; else exit 1 }'
}

# Rewrite one line's status, leaving every other line byte-for-byte as it was.
# A shorter row whose status changes is written out in full (7 columns).
claim_set_status() {
  local f=$1 lineno=$2 status=$3 tmp
  tmp=$(mktemp "$f.XXXXXX"); chmod 644 "$tmp"
  awk -F'\t' -v OFS='\t' -v n="$lineno" -v s="$status" '
    NR != n { print; next }
    { sub(/\r$/, ""); for (i = 1; i <= NF; i++) gsub(/[\001-\037\177]/, " ", $i) }
    NF >= 7 { $6 = s; print; next }
    NF >= 5 { print $1, $2, $3, $4, $5, s, (NF >= 7 ? $7 : "branch"); next }
    { print $1, $2, $3, $4, "", s, "branch" }' "$f" > "$tmp"
  mv "$tmp" "$f"
}

# Append one row, first ending a last line that lacks its newline.
claim_append() {
  local f=$1 row=$2
  if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf '\n' >> "$f"; fi
  printf '%s\n' "$row" >> "$f"
}

# ── removal safety ──────────────────────────────────────────────────────────
# Dirty = anything `git worktree remove` would destroy that git cannot give
# back. Untracked files are listed whatever status.showUntrackedFiles says;
# ignore rules from every source (.gitignore, info/exclude, the global
# core.excludesFile) are honoured, so ignored files never block. A file
# marked skip-worktree/assume-unchanged counts as dirty when it exists on
# disk (git would not report edits to it); sparse-checkout's absent files do
# not. Any failure to answer counts as dirty.
wt_dirty() {
  local p=$1 out entry tag file
  out=$(git --no-optional-locks -C "$p" -c status.showUntrackedFiles=normal -c core.fsmonitor=false \
    status --porcelain --untracked-files=normal --ignore-submodules=none 2>/dev/null) || return 0
  [ -z "$out" ] || return 0
  # ls-files -v: S = skip-worktree, lowercase tag = assume-unchanged. -z so
  # unusual file names arrive unquoted.
  git -C "$p" ls-files -v -z > /dev/null 2>&1 || return 0
  while IFS= read -r -d '' entry; do
    tag=${entry%% *}; file=${entry#* }
    case "$tag" in
      S|[a-z]) if [ -e "$p/$file" ] || [ -L "$p/$file" ]; then return 0; fi ;;
    esac
  done < <(git -C "$p" ls-files -v -z 2>/dev/null)
  return 1
}

# Commits in HEAD and HEAD's reflog that no branch, remote-tracking branch or
# tag reaches; removing the worktree (or pruning its registration) would make
# them unreachable. One "<sha12> <subject>" line each. Fails — "cannot tell" —
# when HEAD does not resolve or its reflog cannot be read.
# reflog_orphan_lines GIT_C_DIR HEADREF   (HEADREF: HEAD, or worktrees/<id>/HEAD)
# The commit set goes through stdin, never argv: a long reflog must not hit
# ARG_MAX. Objects already gone (expired, gc'd) are dropped first, since
# `log --stdin` has no --ignore-missing.
reflog_orphan_lines() {
  local dir=$1 head=$2 tip log logfile
  tip=$(git -C "$dir" rev-parse --verify --quiet "$head^{commit}" 2>/dev/null) || return 1
  # git reads an unreadable reflog (a directory, no permission) as an empty
  # one; that must be "cannot tell", not "nothing to lose".
  case "$head" in
    worktrees/*/HEAD) logfile="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir)/${head%/HEAD}/logs/HEAD" ;;
    *) logfile=$(git -C "$dir" rev-parse --path-format=absolute --git-path "logs/$head") || return 1 ;;
  esac
  if [ -e "$logfile" ] || [ -L "$logfile" ]; then
    [ -f "$logfile" ] && [ -r "$logfile" ] || return 1
  fi
  log=$(git -C "$dir" reflog show --format=%H "$head" -- 2>/dev/null) || return 1
  printf '%s\n%s\n' "$tip" "$log" | awk 'NF && !seen[$0]++' |
    git -C "$dir" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null |
    awk '$2 == "commit" { print $1 }' |
    git -C "$dir" log --stdin --format='%H %s' --not --branches --remotes --tags 2>/dev/null |
    awk '{ print substr($1, 1, 12) substr($0, 41) }'
}
# The count of those commits; "?" when it cannot tell.
reflog_orphans() {
  local out
  out=$(reflog_orphan_lines "$1" "$2") || { echo "?"; return; }
  if [ -z "$out" ]; then echo 0; else printf '%s\n' "$out" | wc -l | tr -d ' '; fi
}

# The id under <common>/worktrees/ of a registered worktree path (works when
# the directory itself is gone).
wt_id() {
  local path=$1 common g
  common=$(git rev-parse --path-format=absolute --git-common-dir)
  for g in "$common"/worktrees/*/gitdir; do
    [ -f "$g" ] || continue
    if [ "$(cat "$g")" = "$path/.git" ]; then basename "$(dirname "$g")"; return 0; fi
  done
  return 1
}

# Registered worktrees (other than PATH itself) anywhere under PATH, one per
# line — removing PATH would delete them. Compared raw and resolved.
nested_worktrees() {
  local path=$1 rp
  rp=$(cd "$path" 2>/dev/null && pwd -P || echo "$path")
  git worktree list --porcelain | awk '/^worktree /{ print substr($0, 10) }' |
    LANE_P="$path" LANE_RP="$rp" awk '
      BEGIN { p = ENVIRON["LANE_P"] "/"; rp = ENVIRON["LANE_RP"] "/" }
      index($0, p) == 1 || index($0, rp) == 1 { print }'
}

hash_port() {
  local sum
  sum=$(printf '%s' "$1" | cksum | awk '{print $1}')
  echo $(( ${LANE_PORT_BASE:-5200} + sum % ${LANE_PORT_SPAN:-800} ))
}

# Lowest free port. Caller holds the claims lock.
alloc_port() {
  local f=$1 base=${LANE_PORT_BASE:-5200} span=${LANE_PORT_SPAN:-800} used=" " p end
  local path port status
  while IFS="$US" read -r _ _ path _ port status _ _; do
    case "$status" in active|done) ;; *) continue ;; esac
    case "$port" in ''|*[!0-9]*) continue ;; esac
    [ -d "$path" ] && used="$used$port "
  done < <(claims_rows "$f")
  end=$(( base + span ))
  p=$base
  while [ "$p" -lt "$end" ]; do
    case "$used" in *" $p "*) p=$(( p + 1 )); continue ;; esac
    if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      p=$(( p + 1 )); continue
    fi
    echo "$p"; return 0
  done
  echo "lane: no free port in [$base, $end) — retire finished lanes or set LANE_PORT_BASE/LANE_PORT_SPAN" >&2
  return 1
}

# ── locked sections (run only via `locked`, i.e. under with-lock.sh claims) ─
# create_lane NAME KIND DIR INTENT -- <worktree-add command…>
# Port, worktree and claim happen together under the lock, so a concurrent
# `new` always sees this lane's directory and port before it allocates.
locked_create_lane() {
  local name=$1 kind=$2 dir=$3 intent=$4 f port
  shift 4; [ "${1:-}" = "--" ] && shift
  f=$(claims_file)
  mkdir -p "$(dirname "$f")"
  [ -e "$dir" ] && die "worktree path already exists: $dir"
  port=$(alloc_port "$f") || exit 1
  "$@" || die "git worktree add failed; nothing claimed"
  claim_append "$f" "$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' "$(clean_field "$name")" \
    "$(clean_field "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" "$(clean_field "$dir")" "$(clean_field "$intent")" \
    "$(clean_field "$port")" active "$(clean_field "$kind")")"
}

locked_release() {
  local key=$1 resolved=${2-} f row name status n
  f=$(claims_file)
  row=$(claim_find "$f" "$key" "$resolved") || die "unknown lane: $key"
  IFS="$US" read -r name _ _ _ _ status _ n _ <<EOF
$row
EOF
  case "$status" in
    active) claim_set_status "$f" "$n" "done"; echo "── released $name (done)" ;;
    done) echo "── $name is already done" ;;
    *) die "$name is $status; nothing to release" ;;
  esac
}

locked_retire() {
  local key=$1 resolved=${2-} discard=${3:-0} f row name path status kind n head lb rb orphans lines first
  f=$(claims_file)
  row=$(claim_find "$f" "$key" "$resolved") || die "unknown lane: $key"
  IFS="$US" read -r name _ path _ _ status kind n _ <<EOF
$row
EOF
  case "$status" in
    active) die "$name is active — a worker may still be using it; release it first (lane.sh release $name)" ;;
    retired) echo "── $name is already retired"; return 0 ;;
  esac
  [ -d "$path" ] || die "$name: worktree is gone ($path); tidy --yes prunes the claim"
  local nested
  nested=$(nested_worktrees "$path")
  [ -z "$nested" ] || die "$name: $path contains another registered worktree ($(printf '%s' "$nested" | tr '\n' ' ')); removing it would delete that worktree — move or remove it first"
  if wt_dirty "$path"; then
    die "$name has uncommitted, untracked or hidden (skip-worktree/assume-unchanged) changes in $path; commit, push or discard them first"
  fi
  head=$(git -C "$path" rev-parse --verify HEAD) || die "$name: cannot resolve HEAD in $path"
  lines=$(reflog_orphan_lines "$path" HEAD) || die "$name: cannot read HEAD's reflog in $path; nothing changed"
  if [ -n "$lines" ]; then
    orphans=$(printf '%s\n' "$lines" | wc -l | tr -d ' ')
    if [ "$discard" != 1 ]; then
      {
        echo "lane: $name: $orphans commit(s) in HEAD's reflog are on no branch, remote branch or tag; removing $path would lose them:"
        printf '%s\n' "$lines" | sed 's/^/   /'
        first=$(printf '%s\n' "$lines" | awk 'NR == 1 { print $1 }')
        echo "   keep one with, e.g.: git branch rescue-$first $first"
        echo "   or, having looked, discard them: lane.sh retire --discard-unreachable $name"
      } >&2
      exit 1
    fi
    echo "── discarding $orphans reflog-only commit(s) (--discard-unreachable):"
    printf '%s\n' "$lines" | sed 's/^/   /'
  fi
  if [ "$kind" != detached ]; then
    lb=$(git rev-parse --verify --quiet "refs/heads/$name") || die "$name: no local branch $name"
    rb=$(git rev-parse --verify --quiet "refs/remotes/origin/$name") || die "$name: origin/$name does not exist — push it first"
    [ "$lb" = "$rb" ] || die "$name: local $name ($lb) is not equal to origin/$name ($rb) — unpushed work"
    [ "$head" = "$lb" ] || die "$name: worktree HEAD ($head) is not at $name ($lb)"
  fi
  git worktree remove "$path" || die "$name: git worktree remove refused; nothing changed"
  claim_set_status "$f" "$n" retired
  if [ "$kind" = detached ]; then echo "── retired $name (worktree removed)"
  else echo "── retired $name (worktree removed; branch kept)"; fi
}

# prune_claims APPLY [KEEP]: drop rows whose path is gone (only when APPLY=1),
# except paths listed in KEEP (newline-separated): registrations tidy kept.
locked_prune_claims() {
  local apply=$1 keep=${2-} f tmp line path changed=0
  f=$(claims_file)
  [ -s "$f" ] || return 0
  tmp=$(mktemp "$f.XXXXXX"); chmod 644 "$tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    path=$(printf '%s\n' "$line" | tr -d '\r' | cut -f3)
    if [ -z "$(printf '%s' "$line" | tr -d '\r')" ] || [ -d "$path" ] ||
       { [ -n "$keep" ] && printf '%s\n' "$keep" | grep -qxF -e "$path"; }; then printf '%s\n' "$line" >> "$tmp"
    else echo "   PRUNE claim $(printf '%s\n' "$line" | tr -d '\r' | cut -f1)" >&2; changed=1; fi
  done < "$f"
  if [ "$apply" -eq 1 ] && [ "$changed" -eq 1 ]; then mv "$tmp" "$f"; else rm -f "$tmp"; fi
}

# ── port ────────────────────────────────────────────────────────────────────
# The primary checkout gets the project's default (LANE_PORT_DEFAULT, else
# 5173). A claimed worktree gets the port recorded in its claim. Anything else
# (unclaimed, or a v1 claim) hashes its directory name into
# [LANE_PORT_BASE, LANE_PORT_BASE + LANE_PORT_SPAN). Wire the project's dev
# server and test runner to read the same value, with strict-port on so a
# clash fails loudly instead of sliding.
cmd_port() {
  local dir root top row port
  dir=$(cd "${1:-.}" && pwd -P)
  root=$(cd "$dir" && primary_root)
  if [ "$dir" = "$root" ]; then echo "${LANE_PORT_DEFAULT:-5173}"; return; fi
  top=$(cd "$(cd "$dir" && git rev-parse --show-toplevel)" && pwd -P)
  if [ "$top" = "$root" ]; then echo "${LANE_PORT_DEFAULT:-5173}"; return; fi
  if row=$(claim_find "$root/.claude/state/claims.tsv" "$top"); then
    IFS="$US" read -r _ _ _ _ port _ _ _ <<EOF
$row
EOF
    case "$port" in ''|*[!0-9]*) ;; *) echo "$port"; return ;; esac
  fi
  hash_port "$(basename "$top")"
}

detect_setup() {
  local d=$1
  if [ -f "$d/.claude/lane-setup.sh" ]; then echo "bash .claude/lane-setup.sh"; return; fi
  if [ -f "$d/pnpm-lock.yaml" ]; then echo "pnpm install --frozen-lockfile"
  elif [ -f "$d/bun.lockb" ] || [ -f "$d/bun.lock" ]; then echo "bun install --frozen-lockfile"
  elif [ -f "$d/yarn.lock" ]; then
    if [ -f "$d/.yarnrc.yml" ]; then echo "yarn install --immutable"; else echo "yarn install --frozen-lockfile"; fi
  elif [ -f "$d/package-lock.json" ]; then echo "npm ci --no-audit --no-fund"
  elif [ -f "$d/uv.lock" ]; then echo "uv sync --frozen"
  elif [ -f "$d/poetry.lock" ]; then echo "poetry install --no-interaction"
  fi
}

cmd_new() {
  local branch="" intent="" base="" setup="" no_setup=0 detach=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --base) [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
      --setup) [ $# -ge 2 ] || usage; setup=$2; shift 2 ;;
      --no-setup) no_setup=1; shift ;;
      --detach) detach=1; shift ;;
      -*) usage ;;
      *) if [ -z "$branch" ]; then branch=$1; elif [ -z "$intent" ]; then intent=$1; else usage; fi; shift ;;
    esac
  done
  [ -n "$branch" ] || usage
  [ "$detach" -eq 0 ] || [ -n "$base" ] || { echo "lane: --detach needs --base <SHA>" >&2; usage; }
  # Names become paths, claim fields and ref names: validate before anything
  # is fetched, created or written.
  if [ "$detach" -eq 1 ]; then
    case "$branch" in
      *[!A-Za-z0-9._-]*) echo "lane: --detach slug must match [A-Za-z0-9._-]+: '$branch'" >&2; usage ;;
    esac
  else
    case "$branch" in
      *[[:space:]]*|*[[:cntrl:]]*) echo "lane: branch name contains whitespace or control characters" >&2; usage ;;
    esac
    case "$branch" in
      @|HEAD) echo "lane: not a valid branch name: '$branch'" >&2; usage ;;
    esac
    [ "$(git check-ref-format --branch "$branch" 2>/dev/null || true)" = "$branch" ] &&
      git check-ref-format "refs/heads/$branch" ||
      { echo "lane: not a valid branch name: '$branch'" >&2; usage; }
  fi

  local root dir state name kind sha=""
  root=$(primary_root)
  cd "$root"
  if [ "$detach" -eq 1 ]; then
    name="review-$(printf '%s' "$branch" | tr '/' '-')"; kind=detached
  else
    name=$branch; kind=branch
  fi
  dir="$root/.claude/worktrees/$(printf '%s' "$name" | tr '/' '-')"
  [ -e "$dir" ] && die "worktree path already exists: $dir"

  for p in .claude/worktrees/x .claude/state/x; do
    git check-ignore -q "$p" || echo "lane: warning — ${p%/x}/ is not git-ignored; add it to .gitignore" >&2
  done

  local def; def=$(default_branch)
  echo "── fetching origin"
  with_lock git_fetch git fetch origin --quiet || echo "lane: warning — fetch failed; basing on local refs" >&2

  if [ "$detach" -eq 1 ]; then
    sha=$(git rev-parse --verify --quiet "$base^{commit}") || die "--base $base does not name a commit"
    echo "── detached at $sha"
    locked create_lane "$name" "$kind" "$dir" "$intent" -- git worktree add --detach "$dir" "$sha" || exit 1
  else
    [ -n "$base" ] || base="origin/$def"
    if git show-ref --quiet --verify "refs/heads/$branch"; then
      # An existing branch (e.g. one a harness assigned) gets a worktree as-is.
      echo "── attaching existing branch $branch"
      locked create_lane "$name" "$kind" "$dir" "$intent" -- git worktree add "$dir" "$branch" || exit 1
    elif git show-ref --quiet --verify "refs/remotes/origin/$branch"; then
      echo "── tracking origin/$branch"
      locked create_lane "$name" "$kind" "$dir" "$intent" -- git worktree add --track -b "$branch" "$dir" "origin/$branch" || exit 1
    else
      echo "── new branch $branch from $base"
      locked create_lane "$name" "$kind" "$dir" "$intent" -- git worktree add --no-track -b "$branch" "$dir" "$base" || exit 1
    fi
  fi

  # The claim is written before setup, so a failed setup still leaves a
  # claimed (and therefore listable, releasable) lane rather than an orphan.
  if [ "$no_setup" -eq 0 ]; then
    [ -n "$setup" ] || setup=$(detect_setup "$dir")
    if [ -n "$setup" ]; then
      echo "── setup: $setup   (dependencies are per-worktree; --no-setup skips)"
      (cd "$dir" && eval "$setup")
    fi
  fi

  state="$root/.claude/state"
  local head_line
  if [ "$detach" -eq 1 ]; then head_line="   sha:      $sha"; else head_line="   branch:   $branch"; fi
  cat <<MSG

── ready
$head_line
   worktree: $dir
   port:     $(cmd_port "$dir")
   every command for this lane: cd $dir && …   (or git -C $dir …)
MSG

  local others
  others=$(LANE_ME="$name" awk -F'\t' '
    { sub(/\r$/, "") }
    $1 == "" || $1 == ENVIRON["LANE_ME"] { next }
    { st = (NF >= 6 ? $6 : "done") }
    st == "retired" { next }
    { printf "   %s [%s] (since %s)%s\n", $1, st, $2, ($4 != "" ? " — " $4 : "") }' \
    "$state/claims.tsv" 2>/dev/null || true)
  if [ -n "$others" ]; then
    echo
    echo "── other claimed lanes — check for overlap with the files this lane will touch:"
    printf '%s\n' "$others"
  fi
}

cmd_list() {
  local root claims def name path intent port status kind dirty ahead
  root=$(primary_root)
  claims="$root/.claude/state/claims.tsv"
  [ -s "$claims" ] || { echo "no claimed lanes"; return; }
  def=$(cd "$root" && default_branch)
  while IFS="$US" read -r name _ path intent port status kind _; do
    [ -n "$port" ] || port=$(hash_port "$(basename "$path")")
    if [ ! -d "$path" ]; then
      printf '%-4s %s  status=%s port=%s kind=%s dirty=- ahead=-  %s%s\n' \
        GONE "$name" "$status" "$port" "$kind" "$path" "${intent:+  — $intent}"
      continue
    fi
    dirty=$(git --no-optional-locks -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$kind" = detached ]; then ahead=-
    else ahead=$(git -C "$path" rev-list --count "origin/$def..HEAD" 2>/dev/null || echo '?'); fi
    printf '%-4s %s  status=%s port=%s kind=%s dirty=%s ahead=%s  %s%s\n' \
      LIVE "$name" "$status" "$port" "$kind" "$dirty" "$ahead" "$path" "${intent:+  — $intent}"
  done < <(claims_rows "$claims")
}

# A <name|path> argument, resolved from the caller's directory when it is one
# (cmd_* cd to the primary checkout before looking claims up).
resolve_arg() { if [ -d "$1" ]; then (cd "$1" && pwd -P); fi; }

cmd_release() {
  [ $# -eq 1 ] && [ -n "$1" ] || usage
  local resolved; resolved=$(resolve_arg "$1")
  cd "$(primary_root)"
  locked release "$1" "$resolved" || exit 1
}

cmd_retire() {
  local discard=0
  if [ "${1:-}" = --discard-unreachable ]; then discard=1; shift; fi
  if [ "${2:-}" = --discard-unreachable ] && [ $# -eq 2 ]; then discard=1; set -- "$1"; fi
  [ $# -eq 1 ] && [ -n "$1" ] || usage
  case "$1" in -*) usage ;; esac
  local root f row name status kind resolved
  resolved=$(resolve_arg "$1")
  root=$(primary_root); cd "$root"
  f="$root/.claude/state/claims.tsv"
  row=$(claim_find "$f" "$1" "$resolved") || die "unknown lane: $1"
  IFS="$US" read -r name _ _ _ _ status kind _ <<EOF
$row
EOF
  # Cheap refusal before the network; locked_retire re-checks everything.
  [ "$status" != active ] || die "$name is active — a worker may still be using it; release it first (lane.sh release $name)"
  if [ "$kind" != detached ] && [ "$status" != retired ]; then
    echo "── fetching origin"
    with_lock git_fetch git fetch origin --quiet || die "fetch failed; cannot prove $name is pushed, nothing changed"
  fi
  locked retire "$1" "$resolved" "$discard" || exit 1
}

# ── tidy ────────────────────────────────────────────────────────────────────
# Content has landed on the default branch? Ancestry catches merge commits and
# fast-forwards; a squash-merged branch is never an ancestor, so fall back to
# merging it into main in memory and comparing trees: identical = contributes
# nothing new. On conflict this says "not merged" — the safe direction.
landed() {
  git merge-base --is-ancestor "$1" "origin/$DEF" 2>/dev/null && return 0
  local t; t=$(git merge-tree --write-tree "origin/$DEF" "$1" 2>/dev/null) || return 1
  [ "$t" = "$(git rev-parse "origin/$DEF^{tree}")" ]
}
# Tip is an ancestor of main = no commits of its own. In a squash-merge repo
# that means "just started", not "finished"; never auto-remove it.
never_diverged() { git merge-base --is-ancestor "$1" "origin/$DEF" 2>/dev/null; }
# Had an upstream that is now deleted: evidence of merge (auto-delete on merge),
# not proof — a closed PR looks the same. Reported, never auto-deleted.
upstream_gone() {
  [ -n "$(git config --get "branch.$1.merge" 2>/dev/null)" ] || return 1
  ! git rev-parse --verify --quiet "$1@{upstream}" >/dev/null 2>&1
}

cmd_tidy() {
  local apply=0
  case "${1:-}" in --yes) apply=1 ;; '') ;; *) usage ;; esac
  [ $# -le 1 ] || usage
  local root; root=$(primary_root); cd "$root"
  echo "── fetching origin (prune)"
  # Exit codes are 0, 1 or 64 only: a failed fetch or a claims-lock timeout
  # is a refusal (1), whatever code git or with-lock.sh returned.
  with_lock git_fetch git fetch origin --prune --quiet || die "fetch failed; nothing changed"
  # --yes classifies and removes while holding the claims lock, re-reading the
  # claims inside it, so a concurrent `new` cannot slip a lane in between.
  if [ "$apply" -eq 1 ]; then locked tidy 1 || exit 1
  else tidy_pass 0 || exit 1; fi
}

# tidy_pass APPLY — returns 1 when any removal or deletion failed (the rest
# of the pass still runs), else 0.
tidy_pass() {
  local apply=$1 root canon freed="" failed=0 keep_claims=""
  local wt wtr locked_wt br ref claims rows active_paths active_names finished finished_names
  local id orphans why nested fin
  root=$(primary_root); cd "$root"
  DEF=$(default_branch)
  canon="$root/.claude/worktrees/"
  claims="$root/.claude/state/claims.tsv"

  # Latest claim per path/name wins. Active lanes are never removed, never
  # their branch deleted, whatever else is true. A lane is "finished" when
  # its latest claim states `done` and the worktree is still that lane (on
  # the claimed branch, or detached for a detached lane): then a tip that is
  # an ancestor of the default branch means "landed" (merge commit or
  # fast-forward), not "just started". A `retired` row never makes an
  # existing worktree finished (its worktree was removed; anything at that
  # path now is something else). Rows without their own status, unclaimed
  # and active lanes keep the v1 rule: ancestor = no commits yet.
  rows=$(claims_rows "$claims")
  active_paths=$(printf '%s\n' "$rows" | awk -F"$US" 'NF { st[$3] = $6 } END { for (p in st) if (st[p] == "active") print p }')
  active_names=$(printf '%s\n' "$rows" | awk -F"$US" 'NF && $7 == "branch" { st[$1] = $6 } END { for (b in st) if (st[b] == "active") print b }')
  # path US kind US name, for paths whose latest row is an explicit `done`.
  finished=$(printf '%s\n' "$rows" | awk -F"$US" -v OFS="$US" 'NF { st[$3] = ($9 == 1 ? $6 : "implicit"); k[$3] = $7; nm[$3] = $1 }
    END { for (p in st) if (st[p] == "done") print p, k[p], nm[p] }')
  finished_names=$(printf '%s\n' "$rows" | awk -F"$US" 'NF { st[$1] = ($9 == 1 && $7 == "branch" ? $6 : "other") }
    END { for (b in st) if (st[b] == "done" || st[b] == "retired") print b }')

  echo "── worktrees"
  while IFS="$US" read -r wt locked_wt; do
    [ -n "$wt" ] || continue
    [ "$wt" = "$root" ] && continue
    if [ ! -d "$wt" ]; then
      # Never classified by a ref: `git -C` on a missing dir would answer for
      # whatever repository encloses it. Its registration is removed only when
      # it is ours, unlocked, and provably loses no commit.
      if [ "$locked_wt" = 1 ]; then
        echo "   KEEP   $wt  (locked; directory missing)"; keep_claims="$keep_claims$wt
"; continue
      fi
      case "$wt" in
        "$canon"*) ;;
        *) echo "   KEEP   $wt  (directory missing, outside .claude/worktrees/ — perhaps moved by hand; git worktree repair can reconnect it)"
           keep_claims="$keep_claims$wt
"; continue ;;
      esac
      if ! id=$(wt_id "$wt"); then
        echo "   KEEP   $wt  (unknown — directory missing and its registration cannot be found)"; keep_claims="$keep_claims$wt
"; continue
      fi
      orphans=$(reflog_orphans "$root" "worktrees/$id/HEAD")
      if [ "$orphans" = "?" ]; then
        echo "   KEEP   $wt  (unknown — directory missing; its HEAD or reflog cannot be read, so commits only it knows cannot be ruled out)"
        keep_claims="$keep_claims$wt
"
      elif [ "$orphans" != 0 ]; then
        echo "   KEEP   $wt  (directory missing; $orphans commit(s) only in its HEAD/reflog — recover with: git branch rescue-$id worktrees/$id/HEAD)"
        keep_claims="$keep_claims$wt
"
      elif [ "$apply" -eq 0 ]; then
        echo "   GONE   $wt  (directory missing; registration removed with --yes)"
      elif why=$(git worktree remove "$wt" 2>&1); then
        echo "   GONE   $wt  (directory missing; registration removed)"
      else
        echo "   KEEP   $wt  (directory missing; remove failed: $(printf '%s' "$why" | tr '\n' ' '))"; failed=1
        keep_claims="$keep_claims$wt
"
      fi
      continue
    fi
    wtr=$(cd "$wt" 2>/dev/null && pwd -P || echo "$wt")
    if printf '%s\n' "$active_paths" | grep -qxF -e "$wt" -e "$wtr"; then
      echo "   KEEP   $wt  (active — a worker may still be using it)"; continue
    fi
    if [ "$locked_wt" = 1 ]; then
      echo "   KEEP   $wt  (locked)"; continue
    fi
    br=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
    nested=$(nested_worktrees "$wt")
    if [ -n "$nested" ]; then
      echo "   KEEP   $wt  ($br — contains another registered worktree: $(printf '%s' "$nested" | tr '\n' ' '))"; continue
    fi
    if wt_dirty "$wt"; then
      echo "   KEEP   $wt  ($br — uncommitted changes, untracked or hidden files included; may be a session's only copy)"; continue
    fi
    if [ "$br" = HEAD ]; then
      ref=$(git -C "$wt" rev-parse --verify --quiet HEAD 2>/dev/null) ||
        { echo "   KEEP   $wt  (cannot resolve HEAD)"; continue; }
    else ref=$br; fi
    # Finished only while the worktree is still the claimed lane.
    fin=$(printf '%s\n' "$finished" | LANE_W="$wt" LANE_WR="$wtr" LANE_BR="$br" awk -F"$US" '
      ($1 == ENVIRON["LANE_W"] || $1 == ENVIRON["LANE_WR"]) &&
      (($2 == "branch" && $3 == ENVIRON["LANE_BR"]) || ($2 == "detached" && ENVIRON["LANE_BR"] == "HEAD")) { print "yes"; exit }')
    if never_diverged "$ref" && [ "$fin" != yes ]; then
      echo "   KEEP   $wt  ($br — no commits yet; probably a lane that just started)"
    elif landed "$ref"; then
      case "$wt" in
        "$canon"*)
          orphans=$(reflog_orphans "$wt" HEAD)
          if [ "$orphans" != 0 ]; then
            echo "   KEEP   $wt  ($br — merged, but $orphans commit(s) in HEAD's reflog are on no branch, remote branch or tag; look, then: lane.sh retire --discard-unreachable $wt)"
          elif [ "$apply" -eq 0 ]; then
            echo "   REMOVE $wt  ($br — merged)"; freed="$freed$br
"
          elif why=$(git worktree remove "$wt" 2>&1); then
            echo "   REMOVE $wt  ($br — merged)"; freed="$freed$br
"
          else
            echo "   KEEP   $wt  ($br — remove failed: $(printf '%s' "$why" | tr '\n' ' '))"; failed=1
          fi ;;
        *) echo "   KEEP   $wt  ($br — merged, but outside .claude/worktrees/; likely another session's)" ;;
      esac
    elif [ "$br" != HEAD ] && upstream_gone "$br"; then
      echo "   REVIEW $wt  ($br — upstream deleted, probably merged; check the PR, then remove by hand)"
    else
      echo "   KEEP   $wt  ($br — $(git rev-list --count "origin/$DEF..$ref" 2>/dev/null || echo '?') commit(s) not on $DEF)"
    fi
  done < <(git worktree list --porcelain | awk -v OFS="$US" '
    /^worktree / { if (p != "") print p, l; p = substr($0, 10); l = 0; next }
    /^locked/ { l = 1 }
    END { if (p != "") print p, l }')
  # No global `git worktree prune`: it would also drop registrations kept above
  # (hand-moved worktrees, unreadable HEADs). Each removable one was removed
  # individually.

  echo "── branches"
  local checked cur; cur=$(git rev-parse --abbrev-ref HEAD)
  checked=$(git worktree list --porcelain | awk '/^branch /{sub("refs/heads/","",$2); print $2}')
  while IFS= read -r br; do
    [ -z "$br" ] || [ "$br" = "$DEF" ] || [ "$br" = "$cur" ] && continue
    if printf '%s\n' "$active_names" | grep -qxF -e "$br"; then continue; fi
    if printf '%s\n' "$checked" | grep -qxF -e "$br" && ! printf '%s' "$freed" | grep -qxF -e "$br"; then continue; fi
    if never_diverged "$br" && ! printf '%s\n' "$finished_names" | grep -qxF -e "$br"; then continue; fi
    if landed "$br"; then
      if [ "$apply" -eq 0 ]; then echo "   DELETE $br (merged)"
      elif why=$(git branch -D "$br" 2>&1); then echo "   DELETE $br (merged)"
      else echo "   KEEP   branch $br (delete failed: $(printf '%s' "$why" | tr '\n' ' '))"; failed=1; fi
    elif upstream_gone "$br"; then
      echo "   REVIEW $br (upstream deleted; check the PR, then delete by hand)"
    fi
  done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

  if [ -s "$claims" ]; then locked_prune_claims "$apply" "$keep_claims" || failed=1; fi
  [ "$apply" -eq 1 ] || echo "── dry run; re-run with --yes to apply"
  return "$failed"
}

sub=${1:-}; [ $# -gt 0 ] && shift
case "$sub" in
  new) cmd_new "$@" ;;
  list) cmd_list ;;
  port) cmd_port "$@" ;;
  release) cmd_release "$@" ;;
  retire) cmd_retire "$@" ;;
  tidy) cmd_tidy "$@" ;;
  root) primary_root ;;
  __locked)
    # Internal: the body of a claims read-modify-write, entered only through
    # `locked` so it always runs while this process tree holds the lock.
    [ "${LOCK_HELD_claims:-}" = 1 ] || die "__locked is internal; it runs only under with-lock.sh claims"
    op=${1:-}; [ $# -gt 0 ] && shift
    case "$op" in
      create_lane) locked_create_lane "$@" ;;
      release) locked_release "$@" ;;
      retire) locked_retire "$@" ;;
      prune_claims) locked_prune_claims "$@" ;;
      tidy) tidy_pass "$@" ;;
      *) die "unknown internal op: $op" ;;
    esac ;;
  *) usage ;;
esac
