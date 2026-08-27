#!/usr/bin/env bash
# After a deploy-bound merge, prove production serves the merged commit:
# /api/version reports the SHA Vercel stamped on the running build
# (VERCEL_GIT_COMMIT_SHA), and this polls until it equals origin/main. That
# subsumes the old heuristic (grace period + two consecutive good probes) —
# a matching SHA can only come from a Hono-routed handler on the new build.
# The SPA root is probed alongside it, and /api/version answering 404 is the
# catch-all blackhole that once 404'd every API route (PR #25), which is
# exactly the class of failure CI cannot see.
#
#   scripts/deploy-verify.sh [--max-minutes=8]
#
# APEX_PROD_URL overrides the origin (default: the Vercel production domain).
#
# Honest limits: origin/main is re-fetched every probe, so a merge landing
# mid-poll moves the target to the newer commit — this passes only when
# production serves what main points at right now. A skipped or failed Vercel
# build never matches and times out loudly. What it cannot judge is anything
# beyond identity and routing: a build of the right commit that misbehaves
# still passes.
set -euo pipefail

# Runnable from anywhere; the git questions below are about this repo.
cd "$(cd "$(dirname "$0")/.." && pwd -P)" || exit 1

# apextrainingcalendar.vercel.app is the project's real production alias
# (`vercel inspect` lists it). apex-training.vercel.app belongs to someone
# else's project entirely — it answers 200 HTML for every path, which the
# old grace-period probes read as healthy and the SHA check reads as a
# routing blackhole. Neither is telling us anything about OUR deploy.
url="${APEX_PROD_URL:-https://apextrainingcalendar.vercel.app}"
max_minutes=8
for arg in "$@"; do
  case "$arg" in
    --max-minutes=*) max_minutes="${arg#*=}" ;;
    *)
      echo "usage: scripts/deploy-verify.sh [--max-minutes=MINUTES]" >&2
      exit 64
      ;;
  esac
done

# node parses the JSON — a shell regex would happily "match" an error page.
# Prints nothing for an unreachable host, a non-JSON body, or a missing sha.
deployed_sha() {
  curl -s --max-time 15 "$url/api/version" 2>/dev/null \
    | node -e '
        const chunks = [];
        process.stdin.on("data", c => chunks.push(c));
        process.stdin.on("end", () => {
          try {
            const { sha } = JSON.parse(Buffer.concat(chunks).toString());
            if (typeof sha === "string") process.stdout.write(sha);
          } catch { /* not JSON — stay silent */ }
        });'
}

deadline=$(( $(date +%s) + max_minutes * 60 ))
echo "── probing $url until /api/version reports origin/main"
while :; do
  # Refetched every probe so a merge landing mid-poll retargets, not deadlocks.
  git fetch -q origin main || echo "   (fetch failed — comparing against last known origin/main)"
  want=$(git rev-parse origin/main)
  root_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url/" || echo 000)
  got=$(deployed_sha || true)
  echo "   / → $root_code   /api/version → ${got:-none}   want $want"
  if [ "$root_code" = 200 ] && [ -n "$got" ] && [ "$got" = "$want" ]; then
    echo "── production serves origin/main ($want)"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "── FAILED: $url did not serve origin/main ($want) within ${max_minutes}m" >&2
    if [ -z "$got" ]; then
      echo "   /api/version gave no SHA — a 404 there is the catch-all blackhole (PR #25), unless the serving deploy predates the route" >&2
    else
      echo "   production still reports $got — check the Vercel dashboard for a stuck or failed build" >&2
    fi
    exit 1
  fi
  sleep 15
done
