#!/usr/bin/env bash
# Cut a new branch + worktree from current origin/main.
#
#   scripts/git-new.sh fix/stranded-event-dates
#
# Always branches from a freshly-fetched origin/main, never from whatever the
# primary checkout is sitting on, so a stale checkout cannot silently become
# the base of new work. See CONTRIBUTING.md.
set -euo pipefail

branch="${1:-}"
if [ -z "$branch" ]; then
  echo "usage: scripts/git-new.sh <type>/<slug>" >&2
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

root=$(git rev-parse --show-toplevel)
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

cat <<EOF

── ready
   branch:   $branch
   worktree: $dir

   cd $dir
EOF
