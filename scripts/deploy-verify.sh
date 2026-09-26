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
# Once the SHA matches, a second pass checks that the deployment is also
# CONFIGURED and that its public surface is intact — the failures that a
# matching SHA cannot rule out (issue #224):
#
#   - /api/version's health booleans: publicOrigin and keyEncryption. Both
#     variables fail soft, so a production missing them serves a working app
#     that mints per-build URLs into connectors and stores users' Anthropic
#     keys in plaintext. Nothing outside the Vercel dashboard could see that.
#   - /.well-known/apple-app-site-association, parsed as JSON. A plain 200 is
#     not enough: the SPA rewrite in vercel.json answers *every* non-/api path
#     with index.html, so a lost or mis-built AASA file 200s convincingly and
#     silently breaks universal links for the iOS app.
#   - /privacy and /terms, which the App Store listing and the clickwrap gate
#     both link to, and which are SPA routes nothing else probes.
#
#   scripts/deploy-verify.sh [--max-minutes=8]
#
# APEX_PROD_URL overrides the origin (default: the Vercel production domain).
#
# Honest limits: origin/main is re-fetched every probe, so a merge landing
# mid-poll moves the target to the newer commit — this passes only when
# production serves what main points at right now. A skipped or failed Vercel
# build never matches and times out loudly. What it cannot judge is anything
# beyond identity, configuration and routing: a build of the right commit,
# correctly configured, that misbehaves still passes.
set -euo pipefail

# Runnable from anywhere; the git questions below are about this repo.
cd "$(cd "$(dirname "$0")/.." && pwd -P)" || exit 1

# NOT apex-training.vercel.app: vercel.app names are a global namespace and
# that one belongs to a different account's project (an Expo app, also titled
# APEX) — it 200s convincingly, which fooled the pre-SHA heuristic on its
# first run. This repo's vercel.app aliases sit behind Vercel SSO (302), so
# the public custom domain is the only host that can answer /api/version.
url="${APEX_PROD_URL:-https://apex-training.app}"
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
# Prints the named field of the JSON on stdin (a string bare, anything else
# as JSON, so a boolean prints `true`/`false`), and nothing at all for a
# non-JSON body or a field that is not there.
json_field() {
  node -e '
      const chunks = [];
      process.stdin.on("data", c => chunks.push(c));
      process.stdin.on("end", () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch { return; /* not JSON — stay silent */ }
        if (body === null || typeof body !== "object") return;
        const value = body[process.argv[1]];
        if (value === undefined) return;
        process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
      });' "$1"
}

# The whole /api/version body, or nothing for an unreachable host.
version_body() {
  curl -s --max-time 15 "$url/api/version" 2>/dev/null
}

# ── the second pass: is the right build also configured, and still whole? ───
#
# Only reached once the SHA matched, so every failure here is a real one: the
# running build is this commit, so a missing health boolean means the field
# did not survive the deploy, not that the deployment is old.
check_configuration_and_surface() {
  local bad=0 flag value path code aasa

  echo
  echo "── configuration (/api/version health booleans)"
  for flag in publicOrigin keyEncryption; do
    value=$(printf '%s' "$version" | json_field "$flag" || true)
    case "$value" in
      true) echo "   ✓ $flag" ;;
      false)
        bad=1
        echo "   ✗ $flag is false" >&2
        case "$flag" in
          publicOrigin)
            echo "     VITE_PUBLIC_ORIGIN is unset (or not an http(s) URL) in the Vercel" >&2
            echo "     PRODUCTION environment, so every URL the app hands out — the OAuth" >&2
            echo "     issuer and endpoints, the MCP endpoint, the ICS feed, password-reset" >&2
            echo "     redirects — follows whichever host served the request, which for a" >&2
            echo "     deployment URL is behind Vercel's SSO wall (README, Environment" >&2
            echo "     variables)." >&2 ;;
          keyEncryption)
            echo "     API_KEY_ENCRYPTION_SECRET is unset, or shorter than 16 characters, so" >&2
            echo "     users' Anthropic API keys are being stored in the database as" >&2
            echo "     PLAINTEXT. Set it in Vercel (openssl rand -base64 32); existing rows" >&2
            echo "     re-encrypt on first read, and nothing needs a migration." >&2 ;;
        esac ;;
      *)
        bad=1
        echo "   ✗ $flag is missing from /api/version — the build serving $want should publish it" >&2 ;;
    esac
  done

  echo
  echo "── public surface"
  # The AASA is the one that a status code cannot judge: vercel.json rewrites
  # every non-/api path to index.html, so a missing file answers 200 with the
  # SPA. Parsing it is the check; `applinks` is what iOS reads.
  aasa=$(curl -s --max-time 15 "$url/.well-known/apple-app-site-association" 2>/dev/null || true)
  if [ -n "$(printf '%s' "$aasa" | json_field applinks || true)" ]; then
    echo "   ✓ /.well-known/apple-app-site-association is JSON with applinks"
  else
    bad=1
    echo "   ✗ /.well-known/apple-app-site-association did not answer JSON with an applinks key" >&2
    echo "     It is a static file in public/; a 200 here is the SPA rewrite answering with" >&2
    echo "     index.html, and universal links into the iOS app are broken until it is back." >&2
  fi

  for path in /privacy /terms; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url$path" || echo 000)
    if [ "$code" = 200 ]; then
      echo "   ✓ $path → 200"
    else
      bad=1
      echo "   ✗ $path → $code — the App Store listing and the in-app terms gate both link there" >&2
    fi
  done

  if [ "$bad" -ne 0 ]; then
    echo "── FAILED: production serves origin/main, but it is misconfigured or incomplete (above)" >&2
    return 1
  fi
  echo "── production is configured, and /privacy, /terms and the AASA are serving"
  return 0
}

deadline=$(( $(date +%s) + max_minutes * 60 ))
echo "── probing $url until /api/version reports origin/main"
while :; do
  # Refetched every probe so a merge landing mid-poll retargets, not deadlocks.
  git fetch -q origin main || echo "   (fetch failed — comparing against last known origin/main)"
  want=$(git rev-parse origin/main)
  root_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url/" || echo 000)
  version=$(version_body || true)
  got=$(printf '%s' "$version" | json_field sha || true)
  echo "   / → $root_code   /api/version → ${got:-none}   want $want"
  if [ "$root_code" = 200 ] && [ -n "$got" ] && [ "$got" = "$want" ]; then
    echo "── production serves origin/main ($want)"
    check_configuration_and_surface
    exit $?
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
