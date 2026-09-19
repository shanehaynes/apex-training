#!/usr/bin/env bash
# Archive the app and upload it to TestFlight, without opening Xcode.
#
#   ios/scripts/testflight.sh              archive, export, upload
#   ios/scripts/testflight.sh --dry-run    archive and export to disk, do not upload
#   ios/scripts/testflight.sh --check      verify credentials and settings, build nothing
#
# CREDENTIALS
# Needs an App Store Connect API key, which only a Team Admin can create:
#   App Store Connect → Users and Access → Integrations → App Store Connect API
#   → Team Keys → (+) → Access: "App Manager" → Generate
# Download the .p8 once (Apple will not offer it again) and put it at
#   ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
# then record the two ids in ios/Config/appstoreconnect.env (git-ignored):
#   APEX_ASC_KEY_ID=XXXXXXXXXX
#   APEX_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#
# The key lets xcodebuild create the Apple Distribution certificate and
# provisioning profile on its own (-allowProvisioningUpdates), so no signing
# setup is needed beforehand.
#
# BUILD NUMBERS
# App Store Connect rejects a build number it has already seen for a marketing
# version, so this stamps CURRENT_PROJECT_VERSION from `git rev-list --count`,
# which only ever increases. MARKETING_VERSION stays in ios/project.yml.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd -P)"

MODE=upload
case "${1:-}" in
  --dry-run) MODE=dry-run ;;
  --check)   MODE=check ;;
  "")        ;;
  *) echo "usage: ios/scripts/testflight.sh [--dry-run|--check]" >&2; exit 64 ;;
esac

fail() { echo "error: $*" >&2; exit 1; }

# ── pre-flight: production's database must match main ───────────────────────
# Self-contained; nothing below depends on it. Archiving freezes APEX_API_BASE
# and the Supabase project into the binary, and production's migrations are
# pasted into the SQL Editor by hand, where a skipped one is invisible from the
# build: on 2026-09-15 production ran four days missing phase38, phase41 and
# phase32_quarantine, so GET /api/profile and DELETE /api/account 500'd — the
# second of those is a 5.1.1(v) rejection — while /api/version read current.
# prod-schema-check.mjs exits 0 in sync, 1 drift, 2 it could not check (no
# credentials in .env.local, project unreachable). An outage is not drift, so
# only a 1 stops the build. APEX_SKIP_SCHEMA_CHECK=1 skips it entirely.
# docs/ios/app-store.md §2, "Before the archive".
if [ "${APEX_SKIP_SCHEMA_CHECK:-}" = 1 ]; then
  echo "── production schema check skipped (APEX_SKIP_SCHEMA_CHECK=1)"
elif ! command -v node >/dev/null 2>&1; then
  echo "warning: node not found — production's schema was not checked" >&2
else
  echo "── checking production's schema against main"
  SCHEMA_STATUS=0
  node ../scripts/prod-schema-check.mjs || SCHEMA_STATUS=$?
  case "$SCHEMA_STATUS" in
    0) ;;
    1) fail "production is missing the migrations listed above — paste them into Supabase → SQL Editor and re-run (APEX_SKIP_SCHEMA_CHECK=1 overrides)" ;;
    *) echo "warning: could not check production's schema (exit $SCHEMA_STATUS) — continuing" >&2 ;;
  esac
fi

# ── credentials ─────────────────────────────────────────────────────────────
ENV_FILE=Config/appstoreconnect.env
[ -f "$ENV_FILE" ] && . "./$ENV_FILE"
KEY_ID="${APEX_ASC_KEY_ID:-}"
ISSUER_ID="${APEX_ASC_ISSUER_ID:-}"
[ -n "$KEY_ID" ]    || fail "APEX_ASC_KEY_ID is not set — see the header of this script"
[ -n "$ISSUER_ID" ] || fail "APEX_ASC_ISSUER_ID is not set — see the header of this script"

KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
[ -f "$KEY_PATH" ] || fail "no API key at $KEY_PATH (downloaded once from App Store Connect)"

# ── the anon key the Release build bakes in ─────────────────────────────────
scripts/secrets.sh --check >/dev/null 2>&1 || scripts/secrets.sh

BUILD_NUMBER="$(git rev-list --count HEAD)"
VERSION="$(sed -nE 's/^ *MARKETING_VERSION: *"?([^"]+)"?/\1/p' project.yml | head -1)"

echo "── TestFlight"
echo "   version:  ${VERSION:-?} (build $BUILD_NUMBER)"
echo "   key:      $KEY_ID"
echo "   mode:     $MODE"

if [ "$MODE" = check ]; then
  echo "   ✓ credentials present and readable"
  exit 0
fi

[ -d Apex.xcodeproj ] || xcodegen generate

ARCHIVE="build/Apex-$BUILD_NUMBER.xcarchive"
EXPORT_DIR="build/export-$BUILD_NUMBER"
rm -rf "$ARCHIVE" "$EXPORT_DIR"

AUTH=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$KEY_PATH"
  -authenticationKeyID "$KEY_ID"
  -authenticationKeyIssuerID "$ISSUER_ID"
)

echo "── archiving"
xcodebuild archive \
  -project Apex.xcodeproj \
  -scheme Apex \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  "${AUTH[@]}"

# Written fresh each run so it can never drift from what this script intends.
# destination=upload makes the export step do the upload too, which keeps the
# credentials in one place instead of also configuring altool.
PLIST="build/ExportOptions-$BUILD_NUMBER.plist"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$([ "$MODE" = upload ] && echo upload || echo export)</string>
  <key>teamID</key><string>G44GWSXFK2</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLISTEOF

echo "── exporting${MODE:+ ($MODE)}"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$PLIST" \
  -exportPath "$EXPORT_DIR" \
  "${AUTH[@]}"

if [ "$MODE" = upload ]; then
  echo "── uploaded build $BUILD_NUMBER — App Store Connect takes 5–15 minutes to process it"
else
  echo "── exported to $EXPORT_DIR (not uploaded)"
  find "$EXPORT_DIR" -maxdepth 1 -type f
fi
