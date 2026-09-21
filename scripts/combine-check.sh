#!/usr/bin/env bash
# Prove that several in-flight branches combine — textually, and with --check
# semantically — before their PRs open. This is the recipe from
# CONTRIBUTING.md ("Several branches in flight"), scripted.
#
#   scripts/combine-check.sh                        # all open PR branches, pairwise merge-tree
#   scripts/combine-check.sh feat/a feat/b feat/c   # specific branches
#   scripts/combine-check.sh --check feat/a feat/b  # + fold into a throwaway tree and run agent:check
#   scripts/combine-check.sh --sequential a b c      # fold in that order instead of checking pairs
#
# Pairwise `git merge-tree` finds branches that each merge cleanly into main
# but conflict with each other — which the serial merge loop only discovers
# after the first PR lands. --check additionally catches semantic collisions
# (one branch tightens lint, another adds code the new rule rejects) by
# building the combined tree in a detached worktree and running the full gate.
#
# The fold always starts from origin/main, so the combined tree is what main
# would hold — including commits on main that none of the branches have yet.
# --sequential skips the pairwise stage and folds in the order given, which
# is what merge-babysit.sh --fleet needs: the order is the merge order, and
# the first branch that will not fold is the answer.
set -euo pipefail

# Anchor on the checkout this script lives in (so it runs from anywhere),
# then hop to the primary checkout, which owns .claude/worktrees/.
cd "$(cd "$(dirname "$0")/.." && pwd -P)" || exit 1
cd "$(git rev-parse --git-common-dir)/.." || exit 1

check=0
sequential=0
branches=()
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    --sequential) sequential=1 ;;
    -*)
      echo "usage: scripts/combine-check.sh [--check] [--sequential] [branch ...]" >&2
      exit 64
      ;;
    *) branches+=("$arg") ;;
  esac
done

echo "── fetching origin" >&2
git fetch origin --prune --quiet

if [ "${#branches[@]}" -eq 0 ]; then
  GH="${GH:-$(command -v "$HOME/bin/gh" || command -v gh || true)}"
  if [ -z "$GH" ]; then
    echo "error: no branches given and gh not found to list open PRs" >&2
    exit 64
  fi
  # gh's default --limit is 30 and it truncates silently: a 39-PR fleet was
  # once checked as 30 and reported "pairs conflict" as if it had seen them
  # all. Ask for far more than any fleet, and refuse to report if we hit it.
  pr_limit=200
  while IFS= read -r b; do branches+=("$b"); done < <(
    "$GH" pr list --state open --base main --limit "$pr_limit" --json headRefName --jq '.[].headRefName'
  )
  if [ "${#branches[@]}" -ge "$pr_limit" ]; then
    echo "error: $pr_limit open PR branches returned — the list may be truncated; raise pr_limit" >&2
    exit 1
  fi
  if [ "${#branches[@]}" -lt 2 ]; then
    echo "fewer than two open PR branches — nothing to combine."
    exit 0
  fi
  echo "checking open PR branches: ${branches[*]}"
fi

# Resolve each name to a ref, preferring the remote (what the PR will merge).
refs=()
for b in "${branches[@]}"; do
  if git rev-parse --quiet --verify "refs/remotes/origin/$b" >/dev/null; then
    refs+=("origin/$b")
  elif git rev-parse --quiet --verify "$b" >/dev/null; then
    refs+=("$b")
  else
    echo "error: no such branch '$b' (local or origin)" >&2
    exit 1
  fi
done

# Fold every branch onto origin/main in the order given. Sets $cur to the
# throwaway commit; fails at the first branch that will not fold.
fold_all() {
  local i tree
  cur=$(git rev-parse origin/main)
  for ((i = 0; i < ${#refs[@]}; i++)); do
    if ! tree=$(git merge-tree --write-tree "$cur" "${refs[i]}" 2>/dev/null); then
      echo "CONFLICT  ${refs[i]} does not fold onto origin/main + the $i branch(es) before it"
      git merge-tree --write-tree --name-only "$cur" "${refs[i]}" 2>&1 | sed -n '2,$p' | sed 's/^/          /' || true
      return 1
    fi
    cur=$(git commit-tree "$tree" -p "$cur" -p "$(git rev-parse "${refs[i]}")" -m "throwaway combine")
    echo "ok        ${refs[i]}"
  done
}

# Every pair of branches must merge with each other, not just with main.
pairwise_all() {
  local i j out conflicts=0
  for ((i = 0; i < ${#refs[@]}; i++)); do
    for ((j = i + 1; j < ${#refs[@]}; j++)); do
      if out=$(git merge-tree --write-tree --name-only "${refs[i]}" "${refs[j]}" 2>&1); then
        echo "ok        ${refs[i]} + ${refs[j]}"
      else
        conflicts=1
        echo "CONFLICT  ${refs[i]} + ${refs[j]}"
        echo "$out" | sed -n '2,$p' | sed 's/^/          /'
      fi
    done
  done
  [ "$conflicts" -eq 0 ]
}

cur=""
if [ "$sequential" -eq 1 ]; then
  fold_all || {
    echo
    echo "The fold stops at the first conflict: land the branches before it, then"
    echo "merge origin/main into that one and resolve — do NOT stack the PRs (CONTRIBUTING.md)."
    exit 1
  }
else
  pairwise_all || {
    echo
    echo "Pairs conflict. Move one hunk so each side's change is off the other's"
    echo "lines — do NOT stack the PRs (CONTRIBUTING.md)."
    exit 1
  }
fi

[ "$check" -eq 1 ] || exit 0

if [ "$sequential" -eq 0 ]; then
  # Pairwise-clean is not quite fold-clean (a third branch can be the odd one
  # out), so fold for real and let it say so.
  echo
  echo "── all pairs merge; folding onto origin/main for agent:check"
  fold_all || exit 1
fi

echo "── combined tree $(git rev-parse --short "$cur"): running agent:check in a throwaway worktree"

dir=".claude/worktrees/_combined"
if [ -e "$dir" ]; then
  echo "error: $dir already exists — another combine check running? Remove it first." >&2
  exit 1
fi
trap 'git worktree remove --force "$dir" 2>/dev/null || true' EXIT
git worktree add --detach "$dir" "$cur"
(cd "$dir" && npm ci --no-audit --no-fund --silent && npm run agent:check)
echo "── combined tree passes agent:check"
