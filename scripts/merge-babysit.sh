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
#
# --yes is allow-listed in .claude/settings.json, so an unattended session may
# run it. That authority is bounded: branch protection means nothing red can
# land, and scripts/merge-policy.mjs HOLDs any PR touching migrations, CI,
# routing, dependencies, or the automation itself — a human grants those per
# PR with the `shipit` label. `touch .claude/AUTOMERGE_OFF` in the primary
# checkout halts every run, including one already looping. See
# CONTRIBUTING.md, "Autonomous merging".
set -euo pipefail

# Harness shells can miss ~/bin even with ~/.zshenv, so prefer the absolute
# path when it exists.
GH="${GH:-$(command -v /home/shanehaynes/bin/gh || command -v gh || true)}"
if [ -z "$GH" ]; then
  echo "error: gh not found" >&2
  exit 1
fi

# gh resolves *which repo* from the working directory, so anchor on the
# checkout this script lives in — the script then works from anywhere,
# including a fresh shell sitting in ~.
cd "$(cd "$(dirname "$0")/.." && pwd -P)"

# The primary checkout owns the cross-session state: the kill switch and the
# audit log live there so one file governs every worktree's runs.
primary=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
kill_switch="$primary/.claude/AUTOMERGE_OFF"
merge_log="$primary/.claude/state/merge-log"

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
merged_any=0

# Ask scripts/merge-policy.mjs whether this PR may land without a human.
# Prints the hold reason (if any); non-zero means hold. gh caps the file
# listing, so changedFiles rides along and the policy holds on a mismatch.
# Unlike the guard hooks (fail open), this fails CLOSED: no verdict, no merge.
policy_check() {
  local meta
  meta=$("$GH" pr view "$1" --json files,labels,changedFiles \
    --jq '{paths: [.files[].path], labels: [.labels[].name], changed: .changedFiles}') || {
    echo "could not read the PR's files and labels"
    return 1
  }
  printf '%s' "$meta" | node scripts/merge-policy.mjs
}

list_prs() {
  "$GH" pr list --state open --limit 50 \
    --json number,title,baseRefName,isDraft,mergeStateStatus \
    --jq '.[] | [.number, .baseRefName, (.isDraft|tostring), .mergeStateStatus, .title] | @tsv'
}

while :; do
  # Checked every pass, not once: touching the file halts a loop mid-run too.
  if [ "$apply" -eq 1 ] && [ -e "$kill_switch" ]; then
    echo "── kill switch: $kill_switch exists — no autonomous merging until it is removed." >&2
    exit 1
  fi

  actionable=0
  merged_this_pass=0

  # Assign before the loop: a failure inside `<<EOF $(list_prs) EOF` would
  # read as an empty PR list and report success while doing nothing — which
  # is exactly how this script once behaved when run outside the repo.
  if ! prs=$(list_prs); then
    echo "error: could not list open PRs — gh auth, network, or repo access" >&2
    exit 1
  fi

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
        if ! verdict=$(policy_check "$number"); then
          echo "HOLD  #$number — ${verdict:-policy gave no verdict (fail closed)}"
          echo "      a human grants this one with: gh pr edit $number --add-label shipit  ($title)"
          skipped="$skipped $number"
          continue
        fi
        if [ "$apply" -eq 1 ]; then
          echo "MERGE #$number ($title)"
          # Two audit records per merge: a comment on the PR, a line in the
          # local log. The comment is best-effort; the merge is not.
          "$GH" pr comment "$number" --body "Auto-merged by \`scripts/merge-babysit.sh --yes\`: required CI green, every changed path allowed by \`scripts/merge-policy.mjs\`. Halt future runs with \`touch .claude/AUTOMERGE_OFF\` in the primary checkout." >/dev/null || true
          "$GH" pr merge "$number" --squash
          mkdir -p "$(dirname "$merge_log")"
          printf '%s merged #%s %s\n' "$(date -u +%FT%TZ)" "$number" "$title" >> "$merge_log"
          merged_this_pass=1
          merged_any=1
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
$prs
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

# ── post-merge lifecycle ─────────────────────────────────────────────────────
# Pressing the button is not the end of a merge: merged branches need
# retiring, the primary checkout should read what main now says, and prod
# must still route — a deploy follows every merge.
[ "$apply" -eq 1 ] && [ "$merged_any" -eq 1 ] || exit 0

echo
echo "── post-merge: retiring merged branches and worktrees"
if [ "$(pwd -P)" = "$primary" ]; then
  scripts/git-tidy.sh --yes || echo "   git-tidy failed — run scripts/git-tidy.sh by hand"
else
  # git-tidy anchors on its cwd's checkout; running it from here could remove
  # the very worktree this loop is standing in.
  echo "   running from a worktree — run scripts/git-tidy.sh --yes from the primary checkout"
fi

if [ -z "$(git -C "$primary" status --porcelain)" ] \
   && [ "$(git -C "$primary" branch --show-current)" = "main" ]; then
  git -C "$primary" pull --ff-only --quiet \
    && echo "── primary checkout fast-forwarded to origin/main"
else
  echo "── primary checkout dirty or not on main — left alone"
fi

echo
scripts/deploy-verify.sh || {
  echo "ACTION deploy verification failed — check production and the Vercel dashboard now." >&2
  exit 1
}
