#!/usr/bin/env bash
# Prove Supabase's auth redirects still point at the PUBLIC production domain.
#
# WHY THIS EXISTS
# Every invite, password-reset and confirmation link GoTrue mails is built from
# the project's Site URL, and any `redirect_to` the app asks for is silently
# dropped unless it matches the Redirect URLs allow-list. Both live in the
# Supabase dashboard — no commit touches them, so nothing in CI can see them
# drift. They did drift: Site URL was set to
# https://apex-training-shanehaynes10.vercel.app, one of Vercel's generated
# project aliases. Those sit behind Deployment Protection (see the comment in
# scripts/deploy-verify.sh), so every invited user was handed Vercel's SSO page
# and asked to create a *Vercel* account before Apex could load. The same
# misconfiguration broke "Forgot password?" for everyone in production, because
# resetPassword() sends redirectTo: publicOrigin() and the public domain was not
# on the allow-list either.
#
#   scripts/auth-redirect-check.sh
#
# APEX_PROD_URL     overrides the expected public origin
# APEX_SUPABASE_URL overrides the Supabase project origin
#
# Read-only and unauthenticated: it needs no keys, writes nothing, and consumes
# nothing. The probe token is deliberately bogus — GoTrue answers a bad token by
# redirecting to the origin it *would* have used with `#error=otp_expired`, which
# is precisely the configuration we want to read back, and burns no real link.
#
# Exit codes: 0 configured correctly, 1 misconfigured, 2 could not reach the
# project at all (paused, offline, DNS). Callers that run unattended —
# scripts/supervisor-report.sh — must treat 2 as "skipped", not as an ACTION:
# a Supabase outage is not a configuration drift. That is also why this is not
# in CI, which has to stay hermetic.
#
# Honest limits: it reads the fallback GoTrue actually uses, not the dashboard
# fields themselves, and it can only test allow-list entries it is told to try.
set -uo pipefail

# Runnable from anywhere.
cd "$(cd "$(dirname "$0")/.." && pwd -P)" || exit 1

# Same default as scripts/deploy-verify.sh, and for the same reason: the
# vercel.app aliases are SSO-walled, so the custom domain is the only public one.
prod="${APEX_PROD_URL:-https://apextrainingcalendar.vercel.app}"
supabase="${APEX_SUPABASE_URL:-https://prmlzrkcfvmfapauoxqn.supabase.co}"

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: scripts/auth-redirect-check.sh" >&2; exit 64 ;;
  esac
done

# A shell regex would happily "match" an error page; node parses the URL.
# Prints the origin of $1, or nothing if it is not a usable absolute URL.
origin_of() {
  node -e '
    try { process.stdout.write(new URL(process.argv[1]).origin); }
    catch { /* not a URL — stay silent */ }
  ' "$1" 2>/dev/null
}

# The Location header GoTrue answers a bogus invite token with. $1, when given,
# is the redirect_to to ask for; omitted means "whatever the fallback is".
verify_location() {
  local url="$supabase/auth/v1/verify?token=deadbeefdeadbeefdeadbeefdeadbeef&type=invite"
  [ "$#" -gt 0 ] && url="$url&redirect_to=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1")"
  curl -s -o /dev/null -w '%{redirect_url}' --max-time 15 "$url" 2>/dev/null
}

failed=0
echo "── Supabase auth redirect configuration"
echo "   project:  $supabase"
echo "   expected: $prod"

# 1. Site URL — the fallback every mailed link is built from.
got=$(origin_of "$(verify_location)")
if [ -z "$got" ]; then
  # No redirect at all means we never spoke to GoTrue, so assertions 1 and 2
  # have no answer either way — report that honestly instead of guessing.
  echo "   — no redirect from $supabase: project paused, offline, or DNS. Skipped." >&2
  exit 2
fi
if [ "$got" = "$prod" ]; then
  echo "   ✓ Site URL is the public origin"
else
  echo "   ✗ Site URL is $got, not $prod" >&2
  echo "     Every invite and recovery email points there. Supabase → Authentication → URL Configuration." >&2
  failed=1
fi

# 2. Allow-list — a redirect_to that is not on it is dropped for the Site URL,
#    which is how "Forgot password?" broke without any error surfacing.
got=$(origin_of "$(verify_location "$prod")")
if [ "$got" = "$prod" ]; then
  echo "   ✓ $prod is on the Redirect URLs allow-list"
else
  echo "   ✗ redirect_to=$prod was dropped for ${got:-nothing}" >&2
  echo "     Add $prod/** to Supabase → Authentication → URL Configuration → Redirect URLs." >&2
  failed=1
fi

# 2b. The exact callback the iOS app asks for. AuthService.sendPasswordReset()
#     passes redirectTo=$prod/auth/callback, and a path that is not covered by
#     an allow-list entry is dropped the same silent way an origin is — the app
#     would show "check your email" and the link would land on the web root.
callback="$prod/auth/callback"
got=$(verify_location "$callback")
case "$got" in
  "$callback"*)
    echo "   ✓ $callback is on the Redirect URLs allow-list" ;;
  *)
    echo "   ✗ redirect_to=$callback was dropped for ${got:-nothing}" >&2
    echo "     Add $prod/** (or that exact path) to Supabase → Authentication → URL Configuration." >&2
    echo "     The iOS app's password reset and invite links depend on it (docs/ios/architecture.md §4)." >&2
    failed=1 ;;
esac

# 3. The origin those links land on must be reachable without a Vercel account.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$prod/" 2>/dev/null || echo 000)
sso=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 15 "$prod/" 2>/dev/null)
case "$sso" in
  *vercel.com/sso-api*)
    echo "   ✗ $prod is behind Vercel Deployment Protection (302 → vercel.com/sso-api)" >&2
    echo "     Invitees are asked to create a Vercel account before Apex loads." >&2
    failed=1 ;;
  *)
    if [ "$code" = 200 ]; then
      echo "   ✓ $prod serves 200 with no SSO wall"
    else
      echo "   ✗ $prod answered $code — expected 200" >&2
      failed=1
    fi ;;
esac

if [ "$failed" -ne 0 ]; then
  echo "── FAILED: auth links do not lead to the public app (see DEPLOY_MULTI_USER.md)" >&2
  exit 1
fi
echo "── auth redirects lead to $prod"
