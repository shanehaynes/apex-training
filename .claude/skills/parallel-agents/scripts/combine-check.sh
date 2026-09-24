#!/usr/bin/env bash
# Prove that several lanes combine before their PRs open.
#
#   combine-check.sh feat/a feat/b feat/c                 # pairwise textual check
#   combine-check.sh --check "npm ci && npm test" a b c   # + fold all, run the command on the fold
#   combine-check.sh --sequential --check "make test" a b  # fold in merge order only (no pairs)
#
# Branch names resolve as origin/<name> when that exists, else as given (so
# local, unpushed lanes work too). The fold starts from the latest default
# branch, so the tree tested is what main would hold after every lane lands.
#
# Pairwise `git merge-tree` finds branches that each merge cleanly into main
# but conflict with each other. The fold finds semantic collisions — one lane
# tightens a rule, another adds code it rejects — that no textual check sees.
# The fold proves exactly what the command runs and nothing else; say so.
#
# Exit: 0 all clean, 1 a conflict or a failed check, 64 usage. Needs git >= 2.38.
set -euo pipefail

check_cmd="" sequential=0 branches=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_cmd=${2:?--check needs a command}; shift 2 ;;
    --sequential) sequential=1; shift ;;
    -*) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64 ;;
    *) branches+=("$1"); shift ;;
  esac
done
[ "${#branches[@]}" -ge 1 ] || { echo "combine-check: name at least one branch" >&2; exit 64; }

root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
cd "$root"
git fetch origin --prune --quiet || echo "combine-check: warning — fetch failed; using local refs" >&2

def=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
resolve() {
  if git rev-parse --verify --quiet "origin/$1^{commit}" >/dev/null; then echo "origin/$1"
  elif git rev-parse --verify --quiet "$1^{commit}" >/dev/null; then echo "$1"
  else echo "combine-check: cannot resolve '$1'" >&2; exit 64; fi
}
refs=()
for b in "${branches[@]}"; do refs+=("$(resolve "$b")"); done

status=0
if [ "$sequential" -eq 0 ] && [ "${#refs[@]}" -ge 2 ]; then
  echo "── pairwise (${#refs[@]} branches, $(( ${#refs[@]} * (${#refs[@]} - 1) / 2 )) pairs)"
  n=${#refs[@]}
  for ((i = 0; i < n; i++)); do
    for ((j = i + 1; j < n; j++)); do
      if out=$(git merge-tree --write-tree --name-only "${refs[i]}" "${refs[j]}" 2>&1); then
        echo "   ok        ${branches[i]} × ${branches[j]}"
      else
        status=1
        echo "   CONFLICT  ${branches[i]} × ${branches[j]}"
        printf '%s\n' "$out" | sed -n '2,$p' | grep -v '^$' | sed 's/^/             /'
      fi
    done
  done
fi

if [ -n "$check_cmd" ] || [ "$sequential" -eq 1 ]; then
  echo "── fold onto $def, in order"
  cur=$(git rev-parse "$def")
  for idx in "${!refs[@]}"; do
    if ! tree=$(git merge-tree --write-tree "$cur" "${refs[idx]}" 2>/dev/null); then
      echo "   STOP      ${branches[idx]} does not fold onto the ones before it"
      exit 1
    fi
    tree=$(printf '%s\n' "$tree" | head -1)
    cur=$(git commit-tree "$tree" -p "$cur" -p "${refs[idx]}" -m "combine-check fold: ${branches[idx]}")
    echo "   folded    ${branches[idx]}"
  done
  echo "   fold = $cur"

  if [ -n "$check_cmd" ]; then
    wt="$root/.claude/worktrees/_combine-$$"
    cleanup() { git worktree remove --force "$wt" >/dev/null 2>&1 || true; git worktree prune; }
    trap cleanup EXIT
    git worktree add --detach --quiet "$wt" "$cur"
    echo "── running on the fold: $check_cmd"
    if (cd "$wt" && eval "$check_cmd"); then
      echo "── the fold passes: $check_cmd (and only that — name what it does not cover)"
    else
      echo "── the fold FAILS: the lanes are individually green but not together"
      status=1
    fi
  fi
fi

exit "$status"
