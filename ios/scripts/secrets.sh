#!/usr/bin/env bash
# Recreate ios/Config/Secrets.xcconfig in this worktree.
#
# WHY THIS EXISTS
# The file holds one value — the production Supabase anon key — and is
# git-ignored, so it lives in exactly one worktree and dies with it. Worktrees
# are removed by scripts/git-tidy.sh as soon as their PR merges, which has
# already silently taken this file twice. A device or Release build without it
# does not fail loudly at build time: it builds, installs, and then traps at
# launch on the REPLACE_ME sentinel.
#
# The key is public by construction — the web ships it in every page load, and
# RLS is what actually protects the data — so deriving it from the deployed
# bundle is not a credential leak. It is kept out of git only so the repo
# carries no production configuration at all.
#
# Scraping the bundle is a guess, so the guess is checked: the key's JWT payload
# has to say role=anon for this project, unexpired, or nothing is written.
# --check re-runs that same assertion against the file on disk, because a key
# that is merely present and non-placeholder is what ships a wrong-but-valid
# looking build (AppConfig.assertSafe only knows about REPLACE_ME).
#
#   ios/scripts/secrets.sh          write ios/Config/Secrets.xcconfig
#   ios/scripts/secrets.sh --check  exit 1 unless the file holds this
#                                   project's unexpired anon key
#
# If the site is unreachable, take the key from Supabase → Project Settings → API.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd -P)"

OUT=Config/Secrets.xcconfig
ORIGIN="${APEX_PROD_URL:-https://apextrainingcalendar.vercel.app}"
# The same ref as APEX_PROD_SUPABASE_URL in Config/Base.xcconfig and
# scripts/auth-redirect-check.sh. Overridable so the assertion can be exercised.
PROJECT_REF="${APEX_PROJECT_REF:-prmlzrkcfvmfapauoxqn}"

# Decoding a JWT payload needs base64url, which neither macOS's nor GNU's base64
# does; both platforms have one of these two.
if command -v python3 >/dev/null 2>&1; then
  JWT_DECODER=python3
elif command -v node >/dev/null 2>&1; then
  JWT_DECODER=node
else
  echo "error: need python3 or node to validate the anon key" >&2
  exit 1
fi

# Echo "<role> <ref> <exp>" from a JWT's payload; non-zero if it is not a
# three-part token with a decodable JSON object payload. Missing claims come
# back as "-" so the field count never shifts.
jwt_claims() {
  case $JWT_DECODER in
    python3)
      printf '%s' "$1" | python3 -c '
import base64, json, sys
parts = sys.stdin.read().strip().split(".")
if len(parts) != 3:
    sys.exit(1)
try:
    pad = "=" * (-len(parts[1]) % 4)
    payload = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
except Exception:
    sys.exit(1)
if not isinstance(payload, dict):
    sys.exit(1)
print(*[str(payload.get(k, "-") or "-") for k in ("role", "ref", "exp")])
' ;;
    node)
      printf '%s' "$1" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  const parts = raw.trim().split(".");
  if (parts.length !== 3) process.exit(1);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    process.exit(1);
  }
  if (typeof payload !== "object" || payload === null) process.exit(1);
  console.log(["role", "ref", "exp"].map((k) => String(payload[k] ?? "-") || "-").join(" "));
});
' ;;
  esac
}

# Enough of a candidate to tell two of them apart in an error line. Every JWT
# header is the same handful of characters, so take both ends.
short() {
  printf '%s…%s' "${1:0:10}" "${1: -10}"
}

# Assert a key is this project's unexpired anon key. Says why on stderr when it
# is not; sets KEY_EXP on success.
validate_key() {
  local key=$1 label=$2 claims role ref exp now
  if ! claims=$(jwt_claims "$key"); then
    echo "$label: not a decodable JWT" >&2
    return 1
  fi
  read -r role ref exp <<<"$claims"
  if [ "$role" != "anon" ]; then
    echo "$label: role is \"$role\", expected \"anon\"" >&2
    return 1
  fi
  if [ "$ref" != "$PROJECT_REF" ]; then
    echo "$label: ref is \"$ref\", expected \"$PROJECT_REF\"" >&2
    return 1
  fi
  case $exp in
    '' | *[!0-9]*)
      echo "$label: exp is \"$exp\", expected a Unix timestamp" >&2
      return 1
      ;;
  esac
  now=$(date -u +%s)
  if [ "$exp" -le "$now" ]; then
    echo "$label: expired $(( (now - exp) / 86400 )) days ago (exp $exp)" >&2
    return 1
  fi
  KEY_EXP=$exp
  return 0
}

if [ "${1:-}" = "--check" ]; then
  if [ ! -f "$OUT" ]; then
    echo "error: ios/$OUT is missing — run ios/scripts/secrets.sh" >&2
    exit 1
  fi
  key=$(sed -n 's/^[[:space:]]*SUPABASE_ANON_KEY[[:space:]]*=[[:space:]]*//p' "$OUT" | head -1 | tr -d '[:space:]')
  if [ -z "$key" ] || [ "$key" = "REPLACE_ME" ]; then
    echo "error: ios/$OUT has no SUPABASE_ANON_KEY — run ios/scripts/secrets.sh" >&2
    exit 1
  fi
  if ! validate_key "$key" "ios/$OUT"; then
    echo "error: ios/$OUT is not $PROJECT_REF's anon key — run ios/scripts/secrets.sh" >&2
    exit 1
  fi
  echo "ok: ios/$OUT holds $PROJECT_REF's anon key (role anon, exp $KEY_EXP)"
  exit 0
fi

index=$(curl -fsSL "$ORIGIN/" 2>/dev/null) || {
  echo "error: could not reach $ORIGIN — take the anon key from Supabase → Settings → API" >&2
  exit 1
}
# The anon key is inlined in the built app bundle, which the browser downloads
# on every page load.
bundle_path=$(printf '%s' "$index" | grep -oE '/assets/index-[A-Za-z0-9._-]+\.js' | head -1)
[ -n "$bundle_path" ] || { echo "error: no app bundle found in $ORIGIN/" >&2; exit 1; }

# Every JWT-shaped string in the bundle is a candidate; the one that validates
# wins, rather than whichever sorts first. (Supabase's newer sb_publishable_
# keys are not JWTs and carry no ref claim — this assertion would have to be
# rewritten before the project could move to one.)
candidates=$(curl -fsSL "$ORIGIN$bundle_path" \
  | grep -oE 'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' \
  | sort -u) || true
[ -n "$candidates" ] || { echo "error: no JWT-shaped key found in $bundle_path" >&2; exit 1; }

key=
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  if validate_key "$candidate" "$(short "$candidate")" 2>/dev/null; then
    key=$candidate
    break
  fi
done <<<"$candidates"

if [ -z "$key" ]; then
  echo "error: no JWT in $bundle_path is $PROJECT_REF's anon key:" >&2
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    validate_key "$candidate" "  $(short "$candidate")" || true
  done <<<"$candidates"
  echo "take the anon key from Supabase → Project Settings → API" >&2
  exit 1
fi

mkdir -p Config
cat > "$OUT" <<CONF
// Git-ignored, and regenerated by ios/scripts/secrets.sh — do not commit.
// The anon key is public by construction (the web ships it in every page load);
// it lives outside git only so the repo carries no production configuration.
SUPABASE_ANON_KEY = $key
CONF
echo "wrote ios/$OUT (${#key}-character $PROJECT_REF anon key from $bundle_path, exp $KEY_EXP)"
