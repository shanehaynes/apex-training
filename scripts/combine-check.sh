#!/usr/bin/env bash
# Prove that several in-flight branches combine — textually, and with --check
# semantically — before their PRs open. This is the recipe from
# CONTRIBUTING.md ("Several branches in flight"), scripted.
#
#   scripts/combine-check.sh                        # all open PR branches, pairwise merge-tree
#   scripts/combine-check.sh feat/a feat/b feat/c   # specific branches
#   scripts/combine-check.sh --check feat/a feat/b  # + fold into a throwaway tree and run agent:check
#
# Pairwise `git merge-tree` finds branches that each merge cleanly into main
# but conflict with each other — which the serial merge loop only discovers
# after the first PR lands. --check additionally catches semantic collisions
# (one branch tightens lint, another adds code the new rule rejects) by
# building the combined tree in a detached worktree and running the full gate.
set -euo pipefail

cd "$(git rev-parse --git-common-dir)/.." || exit 1

check=0
branches=()
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    -*)
      echo "usage: scripts/combine-check.sh [--check] [branch ...]" >&2
      exit 64
      ;;
    *) branches+=("$arg") ;;
  esac
done

echo "── fetching origin" >&2
git fetch origin --prune --quiet

if [ "${#branches[@]}" -eq 0 ]; then
  GH="${GH:-$(command -v /home/shanehaynes/bin/gh || command -v gh || true)}"
  if [ -z "$GH" ]; then
    echo "error: no branches given and gh not found to list open PRs" >&2
    exit 64
  fi
  while IFS= read -r b; do branches+=("$b"); done < <(
    "$GH" pr list --state open --base main --json headRefName --jq '.[].headRefName'
  )
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

conflicts=0
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

if [ "$conflicts" -ne 0 ]; then
  echo
  echo "Pairs conflict. Move one hunk so each side's change is off the other's"
  echo "lines — do NOT stack the PRs (CONTRIBUTING.md)."
  exit 1
fi

[ "$check" -eq 1 ] || exit 0

# Fold all branches into one throwaway commit chain and run the gate on it.
echo
echo "── all pairs merge; folding into a combined tree for agent:check"
cur=$(git rev-parse "${refs[0]}")
for ((i = 1; i < ${#refs[@]}; i++)); do
  tree=$(git merge-tree --write-tree "$cur" "${refs[i]}")
  cur=$(git commit-tree "$tree" -p "$cur" -p "$(git rev-parse "${refs[i]}")" -m "throwaway combine")
done

dir=".claude/worktrees/_combined"
if [ -e "$dir" ]; then
  echo "error: $dir already exists — another combine check running? Remove it first." >&2
  exit 1
fi
trap 'git worktree remove --force "$dir" 2>/dev/null || true' EXIT
git worktree add --detach "$dir" "$cur"
(cd "$dir" && npm ci --no-audit --no-fund --silent && npm run agent:check)
echo "── combined tree passes agent:check"
