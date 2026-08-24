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

# Has everything this ref contains already landed on origin/main?
#
# Ancestry alone is not enough. The repo squash-merges (see CONTRIBUTING.md), and
# a squash rewrites the commit, so a merged branch is never an ancestor of main —
# `git merge-base --is-ancestor` reports every squash-merged branch as unmerged
# and nothing would ever be retired.
#
# So fall back to asking what the branch would actually contribute: merge it into
# main in memory and compare the resulting tree with main's. Identical means the
# branch adds nothing main does not already have, which is exactly what "merged"
# means here — and it holds however the branch landed, squash, rebase or
# cherry-pick.
#
# merge-tree --write-tree needs git 2.38+; on older git, or when the merge
# conflicts, this reports not-merged, which is the safe direction.
landed_in_main() {
  git merge-base --is-ancestor "$1" origin/main 2>/dev/null && return 0
  local merged
  merged=$(git merge-tree --write-tree origin/main "$1" 2>/dev/null) || return 1
  [ "$merged" = "$(git rev-parse origin/main^{tree})" ]
}

# Did this branch have an upstream that has since been deleted?
#
# landed_in_main answers "is this content in main" and fails safe, but it cannot
# always tell. A squash-merged branch is not an ancestor, so it falls through to
# the merge-tree check — and if main has since changed the same files, that merge
# CONFLICTS and reports not-merged. #39 and #32 both hit this: merged, then main
# moved on in git-tidy.sh and ConnectorGuide.tsx respectively, and neither branch
# could ever be retired.
#
# With delete_branch_on_merge on, GitHub removes the head branch when a PR
# merges, so a vanished upstream is good evidence the branch landed. It is only
# evidence, not proof — closing a PR without merging, or deleting the remote
# branch by hand, looks identical. So these are REPORTED, never auto-deleted:
# the one thing this script must not do is destroy work that never landed.
upstream_gone() {
  [ -n "$(git config --get "branch.$1.merge" 2>/dev/null)" ] || return 1
  ! git rev-parse --verify --quiet "$1@{upstream}" >/dev/null 2>&1
}

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

  if landed_in_main "$ref"; then
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
  elif upstream_gone "$br"; then
    echo "   REVIEW $wt"
    echo "         ($br — upstream deleted, so it probably merged, but that"
    echo "          cannot be proven from the history here. Check the PR, then:"
    echo "          git worktree remove $wt && git branch -D $br)"
    kept=$((kept + 1))
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

  if upstream_gone "$br" && ! landed_in_main "$br"; then
    echo "   REVIEW $br (upstream deleted; probably merged — check the PR,"
    echo "          then: git branch -D $br)"
    continue
  fi

  if landed_in_main "$br"; then
    echo "   DELETE $br (merged)"
    # -D not -d: -d compares against the upstream, which is often behind after
    # a squash-merge. The ancestry check above is the real gate.
    [ "$apply" -eq 1 ] && git branch -D "$br" >/dev/null
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

# ── session claims ──────────────────────────────────────────────────────────
# git-new.sh appends one claim per worktree to the primary checkout's
# .claude/state/claims.tsv; retire the ones whose worktree no longer exists.
# The claims file is metadata about work, never work itself — pruning it can
# lose nothing.
claims_root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
claims="$claims_root/.claude/state/claims.tsv"
if [ -f "$claims" ]; then
  echo
  echo "── session claims"
  kept_claims=$(mktemp)
  while IFS=$'\t' read -r br ts wt intent; do
    [ -n "$br" ] || continue
    if [ -d "$wt" ]; then
      echo "   KEEP  $br (since $ts${intent:+ — $intent})"
      printf '%s\t%s\t%s\t%s\n' "$br" "$ts" "$wt" "$intent" >> "$kept_claims"
    else
      echo "   DROP  $br (worktree gone)"
    fi
  done < "$claims"
  if [ "$apply" -eq 1 ]; then
    mv "$kept_claims" "$claims"
  else
    rm -f "$kept_claims"
  fi
fi

# ── summary ─────────────────────────────────────────────────────────────────
echo
if [ "$apply" -eq 1 ]; then
  echo "── done"
else
  echo "── dry run — nothing changed. Re-run with --yes to apply."
fi
[ "$kept" -gt 0 ] && echo "   $kept worktree(s) kept; see notes above."
exit 0
