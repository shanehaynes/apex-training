#!/usr/bin/env bash
# Run the serial update → CI → merge loop for every open PR, unattended.
#
#   scripts/merge-babysit.sh          # dry run: report what it would do
#   scripts/merge-babysit.sh --yes    # actually update and merge
#
# main requires branches to be up to date, so each merge invalidates every
# other open PR (CONTRIBUTING.md, "Merging more than one PR"). This script is
# that loop: merge whatever is green and current, update-branch the rest
# (a merge of main into the branch — never a rebase), wait for CI, repeat.
#
# It only merges PRs based on main: a PR still pointing at another branch is
# the stacked-PR trap that once merged #23 into its base and took production
# down, so those are reported and skipped, never merged.
set -euo pipefail

# Harness shells can miss ~/bin even with ~/.zshenv, so prefer the absolute
# path when it exists.
GH="${GH:-$(command -v /home/shanehaynes/bin/gh || command -v gh || true)}"
if [ -z "$GH" ]; then
  echo "error: gh not found" >&2
  exit 1
fi

apply=0
interval=60
max_minutes=90
for arg in "$@"; do
  case "$arg" in
    --yes) apply=1 ;;
    --interval=*) interval="${arg#*=}" ;;
    --max-minutes=*) max_minutes="${arg#*=}" ;;
    *)
      echo "usage: scripts/merge-babysit.sh [--yes] [--interval=SECONDS] [--max-minutes=MINUTES]" >&2
      exit 64
      ;;
  esac
done

deadline=$(( $(date +%s) + max_minutes * 60 ))
skipped=""

list_prs() {
  "$GH" pr list --state open --limit 50 \
    --json number,title,baseRefName,isDraft,mergeStateStatus \
    --jq '.[] | [.number, .baseRefName, (.isDraft|tostring), .mergeStateStatus, .title] | @tsv'
}

while :; do
  actionable=0
  merged_this_pass=0

  while IFS=$'\t' read -r number base draft state title; do
    [ -n "$number" ] || continue
    case " $skipped " in *" $number "*) continue ;; esac

    if [ "$base" != "main" ]; then
      echo "SKIP  #$number is based on '$base', not main — the stacked-PR trap. Retarget it first. ($title)"
      skipped="$skipped $number"
      continue
    fi
    if [ "$draft" = "true" ]; then
      echo "SKIP  #$number is a draft. ($title)"
      skipped="$skipped $number"
      continue
    fi

    case "$state" in
      CLEAN)
        if [ "$apply" -eq 1 ]; then
          echo "MERGE #$number ($title)"
          "$GH" pr merge "$number" --squash
          merged_this_pass=1
        else
          echo "WOULD MERGE #$number ($title)"
        fi
        actionable=1
        ;;
      BEHIND)
        if [ "$apply" -eq 1 ]; then
          echo "UPDATE #$number — merging main into the branch ($title)"
          # GitHub's "Update branch" button: a merge of base into head,
          # exactly what CONTRIBUTING.md prescribes. Never rebase here.
          "$GH" api -X PUT "repos/{owner}/{repo}/pulls/$number/update-branch" >/dev/null || {
            echo "SKIP  #$number — update-branch failed (probably conflicts with main); resolve in its worktree."
            skipped="$skipped $number"
            continue
          }
        else
          echo "WOULD UPDATE #$number ($title)"
        fi
        actionable=1
        ;;
      DIRTY)
        echo "SKIP  #$number conflicts with main — resolve in its worktree (git merge --no-edit origin/main && git push). ($title)"
        skipped="$skipped $number"
        ;;
      BLOCKED|UNSTABLE|UNKNOWN)
        # Checks still running, or GitHub hasn't computed mergeability yet.
        # A failed required check also shows as BLOCKED — surface it.
        failed=$("$GH" pr checks "$number" 2>/dev/null | grep -c $'\tfail' || true)
        if [ "${failed:-0}" -gt 0 ]; then
          echo "SKIP  #$number has $failed failing check(s) — fix before it can merge. ($title)"
          skipped="$skipped $number"
        else
          echo "WAIT  #$number: $state — CI still running. ($title)"
          actionable=1
        fi
        ;;
      *)
        echo "SKIP  #$number in unhandled state '$state'. ($title)"
        skipped="$skipped $number"
        ;;
    esac
  done <<EOF
$(list_prs)
EOF

  if [ "$actionable" -eq 0 ]; then
    echo
    echo "── done: nothing left to merge, update, or wait for."
    [ -n "$skipped" ] && echo "   needs a human/worktree: PR(s)$(echo "$skipped" | tr ' ' ',' | sed 's/,,*/ #/g')"
    break
  fi
  if [ "$apply" -eq 0 ]; then
    echo
    echo "── dry run: re-run with --yes to do the above, then keep looping until every PR lands."
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "── giving up after ${max_minutes}m — CI is slower than expected or something is wedged." >&2
    exit 1
  fi
  # After a merge GitHub recomputes every other PR's state; either way CI
  # needs real time. Poll, don't spin.
  [ "$merged_this_pass" -eq 1 ] && echo "── merged one; remaining PRs are now out of date — next pass updates them."
  sleep "$interval"
done
