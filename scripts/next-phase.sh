#!/usr/bin/env bash
# Report the next free supabase/migrations/phaseN number.
#
#   scripts/next-phase.sh
#
# phaseN is a repo-GLOBAL counter: db-reset-local.sh applies the directory in
# `sort -V` order, so N determines apply order across every migration that ever
# lands. Two branches can each add a phase33_*.sql, merge without a git
# conflict (different filenames), and leave two migrations claiming one slot.
#
# So the number has to be checked against every branch, local and remote, not
# just the one you are on and not just main.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "── fetching origin" >&2
git fetch origin --prune --quiet

taken=$(git for-each-ref --format='%(refname)' refs/heads refs/remotes/origin \
  | xargs -I{} git ls-tree --name-only {} supabase/migrations/ 2>/dev/null \
  | grep -oE 'phase[0-9]+' | sed 's/^phase//' | sort -nu)

if [ -z "$taken" ]; then
  echo "error: found no phaseN migrations on any branch — is this the right repo?" >&2
  exit 1
fi

highest=$(printf '%s\n' "$taken" | tail -1)
next=$((highest + 1))

echo
echo "highest claimed: phase$highest"
echo "next free:       phase$next"
echo
# Numbers already on main are settled. The ones that matter are claims still in
# flight on some other branch — those are what you can collide with.
landed=$(git ls-tree --name-only origin/main supabase/migrations/ 2>/dev/null \
  | grep -oE 'phase[0-9]+' | sed 's/^phase//' | sort -nu)

inflight=$(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin | while IFS= read -r ref; do
  git ls-tree --name-only "$ref" supabase/migrations/ 2>/dev/null \
    | grep -oE 'phase[0-9]+' | sed 's/^phase//' | sort -nu | while IFS= read -r n; do
      printf '%s\n' "$landed" | grep -qx "$n" || echo "  phase$n  $ref"
    done
done | sort -V | uniq)

if [ -n "$inflight" ]; then
  echo "claimed but NOT yet on main — collide with these and you get two"
  echo "migrations in one slot:"
  echo "$inflight"
else
  echo "no unlanded claims: every phaseN in the repo is already on main."
fi
