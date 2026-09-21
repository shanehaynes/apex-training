#!/usr/bin/env bash
# Prove Supabase's auth redirects still point at the PUBLIC production domain,
# and that production still refuses new sign-ups.
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
# "Allow new users to sign up" is the same kind of field — dashboard-only, with
# nothing in the repo able to see it — and docs/ios/app-store.md rests App
# Review guideline 5.1.1 on it being off. Check 4 reads it back.
#
#   scripts/auth-redirect-check.sh
#
# APEX_PROD_URL          overrides the expected public origin
# APEX_SUPABASE_URL      overrides the Supabase project origin
# APEX_SUPABASE_ANON_KEY the anon key for check 4 (see "CREDENTIALS" there)
#
# Writes nothing and consumes nothing. Checks 1-3 need no keys at all: the
# probe token is deliberately bogus — GoTrue answers a bad token by redirecting
# to the origin it *would* have used with `#error=otp_expired`, which is
# precisely the configuration we want to read back, and burns no real link.
# Check 4 needs the anon key, the one that ships in every page load, and never
# completes a signup.
#
# Exit codes: 0 configured correctly, 1 misconfigured (redirects off the public
# domain, or sign-up open), 2 could not reach the project at all (paused,
# offline, DNS). Callers that run unattended — scripts/supervisor-report.sh —
# must treat 2 as "skipped", not as an ACTION: a Supabase outage is not a
# configuration drift. That is also why this is not in CI, which has to stay
# hermetic.
#
# Honest limits: it reads the fallback GoTrue actually uses, not the dashboard
# fields themselves; it can only test allow-list entries it is told to try; and
# with no anon key check 4 says so and is skipped rather than failing, because
# "I could not look" is not "sign-up is open".
set -uo pipefail

# Runnable from anywhere.
cd "$(cd "$(dirname "$0")/.." && pwd -P)" || exit 1

# Same default as scripts/deploy-verify.sh, and for the same reason: the
# vercel.app aliases are SSO-walled, so the custom domain is the only public one.
prod="${APEX_PROD_URL:-https://apextrainingcalendar.vercel.app}"
supabase="${APEX_SUPABASE_URL:-https://prmlzrkcfvmfapauoxqn.supabase.co}"

for arg in "$@"; do
  case "$arg" in
    # The whole header, however long it grows — a hard-coded line range goes
    # stale the first time somebody documents a new check.
    -h|--help) sed -n '2,/^set -/{/^set -/d;p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
signup_verified=1   # cleared by check 4 when it cannot look (see there)
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

# 2c. The app's own scheme. The web hands an invite or recovery landing to
#     `apextraining://auth` (D-020) and the app asks for it as redirect_to on
#     its own flows; GoTrue drops a scheme that is not allow-listed exactly as
#     silently as a path. Matched as a string prefix: `new URL().origin` is
#     "null" for a custom scheme, so origin_of cannot judge it.
app_scheme="apextraining://auth"
got=$(verify_location "$app_scheme")
case "$got" in
  "$app_scheme"*)
    echo "   ✓ $app_scheme is on the Redirect URLs allow-list" ;;
  *)
    echo "   ✗ redirect_to=$app_scheme was dropped for ${got:-nothing}" >&2
    echo "     Add $app_scheme to Supabase → Authentication → URL Configuration → Redirect URLs." >&2
    echo "     The iOS invite hand-off and in-app recovery depend on it (docs/ios/architecture.md §4)." >&2
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

# ── 4. Sign-up must be refused, and the readable auth settings pinned ────────
#
# Deliberately one self-contained block: it is the only part of this script
# that needs a key, and the nightly-CI wiring (issue #224) edits the parts
# above it.
#
# WHY: docs/ios/app-store.md tells Apple the app is invite-only and rests
# guideline 5.1.1 on it, and the only control is a dashboard toggle
# (DEPLOY_MULTI_USER.md step 1.2). Nothing in the repo can see that toggle —
# supabase/config.toml describes the *local* stack and says the opposite — and
# there is no allowlist behind it: requireUser() (api/_lib/auth.ts) accepts any
# valid JWT for the project, and handle_new_user() (phase14) provisions a
# profile for every auth.users insert. With the toggle on, anyone who reads the
# project ref and anon key out of a page load gets a fully working account.
#
# CREDENTIALS: GoTrue answers both endpoints 401 without an `apikey` header, so
# unlike the checks above this one needs the anon key — the key that ships in
# every page load, so not a secret in any useful sense.
# APEX_SUPABASE_ANON_KEY, then VITE_SUPABASE_ANON_KEY from the environment,
# then VITE_SUPABASE_ANON_KEY from .env.local (this checkout's, then the
# primary checkout's — the resolution scripts/prod-schema-check.mjs uses), and
# from .env.local only when that file's VITE_SUPABASE_URL is the project being
# probed, so a dev file pointing at the local stack cannot hand production a
# key it will only reject.

# The anon key for $supabase, or nothing. Never printed.
anon_key_for_project() {
  if [ -n "${APEX_SUPABASE_ANON_KEY:-}" ]; then printf '%s' "$APEX_SUPABASE_ANON_KEY"; return; fi
  if [ -n "${VITE_SUPABASE_ANON_KEY:-}" ]; then printf '%s' "$VITE_SUPABASE_ANON_KEY"; return; fi

  local dirs=("$PWD") gitdir primary dir url key
  # A worktree has no .env.local of its own (it is gitignored); its .git file
  # points into the primary checkout, which does.
  if [ -f .git ]; then
    gitdir=$(sed -n 's/^gitdir: *//p' .git)
    if [ -n "$gitdir" ]; then
      primary=$(cd "$gitdir/../../.." 2>/dev/null && pwd -P)
      [ -n "$primary" ] && dirs+=("$primary")
    fi
  fi
  for dir in "${dirs[@]}"; do
    [ -f "$dir/.env.local" ] || continue
    url=$(sed -n 's/^VITE_SUPABASE_URL=//p' "$dir/.env.local" | head -1 | tr -d "\"' \r")
    key=$(sed -n 's/^VITE_SUPABASE_ANON_KEY=//p' "$dir/.env.local" | head -1 | tr -d "\"' \r")
    [ -n "$key" ] && [ "$(origin_of "$url")" = "$supabase" ] || continue
    printf '%s' "$key"
    return
  done
}

# The value at dotted path $1 in the JSON on stdin, or nothing.
json_at() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v;
      try { v = JSON.parse(s); } catch { return; }
      for (const k of process.argv[1].split(".")) {
        if (v === null || typeof v !== "object") return;
        v = v[k];
      }
      if (v !== undefined && v !== null && typeof v !== "object") process.stdout.write(String(v));
    });
  ' "$1" 2>/dev/null
}

# The external providers GoTrue reports as enabled, sorted and space separated.
enabled_providers() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v;
      try { v = JSON.parse(s).external; } catch { return; }
      if (v === null || typeof v !== "object") return;
      process.stdout.write(Object.keys(v).filter((k) => v[k] === true).sort().join(" "));
    });
  ' 2>/dev/null
}

signup_disabled_check() {
  echo
  echo "── production sign-up (the App Review notes claim invite-only)"

  local key settings probe_email res code body error_code msg providers pin want why got

  key=$(anon_key_for_project)
  if [ -z "$key" ]; then
    signup_verified=0
    echo "   — no anon key for $supabase (APEX_SUPABASE_ANON_KEY, or a .env.local whose" >&2
    echo "     VITE_SUPABASE_URL is this project). Sign-up NOT verified this run." >&2
    return
  fi

  settings=$(curl -s --max-time 15 -H "apikey: $key" "$supabase/auth/v1/settings" 2>/dev/null)
  got=$(printf '%s' "$settings" | json_at disable_signup)
  if [ -z "$got" ]; then
    signup_verified=0
    echo "   — GET /auth/v1/settings carried no disable_signup (key rejected, or project" >&2
    echo "     down). Sign-up NOT verified this run." >&2
    return
  fi

  # 4a. The toggle as GoTrue reports it. This is also the gate on the POST
  #     below: we only send a signup request to a project that has already said
  #     it refuses them.
  if [ "$got" = true ]; then
    echo "   ✓ disable_signup is true"
  else
    echo "   ✗ disable_signup is false — ANYONE CAN CREATE AN ACCOUNT on $supabase" >&2
    echo "     docs/ios/app-store.md tells Apple the app is invite-only (guideline 5.1.1)," >&2
    echo "     /api/* has no allowlist, and handle_new_user() provisions a profile for every" >&2
    echo "     new auth.users row. Supabase → Authentication → Sign In / Up → turn OFF" >&2
    echo "     \"Allow new users to sign up\" (DEPLOY_MULTI_USER.md step 1.2)." >&2
    echo "     No signup request was sent: this check never completes a signup." >&2
    failed=1
    return
  fi

  # 4b. The endpoint itself, because the settings document is only a claim
  #     about the endpoint, and the endpoint is what a stranger actually meets.
  #     GoTrue refuses a disabled instance before it parses the body, so the
  #     probe body carries an address — which keeps the no-email-and-no-phone
  #     path, the one that creates an *anonymous* user, unreachable — and no
  #     password, so it cannot complete a signup even against an instance whose
  #     toggle is off. Belt (4a), braces (no password), and an address that
  #     cannot resolve.
  probe_email="apex-signup-probe-$(date -u +%s)-$$@example.invalid"
  res=$(curl -s -w $'\n%{http_code}' --max-time 15 -X POST \
    -H "apikey: $key" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$probe_email\"}" "$supabase/auth/v1/signup" 2>/dev/null)
  code=${res##*$'\n'}
  body=${res%$'\n'*}
  error_code=$(printf '%s' "$body" | json_at error_code)
  msg=$(printf '%s' "$body" | json_at msg)

  # error_code is the modern field; older GoTrue sends the message only.
  if [ "$code" = 422 ] && { [ "$error_code" = signup_disabled ] || [ "${msg#Signups not allowed}" != "$msg" ]; }; then
    echo "   ✓ POST /auth/v1/signup is refused: 422 ${error_code:-signup_disabled}"
  elif [ -n "$(printf '%s' "$body" | json_at id)" ] || [ -n "$(printf '%s' "$body" | json_at access_token)" ]; then
    # Unreachable by construction — 4a gates it and the body has no password —
    # so if it ever fires, say exactly what to do about it.
    echo "   ✗ POST /auth/v1/signup CREATED SOMETHING ($code) for $probe_email" >&2
    echo "     Delete that user in Supabase → Authentication → Users, then turn sign-up off." >&2
    failed=1
  else
    echo "   ✗ POST /auth/v1/signup answered $code ${error_code:-${msg:-with no error code}}," >&2
    echo "     not 422 signup_disabled. Sign-up is not provably closed." >&2
    failed=1
  fi

  # 4c. The rest of what this endpoint exposes, pinned because there is no
  #     other committed record of it. A drift fails, so an intentional change
  #     has to be made here too — that is what "pinned" buys.
  while IFS='|' read -r pin want why; do
    [ -n "$pin" ] || continue
    got=$(printf '%s' "$settings" | json_at "$pin")
    if [ "$got" = "$want" ]; then
      echo "   ✓ $pin is $want"
    else
      echo "   ✗ $pin is ${got:-unreadable}, pinned at $want — $why" >&2
      echo "     If that was deliberate, change the pin in scripts/auth-redirect-check.sh." >&2
      failed=1
    fi
  done <<'PINS'
mailer_autoconfirm|false|invited addresses would be confirmed without the email round-trip
phone_autoconfirm|false|phone sign-up is not used at all
saml_enabled|false|no SSO tenant is configured, and an enabled one is another way in
passkeys_enabled|false|not part of the shipped sign-in flow
PINS

  # 4d. Every enabled provider is a door, and `anonymous_users` is a sign-*up*
  #     door that ignores disable_signup entirely. Exactly one is expected.
  providers=$(printf '%s' "$settings" | enabled_providers)
  if [ "$providers" = email ]; then
    echo "   ✓ email is the only enabled auth provider"
  else
    echo "   ✗ enabled auth providers: ${providers:-none} — expected exactly \"email\"" >&2
    echo "     anonymous_users self-provisions accounts regardless of disable_signup; an" >&2
    echo "     OAuth provider is a second door into an invite-only app." >&2
    failed=1
  fi

  # Printed on every run so a green check is not read as more than it is: what
  # is above is everything the anon key can see. Password minimum length,
  # password_requirements, leaked-password (HIBP) protection and MFA are not in
  # GET /auth/v1/settings and have no committed record anywhere; reading them
  # back needs the Management API and a personal access token this repo does
  # not hold and should not:
  #
  #   curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  #     https://api.supabase.com/v1/projects/<project-ref>/config/auth
  echo "   · not readable with the anon key: password minimum length, password_requirements,"
  echo "     leaked-password protection, MFA. GET /auth/v1/settings does not carry them —"
  echo "     they need the Management API and a personal access token (comment above)."
}
signup_disabled_check

if [ "$failed" -ne 0 ]; then
  echo "── FAILED: auth links do not lead to the public app, or sign-up is open (see DEPLOY_MULTI_USER.md)" >&2
  exit 1
fi
if [ "$signup_verified" -eq 1 ]; then
  echo "── auth redirects lead to $prod, and sign-up is closed"
else
  echo "── auth redirects lead to $prod (sign-up NOT verified — see above)"
fi
