#!/usr/bin/env bash
# Cut a new branch + worktree from current origin/main.
#
#   scripts/git-new.sh fix/stranded-event-dates
#   scripts/git-new.sh chore/docs-only --no-install    # skip npm ci
#
# Always branches from a freshly-fetched origin/main, never from whatever the
# primary checkout is sitting on, so a stale checkout cannot silently become
# the base of new work.
#
# Works from the primary checkout or from inside any worktree: it anchors on
# the primary checkout either way (the one that owns .git), so a worktree is
# never created inside another worktree.
#
# Installs dependencies unless told not to. node_modules is per-worktree, and
# a worktree without one cannot run a single check — every session that
# skipped this step has had to come back and do it. See CONTRIBUTING.md.
set -euo pipefail

branch=""
install=1
for arg in "$@"; do
  case "$arg" in
    --no-install) install=0 ;;
    -*)
      echo "error: unknown option '$arg'" >&2
      exit 64
      ;;
    *)
      if [ -n "$branch" ]; then
        echo "error: expected one branch name, got '$branch' and '$arg'" >&2
        exit 64
      fi
      branch="$arg"
      ;;
  esac
done

if [ -z "$branch" ]; then
  echo "usage: scripts/git-new.sh <type>/<slug> [--no-install]" >&2
  echo "       types: feat/ fix/ chore/ db/" >&2
  exit 64
fi

case "$branch" in
  feat/*|fix/*|chore/*|db/*) ;;
  *)
    echo "error: branch must start with feat/, fix/, chore/ or db/ — got '$branch'" >&2
    echo "       branch names say what changed, not who changed it." >&2
    exit 64
    ;;
esac

# The primary checkout is the directory that owns .git; from inside a linked
# worktree, --show-toplevel would point at the worktree instead and nest the
# new one under it.
root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
cd "$root"

if git show-ref --quiet --verify "refs/heads/$branch"; then
  echo "error: branch '$branch' already exists" >&2
  exit 1
fi

# Slashes are legal in branch names but make for awkward nested directories.
dir="$root/.claude/worktrees/${branch//\//-}"
if [ -e "$dir" ]; then
  echo "error: worktree path already exists: $dir" >&2
  exit 1
fi

echo "── fetching origin/main"
git fetch origin main --quiet

git worktree add "$dir" -b "$branch" origin/main

if [ "$install" -eq 1 ]; then
  echo "── installing dependencies (node_modules is per-worktree; --no-install skips this)"
  (cd "$dir" && npm ci --no-audit --no-fund --silent)
fi

# dev/port.mjs resolves the per-worktree dev/e2e port (CONTRIBUTING.md).
port=$(cd "$dir" && node dev/port.mjs 2>/dev/null || echo "?")

cat <<MSG

── ready
   branch:   $branch
   worktree: $dir
   dev port: $port  (npm run -s port)

   cd $dir
MSG

case "$branch" in
  db/*)
    # Migration numbers are a repo-global counter (CONTRIBUTING.md) — show the
    # claims now so the collision test never fires. Claim your N when the PR
    # opens, not when you start.
    echo
    "$root/scripts/next-phase.sh" || true
    ;;
esac
