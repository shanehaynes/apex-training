#!/usr/bin/env bash
# Run the serial update → CI → merge loop for every open PR, unattended.
#
#   scripts/merge-babysit.sh          # dry run: report what it would do
#   scripts/merge-babysit.sh --yes    # actually update and merge
#
# main requires branches to be up to date, so each merge invalidates every
# other open PR (CONTRIBUTING.md, "Merging more than one PR"). This script is
# that loop: merge whatever is green and current, update-branch the next one
# (a merge of main into the branch — never a rebase), wait for CI, repeat.
#
# Only --in-flight=N (default 1) branches are updated at a time, oldest PR
# first. Merges are serial, so updating every BEHIND PR after each merge buys
# no wall clock — the next merge puts them all behind again — and costs one
# full CI run per PR per merge: 435 runs for a fleet of 29 instead of 29, and
# hours of a saturated macOS runner pool. Raise N to hedge against the one
# updated PR going red; each extra one is a wasted CI run per merge.
#
# The deadline defaults to 10 minutes per open PR (floor 90) so a large fleet
# is not abandoned two-thirds of the way through; --max-minutes overrides.
# A transient GitHub API failure listing PRs is retried, not fatal.
#
#   scripts/merge-babysit.sh --fleet          # dry run: plan the fleet in merge order
#   scripts/merge-babysit.sh --fleet --yes    # prove the union, then merge it back to back
#
# --fleet is for when main's "require branches to be up to date" rule is OFF.
# Then a green PR is mergeable however far behind main it sits, so nothing
# forces a CI cycle per merge; what replaces the rule is a proof of the union.
# Every ready PR is folded onto origin/main in merge order (git merge-tree —
# one that will not fold is skipped, not the fleet), the folded tree runs
# agent:check in a throwaway worktree (scripts/combine-check.sh --check
# --sequential), and only then do the PRs merge, in that same order. The mode
# must match the rule and the script checks: --fleet --yes refuses while the
# rule is on, and the serial loop refuses --yes while it is off — it would
# merge every green PR back to back with no proof at all. Flipping the rule
# is a branch-protection change, so Shane's (CONTRIBUTING.md, "Fleet mode").
#
# It only merges PRs based on main: a PR still pointing at another branch is
# the stacked-PR trap that once merged #23 into its base and took production
# down, so those are reported and skipped, never merged.
#
# --yes is NOT allow-listed in .claude/settings.json today, so every run still
# prompts; a permissions.allow entry there is what would grant an unattended
# run, and that is Shane's to add. The bounds hold either way: branch
# protection means nothing red can land, and scripts/merge-policy.mjs HOLDs
# any PR touching migrations, CI,
# routing, dependencies, or the automation itself — a human grants those per
# PR with the `shipit` label. `touch .claude/AUTOMERGE_OFF` in the primary
# checkout halts every run, including one already looping. See
# CONTRIBUTING.md, "Autonomous merging".
set -euo pipefail

# Harness shells can miss ~/bin even with ~/.zshenv, so prefer the absolute
# path when it exists.
GH="${GH:-$(command -v "$HOME/bin/gh" || command -v gh || true)}"
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
max_minutes=""
in_flight=1
fleet=0
no_check=0
for arg in "$@"; do
  case "$arg" in
    --yes) apply=1 ;;
    --fleet) fleet=1 ;;
    --no-check) no_check=1 ;;
    --interval=*) interval="${arg#*=}" ;;
    --max-minutes=*) max_minutes="${arg#*=}" ;;
    --in-flight=*) in_flight="${arg#*=}" ;;
    *)
      echo "usage: scripts/merge-babysit.sh [--yes] [--fleet [--no-check]] [--interval=SECONDS] [--max-minutes=MINUTES] [--in-flight=N]" >&2
      exit 64
      ;;
  esac
done
case "$in_flight" in
  ''|*[!0-9]*|0)
    echo "error: --in-flight must be a positive integer" >&2
    exit 64
    ;;
esac

deadline=""
skipped=""
in_flight_prs=""
merged_any=0
merged_count=0
fleet_n=0
fleet_base=""

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

# Oldest PR first: gh lists newest first, and with one branch in flight at a
# time the order is the merge order, so the PR that has waited longest goes next.
list_prs() {
  "$GH" pr list --state open --limit 200 \
    --json number,title,baseRefName,isDraft,mergeStateStatus \
    --jq 'reverse | .[] | [.number, .baseRefName, (.isDraft|tostring), .mergeStateStatus, .title] | @tsv'
}

# Is this PR number in the skipped list?
is_skipped() {
  case " $skipped " in *" $1 "*) return 0 ;; esac
  return 1
}

# Fleet mode needs the head branch too; the serial loop's field layout stays.
list_fleet_prs() {
  "$GH" pr list --state open --limit 200 \
    --json number,title,baseRefName,isDraft,mergeStateStatus,headRefName \
    --jq 'reverse | .[] | [.number, .baseRefName, (.isDraft|tostring), .mergeStateStatus, .headRefName, .title] | @tsv'
}

list_prs_for_mode() {
  if [ "$fleet" -eq 1 ]; then list_fleet_prs; else list_prs; fi
}

# "true" when main requires branches to be up to date, "false" when not,
# empty when the protection could not be read — which fails closed below.
protection_strict() {
  "$GH" api "repos/{owner}/{repo}/branches/main/protection/required_status_checks" \
    --jq '.strict' 2>/dev/null || true
}

# Squash-merge one PR with the two audit records (a comment on the PR, a line
# in the local log). GitHub recomputes mergeability after every merge to
# main, and a merge that lands in that window can fail transiently, so try
# three times before giving the PR up — and never let one failure end the
# run: the post-merge lifecycle still has to happen for what did land.
merge_pr() {
  local number=$1 title=$2 mode=$3 attempt body suffix=""
  [ "$mode" = fleet ] && suffix=' [fleet]'
  echo "MERGE #$number ($title)"
  if [ "$mode" = fleet ]; then
    if [ "$no_check" -eq 1 ]; then
      body="Auto-merged by \`scripts/merge-babysit.sh --fleet --yes --no-check\`: required CI green on its own base; the union proof was skipped on the operator's word. One of $fleet_n PR(s) merged back to back onto \`$fleet_base\`."
    else
      body="Auto-merged by \`scripts/merge-babysit.sh --fleet --yes\`: required CI green on its own base, and the union of $fleet_n fleet PR(s) folded onto \`main\` at \`$fleet_base\` passed \`scripts/combine-check.sh --check --sequential\` (agent:check on the combined tree). Every changed path allowed by \`scripts/merge-policy.mjs\`."
    fi
  else
    body="Auto-merged by \`scripts/merge-babysit.sh --yes\`: required CI green, every changed path allowed by \`scripts/merge-policy.mjs\`."
  fi
  body="$body Halt future runs with \`touch .claude/AUTOMERGE_OFF\` in the primary checkout."
  "$GH" pr comment "$number" --body "$body" >/dev/null || true
  for attempt in 1 2 3; do
    if "$GH" pr merge "$number" --squash; then
      mkdir -p "$(dirname "$merge_log")"
      printf '%s merged #%s %s%s\n' "$(date -u +%FT%TZ)" "$number" "$title" "$suffix" >> "$merge_log"
      merged_this_pass=1
      merged_any=1
      merged_count=$(( merged_count + 1 ))
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      echo "   merge attempt $attempt failed; retrying in 10s"
      sleep 10
    fi
  done
  echo "SKIP  #$number — merge failed three times; see the PR page. ($title)"
  skipped="$skipped $number"
  return 1
}

# ── fleet mode ───────────────────────────────────────────────────────────────
# One pass: fold every ready PR onto origin/main in merge order, prove the
# folded tree, merge the PRs in that order. Sets actionable/merged_* like the
# serial pass does, so end_of_pass decides whether to loop.

# The contexts branch protection requires — the floor. Read once.
required_contexts=""
required_contexts_loaded=0
load_required_contexts() {
  [ "$required_contexts_loaded" -eq 1 ] && return 0
  required_contexts=$("$GH" api "repos/{owner}/{repo}/branches/main/protection/required_status_checks" \
    --jq '.contexts | join(" ")' 2>/dev/null) || return 1
  required_contexts_loaded=1
}

# Is this PR's head green where it matters? 0: every required check passed
# and no check failed outright; 1 (reason on stdout): a required check is
# red or cancelled, or a non-required job failed — advisory, but not
# something to merge past blind; 2: still pending. mergeStateStatus alone
# cannot say: UNSTABLE covers a superseded run's CANCELLED job and a failed
# preview deploy alike, and neither is what the floor is about.
required_green() {
  local rollup ctx st red
  load_required_contexts || return 2
  rollup=$("$GH" pr view "$1" --json statusCheckRollup \
    --jq '.statusCheckRollup[] | "\(.name // .context)\t\(.conclusion // .state // "")"') || return 2
  for ctx in $required_contexts; do
    st=$(printf '%s\n' "$rollup" | awk -F'\t' -v c="$ctx" '$1 == c { print $2; exit }')
    case "$st" in
      SUCCESS) ;;
      FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED) echo "$ctx=$st (required)"; return 1 ;;
      *) return 2 ;;
    esac
  done
  red=$(printf '%s\n' "$rollup" | awk -F'\t' '$2 == "FAILURE" || $2 == "ERROR" || $2 == "TIMED_OUT" { printf "%s=%s ", $1, $2 }')
  if [ -n "$red" ]; then
    echo "${red% }"
    return 1
  fi
  return 0
}

fleet_pass() {
  local number base draft state head title verdict tree head_sha base_sha cur i n before ready note reason rc
  local -a numbers=() heads=() titles=()

  git fetch -q origin --prune
  base_sha=$(git rev-parse origin/main)
  cur="$base_sha"

  while IFS=$'\t' read -r number base draft state head title; do
    [ -n "$number" ] || continue
    is_skipped "$number" && continue

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

    ready=0
    note=""
    case "$state" in
      CLEAN)
        # CLEAN can be a moment stale — a head pushed seconds ago still reads
        # CLEAN until its checks register — so read the checks regardless.
        if reason=$(required_green "$number"); then
          ready=1
        else
          rc=$?
          if [ "$rc" -eq 1 ]; then
            echo "SKIP  #$number has failing check(s): $reason ($title)"
            skipped="$skipped $number"
          else
            echo "WAIT  #$number: CI still running on its head; next pass. ($title)"
            actionable=1
          fi
          continue
        fi
        ;;
      BEHIND)
        # BEHIND only exists while the up-to-date rule is on — a dry run
        # before the flip. Plan as if the rule were off, and say so; with
        # --yes the rule is off (checked above), so BEHIND means it came back.
        if [ "$apply" -eq 1 ]; then
          echo "SKIP  #$number is BEHIND — the up-to-date rule came back on mid-run. ($title)"
          skipped="$skipped $number"
          continue
        fi
        if reason=$(required_green "$number"); then
          ready=1
          note=" — behind, checks green; ready once the up-to-date rule is off"
        else
          rc=$?
          if [ "$rc" -eq 1 ]; then
            echo "SKIP  #$number has failing check(s): $reason ($title)"
            skipped="$skipped $number"
          else
            echo "WAIT  #$number: behind, CI still running. ($title)"
            actionable=1
          fi
          continue
        fi
        ;;
      DIRTY)
        echo "SKIP  #$number conflicts with main — resolve in its worktree (git merge --no-edit origin/main && git push). ($title)"
        skipped="$skipped $number"
        continue
        ;;
      BLOCKED|UNSTABLE|UNKNOWN)
        if reason=$(required_green "$number"); then
          ready=1
          note=" — $state, but every required check passed"
        else
          rc=$?
          if [ "$rc" -eq 1 ]; then
            echo "SKIP  #$number has failing check(s): $reason ($title)"
            skipped="$skipped $number"
          else
            echo "WAIT  #$number: $state — CI still running; next pass. ($title)"
            actionable=1
          fi
          continue
        fi
        ;;
      *)
        echo "SKIP  #$number in unhandled state '$state'. ($title)"
        skipped="$skipped $number"
        continue
        ;;
    esac
    [ "$ready" -eq 1 ] || continue

    if ! verdict=$(policy_check "$number"); then
      echo "HOLD  #$number — ${verdict:-policy gave no verdict (fail closed)}"
      echo "      a human grants this one with: gh pr edit $number --add-label shipit  ($title)"
      skipped="$skipped $number"
      continue
    fi
    if ! head_sha=$(git rev-parse --quiet --verify "refs/remotes/origin/$head"); then
      echo "SKIP  #$number — origin/$head is not a branch of this repo (a fork?). ($title)"
      skipped="$skipped $number"
      continue
    fi
    if ! tree=$(git merge-tree --write-tree "$cur" "$head_sha" 2>/dev/null); then
      echo "SKIP  #$number conflicts with an earlier PR in this fleet — merge origin/main into it after they land. ($title)"
      skipped="$skipped $number"
      continue
    fi
    cur=$(git commit-tree "$tree" -p "$cur" -p "$head_sha" -m "throwaway fleet fold")
    numbers+=("$number"); heads+=("$head"); titles+=("$title")
    echo "FLEET #$number$note ($title)"
  done <<EOF
$prs
EOF

  n=${#numbers[@]}
  if [ "$n" -eq 0 ]; then
    echo "── fleet: nothing ready this pass"
    return 0
  fi
  actionable=1
  fleet_n=$n
  fleet_base=${base_sha:0:12}

  if [ "$apply" -eq 0 ]; then
    echo "WOULD PROVE the union of $n PR(s) on origin/main ${base_sha:0:7} (combine-check --check --sequential), then merge them in that order."
    return 0
  fi

  if [ "$no_check" -eq 1 ]; then
    echo "── --no-check: skipping the union proof on the operator's word"
  else
    echo "── proving the union of $n PR(s) on origin/main ${base_sha:0:7}"
    if ! scripts/combine-check.sh --check --sequential "${heads[@]}"; then
      echo "ACTION the union of this fleet fails combine-check — nothing merged. Bisect with: scripts/combine-check.sh --check --sequential <branches>" >&2
      exit 1
    fi
  fi

  # The proof was of that main and that fleet. The proof takes minutes, so
  # check the kill switch again, and if main moved meanwhile fold again
  # rather than merge onto a tree nobody proved.
  if [ -e "$kill_switch" ]; then
    echo "── kill switch: $kill_switch appeared during the proof — nothing merged." >&2
    exit 1
  fi
  git fetch -q origin main
  if [ "$(git rev-parse origin/main)" != "$base_sha" ]; then
    echo "── origin/main moved during the proof — folding again next pass"
    return 0
  fi

  before=$merged_count
  for ((i = 0; i < n; i++)); do
    merge_pr "${numbers[i]}" "${titles[i]}" fleet || true
  done
  echo "── fleet: $(( merged_count - before )) of $n merged"
}

# What every pass ends with: stop (return 1) when nothing is left or this is
# a dry run, give up past the deadline, otherwise wait for CI and loop.
end_of_pass() {
  if [ "$actionable" -eq 0 ]; then
    echo
    echo "── done: nothing left to merge, update, or wait for."
    [ -n "$skipped" ] && echo "   needs a human/worktree: PR(s)$(echo "$skipped" | tr ' ' ',' | sed 's/,,*/ #/g')"
    return 1
  fi
  if [ "$apply" -eq 0 ]; then
    echo
    if [ "$fleet" -eq 1 ]; then
      echo "── dry run: re-run with --fleet --yes to prove the union and merge it."
    else
      echo "── dry run: re-run with --yes to do the above, then keep looping until every PR lands."
    fi
    return 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "── giving up after ${max_minutes}m — CI is slower than expected or something is wedged." >&2
    exit 1
  fi
  # After a merge GitHub recomputes every other PR's state; either way CI
  # needs real time. Poll, don't spin.
  if [ "$merged_this_pass" -eq 1 ]; then
    if [ "$fleet" -eq 1 ]; then
      echo "── merged a fleet; main's CI runs once per merge. Polling for stragglers."
    else
      echo "── merged one; remaining PRs are now out of date — next pass updates them."
    fi
  fi
  sleep "$interval"
  return 0
}

# The mode must match main's up-to-date rule, or the gate is skipped by
# accident: --fleet with the rule on can merge nothing (every PR is BEHIND),
# and the serial loop with the rule off would merge every green PR back to
# back with no union proof — the exact thing fleet mode exists to prevent.
strict=$(protection_strict)
case "$strict" in
  true)
    if [ "$fleet" -eq 1 ] && [ "$apply" -eq 1 ]; then
      cat >&2 <<'MSG'
error: --fleet needs main's "require branches to be up to date" rule OFF, and it is on.
       That is a branch-protection change — the merge floor, so Shane's (CONTRIBUTING.md, "Fleet mode"):
         gh api -X PATCH repos/{owner}/{repo}/branches/main/protection/required_status_checks -F strict=false
       and back with -F strict=true afterwards. A dry run (no --yes) plans the fleet either way.
MSG
      exit 1
    fi
    ;;
  false)
    if [ "$fleet" -eq 0 ]; then
      if [ "$apply" -eq 1 ]; then
        echo "error: main's up-to-date rule is OFF, so every green PR is mergeable at once — run --fleet, which proves the union first, or turn the rule back on: gh api -X PATCH repos/{owner}/{repo}/branches/main/protection/required_status_checks -F strict=true" >&2
        exit 1
      fi
      echo "NOTE  main's up-to-date rule is off — the serial loop refuses --yes; use --fleet."
    fi
    ;;
  *)
    if [ "$apply" -eq 1 ]; then
      echo "error: could not read main's branch protection — holding (fail closed)" >&2
      exit 1
    fi
    echo "NOTE  could not read main's branch protection; --yes would refuse."
    ;;
esac

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
  # A transient API timeout must not end an unattended run that has hours
  # left: retry with backoff, and only give up when it stays down.
  attempt=0
  until prs=$(list_prs_for_mode); do
    attempt=$(( attempt + 1 ))
    if [ "$attempt" -ge 5 ]; then
      echo "error: could not list open PRs after $attempt attempts — gh auth, network, or repo access" >&2
      exit 1
    fi
    echo "── could not list open PRs (attempt $attempt); retrying in $(( attempt * 30 ))s" >&2
    sleep $(( attempt * 30 ))
  done

  # The deadline scales with the fleet: one branch in flight at a time means
  # one CI cycle per PR, and a fixed 90 minutes abandons anything above ~13.
  if [ -z "$deadline" ]; then
    if [ -z "$max_minutes" ]; then
      open_count=$(printf '%s\n' "$prs" | grep -c . || true)
      max_minutes=$(( open_count * 10 ))
      [ "$max_minutes" -lt 90 ] && max_minutes=90
      echo "── deadline: ${max_minutes}m for ${open_count} open PR(s) (--max-minutes overrides)"
    fi
    deadline=$(( $(date +%s) + max_minutes * 60 ))
  fi

  if [ "$fleet" -eq 1 ]; then
    fleet_pass
    end_of_pass || break
    continue
  fi

  # Pre-scan for the in-flight budget. A branch this run updated on an earlier
  # pass is still in flight while its CI runs (BLOCKED/UNSTABLE/UNKNOWN) and
  # counts against --in-flight; once it is CLEAN, merged, BEHIND again, or
  # skipped, it is not. Only branches *this run* updated are tracked, so a PR
  # someone else left mid-CI cannot starve the budget. And if anything is
  # CLEAN this pass, a merge is about to put every other PR behind again, so
  # updating any of them now is a wasted CI run — hold until the next pass.
  running=0
  still_in_flight=""
  clean_ahead=0
  while IFS=$'\t' read -r number base draft state title; do
    [ -n "$number" ] || continue
    is_skipped "$number" && continue
    [ "$base" = "main" ] || continue
    [ "$draft" = "true" ] && continue
    case "$state" in
      CLEAN) clean_ahead=1 ;;
      BLOCKED|UNSTABLE|UNKNOWN)
        case " $in_flight_prs " in
          *" $number "*)
            running=$(( running + 1 ))
            still_in_flight="$still_in_flight $number"
            ;;
        esac
        ;;
    esac
  done <<EOF
$prs
EOF
  in_flight_prs="$still_in_flight"
  budget=$(( in_flight - running ))
  [ "$clean_ahead" -eq 1 ] && budget=0
  updated_this_pass=0

  while IFS=$'\t' read -r number base draft state title; do
    [ -n "$number" ] || continue
    is_skipped "$number" && continue

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
          merge_pr "$number" "$title" serial || continue
        else
          echo "WOULD MERGE #$number ($title)"
        fi
        actionable=1
        ;;
      BEHIND)
        # Still something to do, whether or not this pass has budget for it.
        actionable=1
        if [ "$updated_this_pass" -ge "$budget" ]; then
          if [ "$clean_ahead" -eq 1 ]; then
            # The CLEAN PR may turn out HOLD, in which case this costs one
            # pass; if it merges, updating now would have been a wasted run.
            echo "QUEUE #$number — behind; a PR is ready to merge this pass, so updates wait for the next one. ($title)"
          else
            echo "QUEUE #$number — behind; waits for the $in_flight in flight. ($title)"
          fi
          continue
        fi
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
        updated_this_pass=$(( updated_this_pass + 1 ))
        in_flight_prs="$in_flight_prs $number"
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

  end_of_pass || break
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

# Vercel builds every push to main in turn, so a fleet of N merges is N
# production builds before the last SHA can serve: give it time in
# proportion, within reason.
dv_minutes=$(( merged_count * 3 ))
[ "$dv_minutes" -lt 8 ] && dv_minutes=8
[ "$dv_minutes" -gt 60 ] && dv_minutes=60
echo
scripts/deploy-verify.sh --max-minutes="$dv_minutes" || {
  echo "ACTION deploy verification failed — check production and the Vercel dashboard now." >&2
  exit 1
}
