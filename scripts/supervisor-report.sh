#!/usr/bin/env bash
# Read-only supervisor sweep: everything that silently rots between sessions,
# in one report. Lines starting with "ACTION" need a human or a session;
# everything else is status. Never mutates anything — safe from anywhere.
#
#   scripts/supervisor-report.sh
#
# Covers: is main green, is the shared local stack current, what git-tidy
# would clean, which worktrees look abandoned, and where every open PR sits
# in the merge loop (scripts/merge-babysit.sh runs that loop).
set -uo pipefail

cd "$(git rev-parse --git-common-dir)/.." || exit 1

GH="${GH:-$(command -v /home/shanehaynes/bin/gh || command -v gh || true)}"

echo "── main"
if [ -n "$GH" ]; then
  latest=$("$GH" run list --workflow CI --branch main --limit 1 \
    --json conclusion,status,updatedAt,displayTitle \
    --jq '.[0] | "\(.conclusion // .status)  \(.updatedAt)  \(.displayTitle)"' 2>/dev/null || true)
  case "$latest" in
    success*) echo "   green: $latest" ;;
    "")       echo "   no CI runs found (gh auth?)" ;;
    *)        echo "ACTION main's latest CI run is not green: $latest" ;;
  esac
else
  echo "   gh not found — skipped"
fi

echo
echo "── shared local Supabase stack"
if scripts/preflight-local.sh >/dev/null 2>&1; then
  if scripts/db-types.sh --check >/dev/null 2>&1; then
    echo "   schema current: committed types match the local database"
  else
    echo "ACTION local stack lags main (db-types.sh --check fails) — a human should run: npm run db:reset-local && npm run db:types"
  fi
else
  echo "   stack not running — drift check skipped (npm run stack:fix to bring it up)"
fi

echo
echo "── merged branches and worktrees to retire (git-tidy.sh dry run)"
scripts/git-tidy.sh 2>/dev/null | sed 's/^/   /' || echo "   git-tidy.sh failed"

echo
echo "── worktree age"
for wt in .claude/worktrees/*/; do
  [ -d "$wt" ] || continue
  branch=$(git -C "$wt" branch --show-current 2>/dev/null || echo "?")
  last=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
  age_days=$(( ($(date +%s) - last) / 86400 ))
  dirty=$(git -C "$wt" status --porcelain 2>/dev/null | head -1)
  if [ "$age_days" -ge 7 ]; then
    if [ -n "$dirty" ]; then
      echo "ACTION $wt ($branch): last commit ${age_days}d ago WITH uncommitted changes — commit or finish it; never delete unseen"
    else
      echo "ACTION $wt ($branch): last commit ${age_days}d ago, clean — finish it or git-tidy after merging"
    fi
  else
    echo "   $wt ($branch): ${age_days}d${dirty:+, uncommitted changes}"
  fi
done

echo
echo "── open PRs"
if [ -n "$GH" ]; then
  prs=$("$GH" pr list --state open --limit 50 \
    --json number,title,baseRefName,mergeStateStatus \
    --jq '.[] | "   #\(.number)  \(.mergeStateStatus)\(if .baseRefName != "main" then "  BASE=\(.baseRefName)" else "" end)  \(.title)"' 2>/dev/null || true)
  if [ -z "$prs" ]; then
    echo "   none"
  else
    echo "$prs"
    echo "$prs" | grep -q "BASE=" && echo "ACTION a PR above is not based on main — the stacked-PR trap; retarget it"
    echo "$prs" | grep -qE "CLEAN|BEHIND" && echo "ACTION mergeable work is waiting — run scripts/merge-babysit.sh --yes"
  fi
else
  echo "   gh not found — skipped"
fi
