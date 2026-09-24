#!/usr/bin/env bash
# Lanes: one worktree + one branch + one claim per parallel agent.
#
#   lane.sh new <branch> ["what this lane owns"] [--base REF] [--setup CMD | --no-setup]
#   lane.sh list                 # every claimed lane: exists? dirty? commits ahead?
#   lane.sh port [DIR]           # deterministic dev port for a worktree
#   lane.sh tidy [--yes]         # retire merged lanes (dry run by default)
#   lane.sh root                 # print the primary checkout
#
# Works from the primary checkout or any worktree; everything anchors on the
# primary checkout (the parent of the shared .git), so lanes never nest and
# every session sees the same claims file.
#
# Layout (git-ignore both in the project):
#   <primary>/.claude/worktrees/<branch-with-slashes-as-dashes>/
#   <primary>/.claude/state/claims.tsv     branch<TAB>utc<TAB>path<TAB>intent
#
# Portable bash 3.2+ (macOS default); needs git >= 2.38 for tidy's squash check.
set -euo pipefail

die() { echo "lane: $*" >&2; exit 1; }
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }

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

# Deterministic per-worktree port: the primary checkout gets the project's
# default (LANE_PORT_DEFAULT, else 5173); a worktree hashes its directory name
# into [LANE_PORT_BASE, LANE_PORT_BASE + LANE_PORT_SPAN). Same answer every
# time for the same lane, different from its neighbours with high probability.
# Wire the project's dev server and test runner to read the same value, with
# strict-port on so a clash fails loudly instead of sliding.
cmd_port() {
  local dir root name sum
  dir=$(cd "${1:-.}" && pwd -P)
  root=$(cd "$dir" && primary_root)
  if [ "$dir" = "$root" ]; then echo "${LANE_PORT_DEFAULT:-5173}"; return; fi
  name=$(basename "$(cd "$dir" && git rev-parse --show-toplevel)")
  sum=$(printf '%s' "$name" | cksum | awk '{print $1}')
  echo $(( ${LANE_PORT_BASE:-5200} + sum % ${LANE_PORT_SPAN:-800} ))
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
  local branch="" intent="" base="" setup="" no_setup=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --base) base=${2:?--base needs a ref}; shift 2 ;;
      --setup) setup=${2:?--setup needs a command}; shift 2 ;;
      --no-setup) no_setup=1; shift ;;
      -*) usage ;;
      *) if [ -z "$branch" ]; then branch=$1; elif [ -z "$intent" ]; then intent=$1; else usage; fi; shift ;;
    esac
  done
  [ -n "$branch" ] || usage

  local root dir state
  root=$(primary_root)
  cd "$root"
  dir="$root/.claude/worktrees/$(printf '%s' "$branch" | tr '/' '-')"
  [ -e "$dir" ] && die "worktree path already exists: $dir"

  for p in .claude/worktrees/x .claude/state/x; do
    git check-ignore -q "$p" || echo "lane: warning — ${p%/x}/ is not git-ignored; add it to .gitignore" >&2
  done

  local def; def=$(default_branch)
  echo "── fetching origin"
  git fetch origin --quiet || echo "lane: warning — fetch failed; basing on local refs" >&2
  [ -n "$base" ] || base="origin/$def"

  if git show-ref --quiet --verify "refs/heads/$branch"; then
    # An existing branch (e.g. one a harness assigned) gets a worktree as-is.
    echo "── attaching existing branch $branch"
    git worktree add "$dir" "$branch"
  elif git show-ref --quiet --verify "refs/remotes/origin/$branch"; then
    echo "── tracking origin/$branch"
    git worktree add --track -b "$branch" "$dir" "origin/$branch"
  else
    echo "── new branch $branch from $base"
    git worktree add --no-track -b "$branch" "$dir" "$base"
  fi

  if [ "$no_setup" -eq 0 ]; then
    [ -n "$setup" ] || setup=$(detect_setup "$dir")
    if [ -n "$setup" ]; then
      echo "── setup: $setup   (dependencies are per-worktree; --no-setup skips)"
      (cd "$dir" && eval "$setup")
    fi
  fi

  state="$root/.claude/state"
  mkdir -p "$state"
  printf '%s\t%s\t%s\t%s\n' "$branch" "$(date -u +%FT%TZ)" "$dir" \
    "$(printf '%s' "$intent" | tr '\t\n' '  ')" >> "$state/claims.tsv"

  cat <<MSG

── ready
   branch:   $branch
   worktree: $dir
   port:     $(cmd_port "$dir")
   every command for this lane: cd $dir && …   (or git -C $dir …)
MSG

  local others
  others=$(awk -F'\t' -v me="$branch" '$1 != me { printf "   %s (since %s)%s\n", $1, $2, ($4 != "" ? " — " $4 : "") }' \
    "$state/claims.tsv" 2>/dev/null || true)
  if [ -n "$others" ]; then
    echo
    echo "── other claimed lanes — check for overlap with the files this lane will touch:"
    printf '%s\n' "$others"
  fi
}

cmd_list() {
  local root claims def
  root=$(primary_root)
  claims="$root/.claude/state/claims.tsv"
  [ -s "$claims" ] || { echo "no claimed lanes"; return; }
  def=$(cd "$root" && default_branch)
  while IFS="$(printf '\t')" read -r br when path intent; do
    [ -n "$br" ] || continue
    if [ ! -d "$path" ]; then
      printf 'GONE   %s  (%s)\n' "$br" "$when"; continue
    fi
    local dirty ahead
    dirty=$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    ahead=$(git -C "$path" rev-list --count "origin/$def..HEAD" 2>/dev/null || echo '?')
    printf '%-6s %s  dirty=%s ahead=%s  %s%s\n' "LIVE" "$br" "$dirty" "$ahead" "$path" "${intent:+  — $intent}"
  done < "$claims"
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
  local apply=0; [ "${1:-}" = "--yes" ] && apply=1
  local root; root=$(primary_root); cd "$root"
  echo "── fetching origin (prune)"
  git fetch origin --prune --quiet
  DEF=$(default_branch)
  local canon="$root/.claude/worktrees/" freed="" wt br ref

  echo "── worktrees"
  while IFS= read -r wt; do
    [ "$wt" = "$root" ] && continue
    br=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
    if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
      echo "   KEEP   $wt  ($br — uncommitted changes; may be a session's only copy)"; continue
    fi
    ref=$([ "$br" = HEAD ] && git -C "$wt" rev-parse HEAD || echo "$br")
    if never_diverged "$ref"; then
      echo "   KEEP   $wt  ($br — no commits yet; probably a lane that just started)"
    elif landed "$ref"; then
      case "$wt" in
        "$canon"*) echo "   REMOVE $wt  ($br — merged)"; freed="$freed$br
"; [ "$apply" -eq 1 ] && git worktree remove "$wt" ;;
        *) echo "   KEEP   $wt  ($br — merged, but outside .claude/worktrees/; likely another session's)" ;;
      esac
    elif [ "$br" != HEAD ] && upstream_gone "$br"; then
      echo "   REVIEW $wt  ($br — upstream deleted, probably merged; check the PR, then remove by hand)"
    else
      echo "   KEEP   $wt  ($br — $(git rev-list --count "origin/$DEF..$ref") commit(s) not on $DEF)"
    fi
  done < <(git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /,""); print}')
  [ "$apply" -eq 1 ] && git worktree prune

  echo "── branches"
  local checked cur; cur=$(git rev-parse --abbrev-ref HEAD)
  checked=$(git worktree list --porcelain | awk '/^branch /{sub("refs/heads/","",$2); print $2}')
  while IFS= read -r br; do
    [ -z "$br" ] || [ "$br" = "$DEF" ] || [ "$br" = "$cur" ] && continue
    if printf '%s\n' "$checked" | grep -qxF "$br" && ! printf '%s' "$freed" | grep -qxF "$br"; then continue; fi
    if never_diverged "$br"; then continue; fi
    if landed "$br"; then
      echo "   DELETE $br (merged)"
      [ "$apply" -eq 1 ] && git branch -D "$br" >/dev/null
    elif upstream_gone "$br"; then
      echo "   REVIEW $br (upstream deleted; check the PR, then delete by hand)"
    fi
  done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

  local claims="$root/.claude/state/claims.tsv"
  if [ -s "$claims" ]; then
    local tmp; tmp=$(mktemp)
    awk -F'\t' '{ cmd = "test -d \"" $3 "\""; if (system(cmd) == 0) print; else print "   PRUNE claim " $1 > "/dev/stderr" }' "$claims" > "$tmp"
    if [ "$apply" -eq 1 ] && [ "$(wc -l < "$tmp")" -ne "$(wc -l < "$claims")" ]; then cat "$tmp" > "$claims"; fi
    rm -f "$tmp"
  fi
  [ "$apply" -eq 1 ] || echo "── dry run; re-run with --yes to apply"
}

sub=${1:-}; [ $# -gt 0 ] && shift
case "$sub" in
  new) cmd_new "$@" ;;
  list) cmd_list ;;
  port) cmd_port "$@" ;;
  tidy) cmd_tidy "$@" ;;
  root) primary_root ;;
  *) usage ;;
esac
