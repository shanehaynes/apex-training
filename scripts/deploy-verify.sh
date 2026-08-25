#!/usr/bin/env bash
# After a deploy-bound merge, prove production still routes: the SPA answers
# and /api/ is not blackholed — the vercel.json catch-all once 404'd every
# API route while the site itself looked fine (PR #25), which is exactly the
# class of failure CI cannot see.
#
#   scripts/deploy-verify.sh [--max-minutes=8]
#
# APEX_PROD_URL overrides the origin (default: the Vercel production domain).
#
# Honest limits: production exposes no commit SHA, so this verifies routing
# invariants, not that the new build is the one serving. It waits a grace
# period for the Vercel build, then requires two consecutive good probes.
# A regression that only appears after a slower build can still slip past —
# if this passes but the site misbehaves, check the Vercel dashboard.
set -euo pipefail

url="${APEX_PROD_URL:-https://apex-training.vercel.app}"
max_minutes=8
grace=90
for arg in "$@"; do
  case "$arg" in
    --max-minutes=*) max_minutes="${arg#*=}" ;;
    --no-grace) grace=0 ;;   # probing an already-settled deploy
    *)
      echo "usage: scripts/deploy-verify.sh [--max-minutes=MINUTES] [--no-grace]" >&2
      exit 64
      ;;
  esac
done

# Root must serve the SPA; any /api/ route must resolve to a handler. 401/403
# prove routing as well as 200 does — 404 and 5xx are the failures.
probe() {
  local root_code api_code
  root_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url/" || echo 000)
  api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url/api/profile" || echo 000)
  echo "   / → $root_code   /api/profile → $api_code"
  [ "$root_code" = 200 ] || return 1
  case "$api_code" in
    200|201|204|401|403|405) return 0 ;;
    *) return 1 ;;
  esac
}

[ "$grace" -gt 0 ] && echo "── waiting ${grace}s for the Vercel build" && sleep "$grace"

deadline=$(( $(date +%s) + max_minutes * 60 ))
good=0
echo "── probing $url"
while :; do
  if probe; then
    good=$((good + 1))
    [ "$good" -ge 2 ] && echo "── production routing verified (two consecutive good probes)" && exit 0
  else
    good=0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "── FAILED: $url did not pass two consecutive probes within ${max_minutes}m" >&2
    echo "   check the Vercel dashboard; if /api/ is 404, this is the catch-all blackhole (PR #25)" >&2
    exit 1
  fi
  sleep 30
done
