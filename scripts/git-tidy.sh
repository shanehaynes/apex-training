#!/usr/bin/env bash
# Retire everything that has already landed on origin/main.
#
#   scripts/git-tidy.sh          # show what would be removed
#   scripts/git-tidy.sh --yes    # actually remove it
#
# Removes worktrees whose branch is fully merged into origin/main, deletes those
# branches, and prunes dead remote-tracking refs.
#
# Safety, in order of how much it matters:
#   - a worktree holding uncommitted changes is never touched, merged or not;
#     another session's only copy of something may be sitting in it
#   - a worktree outside .claude/worktrees/ is reported but never removed; it
#     most likely belongs to another running session, and pulling it out from
#     under that session mid-run loses whatever it has not committed
#   - a branch not fully contained in origin/main is never deleted
#   - the primary checkout and the current branch are never touched
#   - dry-run is the default
#
# See CONTRIBUTING.md.
set -euo pipefail

apply=0
[ "${1:-}" = "--yes" ] && apply=1

root=$(git rev-parse --show-toplevel)
cd "$root"

echo "── fetching origin (with prune)"
git fetch origin --prune --quiet

primary=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
current=$(git rev-parse --abbrev-ref HEAD)
canonical="$root/.claude/worktrees/"
kept=0
# Branches whose worktree is going away, so the branch loop can predict what
# apply mode will actually be able to delete instead of reporting everything as
# still checked out.
freed=""

# ── worktrees ───────────────────────────────────────────────────────────────
echo
echo "── worktrees"
while IFS= read -r wt; do
  [ "$wt" = "$primary" ] && continue

  br=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)

  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    n=$(git -C "$wt" status --porcelain | wc -l | tr -d ' ')
    echo "   KEEP  $wt"
    echo "         ($br — $n uncommitted file(s); commit or discard them first)"
    kept=$((kept + 1))
    continue
  fi

  # Detached worktrees are compared by commit; branch ones by branch tip.
  ref=$([ "$br" = HEAD ] && git -C "$wt" rev-parse HEAD || echo "$br")

  if git merge-base --is-ancestor "$ref" origin/main 2>/dev/null; then
    case "$wt" in
      "$canonical"*)
        echo "   REMOVE $wt  ($br — merged)"
        freed="$freed$br
"
        [ "$apply" -eq 1 ] && git worktree remove "$wt"
        ;;
      *)
        echo "   KEEP  $wt"
        echo "         ($br — merged, but outside .claude/worktrees/;"
        echo "          likely another session's. Remove it by hand once that"
        echo "          session is done: git worktree remove $wt)"
        kept=$((kept + 1))
        ;;
    esac
  else
    ahead=$(git rev-list --count "origin/main..$ref" 2>/dev/null || echo '?')
    echo "   KEEP  $wt"
    echo "         ($br — $ahead commit(s) not on origin/main)"
    kept=$((kept + 1))
  fi
done < <(git worktree list --porcelain | awk '/^worktree /{print $2}')

[ "$apply" -eq 1 ] && git worktree prune

# ── branches ────────────────────────────────────────────────────────────────
echo
echo "── branches"
still_checked_out=$(git worktree list --porcelain | awk '/^branch /{sub("refs/heads/","",$2); print $2}')

while IFS= read -r br; do
  [ -z "$br" ] && continue
  [ "$br" = main ] && continue
  [ "$br" = "$current" ] && continue
  # A branch checked out in a surviving worktree cannot be deleted.
  if printf '%s\n' "$still_checked_out" | grep -qx "$br" \
     && ! printf '%s\n' "$freed" | grep -qx "$br"; then
    echo "   KEEP  $br (checked out in a worktree)"
    continue
  fi

  if git merge-base --is-ancestor "$br" origin/main 2>/dev/null; then
    echo "   DELETE $br (merged)"
    # -D not -d: -d compares against the upstream, which is often behind after
    # a squash-merge. The ancestry check above is the real gate.
    [ "$apply" -eq 1 ] && git branch -D "$br" >/dev/null
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

# ── summary ─────────────────────────────────────────────────────────────────
echo
if [ "$apply" -eq 1 ]; then
  echo "── done"
else
  echo "── dry run — nothing changed. Re-run with --yes to apply."
fi
[ "$kept" -gt 0 ] && echo "   $kept worktree(s) kept; see notes above."
exit 0
