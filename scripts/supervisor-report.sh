#!/usr/bin/env bash
# Read-only supervisor sweep: everything that silently rots between sessions,
# in one report. Lines starting with "ACTION" need a human or a session;
# everything else is status. Never mutates anything — safe from anywhere.
#
#   scripts/supervisor-report.sh
#
# Covers: is main green, is the shared local stack current, do production's
# auth redirects still reach the public app, what git-tidy would clean, which
# worktrees look abandoned, and where every open PR sits in the merge loop
# (scripts/merge-babysit.sh runs that loop).
set -uo pipefail

# Anchor on the checkout this script lives in (so it runs from anywhere),
# then hop to the primary checkout, which owns .claude/worktrees/.
cd "$(cd "$(dirname "$0")/.." && pwd -P)" || exit 1
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
echo "── coach model catalog"
# src/lib/coach/models.ts is hand-maintained and rots silently: a retired id
# just falls back to the default, a new release simply never reaches the
# picker. Neither surfaces in CI or a test. Always exits 0 — no key or no
# network is a skipped check, not a failure.
if [ -f scripts/check-models.mjs ]; then
  node scripts/check-models.mjs 2>/dev/null || echo "   check-models.mjs failed to run — skipped"
else
  echo "   check-models.mjs not in this checkout — skipped"
fi

echo
echo "── production auth redirects"
# Dashboard-only settings, so no commit and no CI run can see them drift. They
# did: Site URL pointed at an SSO-walled Vercel alias and every invited user was
# asked to create a Vercel account. Exit 2 is "could not reach the project",
# which is an outage, not a drift — status line, never an ACTION.
# This sweep runs from the primary checkout, which sits on main; a branch that
# has not landed yet simply has no script to run.
if [ ! -x scripts/auth-redirect-check.sh ]; then
  echo "   auth-redirect-check.sh not in this checkout — skipped"
  auth_out="" auth_code=2
else
  auth_out=$(scripts/auth-redirect-check.sh 2>&1); auth_code=$?
fi
case $auth_code in
  0) echo "   invites and resets land on the public domain" ;;
  2) [ -n "$auth_out" ] && echo "   Supabase unreachable — redirect check skipped" ;;
  *)
    echo "$auth_out" | sed 's/^/   /'
    echo "ACTION Supabase auth redirects point off the public domain — invites and password resets land on Vercel's SSO wall; fix Authentication → URL Configuration (DEPLOY_MULTI_USER.md step 1)"
    ;;
esac

echo "── production backup"
# Nightly encrypted dump + restore drill (.github/workflows/backup.yml). Red,
# or green but older than two days (schedule disabled after 60 idle days,
# project paused, secret revoked), means the last good backup is ageing —
# README, "Backups".
if [ -n "$GH" ]; then
  backup=$("$GH" run list --workflow backup.yml --branch main --limit 1 \
    --json conclusion,status,updatedAt \
    --jq '.[0] | "\(.conclusion // .status) \(.updatedAt)"' 2>/dev/null || true)
  case "$backup" in
    ""|null*) echo "   no backup runs found (gh auth? workflow not on main yet?)" ;;
    success*)
      when=${backup#success }
      when_s=$(date -d "$when" +%s 2>/dev/null || date -j -f %Y-%m-%dT%H:%M:%SZ "$when" +%s 2>/dev/null || true)
      if [ -n "$when_s" ] && [ "$when_s" -lt "$(( $(date +%s) - 2*86400 ))" ]; then
        echo "ACTION last green backup is older than two days ($when) — schedule disabled, project paused, or secret gone? (README, Backups)"
      else
        echo "   last backup dumped and restore-drilled: $when"
      fi ;;
    *) echo "ACTION nightly backup is not green: $backup — gh run list --workflow backup.yml" ;;
  esac
else
  echo "   gh not found — skipped"
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
echo "── session claims (git-new.sh records them; git-tidy.sh prunes them)"
claims=".claude/state/claims.tsv"
if [ -s "$claims" ]; then
  now=$(date +%s)
  while IFS=$'\t' read -r br ts wt intent; do
    [ -n "$br" ] || continue
    claimed=$(date -d "$ts" +%s 2>/dev/null || echo "$now")
    age_days=$(( (now - claimed) / 86400 ))
    if [ ! -d "$wt" ]; then
      echo "ACTION claim for $br points at a missing worktree — stale; scripts/git-tidy.sh --yes prunes it"
    elif [ "$age_days" -ge 7 ]; then
      echo "ACTION $br claimed ${age_days}d ago${intent:+ ($intent)} — finish it or retire it"
    else
      echo "   $br (${age_days}d${intent:+ — $intent})"
    fi
  done < "$claims"
else
  echo "   none recorded"
fi

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
    # Two open PRs can each merge cleanly into main and still conflict with
    # each other — the serial loop only finds that out after the first lands.
    if [ "$(printf '%s\n' "$prs" | wc -l)" -ge 2 ]; then
      echo
      echo "── combine check (pairwise merge-tree across open PR branches)"
      out=$(scripts/combine-check.sh 2>/dev/null) && combined=0 || combined=1
      printf '%s\n' "$out" | sed 's/^/   /'
      [ "$combined" -ne 0 ] && echo "ACTION two open PRs conflict with each other — move one hunk before the first lands (CONTRIBUTING.md)"
    fi
  fi
else
  echo "   gh not found — skipped"
fi
