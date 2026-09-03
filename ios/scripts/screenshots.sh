#!/usr/bin/env bash
# Runs the XCUITest smoke and collects the screenshots it attaches.
#
# This is how a Mac session produces the visual evidence a PR carries; snapshot
# tests are opt-in and compared by eye, not by CI (see ScheduleSnapshotTests).
#
#   ios/scripts/screenshots.sh                       # iPhone 17 (iOS 26)
#   ios/scripts/screenshots.sh 'iPhone 16' 18.6      # a second chrome generation
#
# Output: ios/build/screens/*.png
set -euo pipefail
cd "$(dirname "$0")/.."

DEVICE="${1:-iPhone 17}"
# Pin the OS: a device name that is a prefix of another ("iPhone 16" vs "iPhone
# 16 Pro") does not match on its own, and xcodebuild's error does not say why.
OS="${2:-}"
SLUG="$(echo "$DEVICE" | tr ' ' '-')"
DESTINATION="platform=iOS Simulator,name=$DEVICE${OS:+,OS=$OS}"
RESULT="build/screens-$SLUG.xcresult"
OUT="build/screens/$SLUG"

[ -d Apex.xcodeproj ] || xcodegen generate

rm -rf "$RESULT" "$OUT"
mkdir -p "$OUT"

xcodebuild \
  -project Apex.xcodeproj \
  -scheme Apex \
  -configuration Local \
  -destination "$DESTINATION" \
  -derivedDataPath build/dd \
  -resultBundlePath "$RESULT" \
  -only-testing:ApexUITests \
  CODE_SIGNING_ALLOWED=NO \
  test

# The exporter names files by UUID and records the real names in manifest.json,
# so rename them back — "01-sign-in.png" is what makes a PR readable.
xcrun xcresulttool export attachments --path "$RESULT" --output-path "$OUT" >/dev/null
python3 - "$OUT" <<'PYTHON'
import json, os, re, sys
out = sys.argv[1]
manifest = os.path.join(out, "manifest.json")
for test in json.load(open(manifest)):
    for attachment in test.get("attachments", []):
        src = os.path.join(out, attachment["exportedFileName"])
        name = attachment.get("suggestedHumanReadableName") or ""
        if not name.endswith(".png") or not os.path.exists(src):
            continue
        # "02-schedule_0_B5870F35-….png" -> "02-schedule.png"
        clean = re.sub(r"_\d+_[0-9A-F-]{36}(?=\.png$)", "", name)
        os.replace(src, os.path.join(out, clean))
PYTHON
find "$OUT" -name '*.txt' -delete
rm -f "$OUT/manifest.json"

echo
echo "screenshots in $OUT:"
find "$OUT" -name '*.png' | sort
