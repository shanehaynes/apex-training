#!/usr/bin/env bash
# Keep the committed ios/Package.resolved and the generated workspace's copy of
# it in step.
#
#   ios/scripts/sync-package-resolved.sh            install the committed file into the
#                                                   generated workspace (before resolution)
#   ios/scripts/sync-package-resolved.sh --update   copy the workspace's file back out,
#                                                   which is how it is created and refreshed
#
# WHY THIS EXISTS
# Direct dependencies are exact-pinned — swift-snapshot-testing in
# ios/project.yml, supabase-swift and GRDB in ios/Packages/ApexKit/Package.swift
# — but everything below them is decided by resolution. supabase-swift alone
# pulls swift-crypto, swift-http-types and the point-free concurrency packages;
# snapshot-testing pulls swift-syntax. SwiftPM records the whole graph in
# Package.resolved, and for an .xcodeproj that file lives at
#
#   Apex.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
#
# — inside the generated, git-ignored project (D-005). So it has never been
# committed, and every archive resolved the transitive graph afresh: two builds
# of the same commit, a week apart, could ship different code. Committing
# ios/Package.resolved and copying it in before xcodebuild touches the graph is
# what makes the release reproducible.
#
# Installing is a no-op when the committed file is absent, so nothing here
# breaks before the first one is generated (which needs a Mac).
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd -P)"

COMMITTED=Package.resolved
WORKSPACE_DIR=Apex.xcodeproj/project.xcworkspace/xcshareddata/swiftpm
GENERATED="$WORKSPACE_DIR/Package.resolved"

RESOLVE_HINT='cd ios && xcodegen generate && xcodebuild -resolvePackageDependencies -project Apex.xcodeproj -scheme Apex && scripts/sync-package-resolved.sh --update'

case "${1:-}" in
  --update) MODE=update ;;
  "")       MODE=install ;;
  *) echo "usage: ios/scripts/sync-package-resolved.sh [--update]" >&2; exit 64 ;;
esac

if [ "$MODE" = update ]; then
  if [ ! -f "$GENERATED" ]; then
    echo "error: no ios/$GENERATED — resolve the graph first:" >&2
    echo "  $RESOLVE_HINT" >&2
    exit 1
  fi
  if [ -f "$COMMITTED" ] && cmp -s "$GENERATED" "$COMMITTED"; then
    echo "ios/$COMMITTED is already what the workspace resolved"
    exit 0
  fi
  cp "$GENERATED" "$COMMITTED"
  echo "updated ios/$COMMITTED from the workspace — review the diff and commit it"
  exit 0
fi

if [ ! -f "$COMMITTED" ]; then
  # Not an error: the file can only be created on a Mac, and until it is, a
  # build resolves the transitive graph the way it always did.
  echo "note: ios/$COMMITTED is not committed yet — transitive versions will float on this build."
  echo "      To create it (Mac only): $RESOLVE_HINT"
  exit 0
fi

if [ ! -d Apex.xcodeproj ]; then
  echo "error: no ios/Apex.xcodeproj — run \`xcodegen generate\` before this script" >&2
  exit 1
fi

if [ -f "$GENERATED" ] && cmp -s "$COMMITTED" "$GENERATED"; then
  echo "ios/$COMMITTED is already installed in the workspace"
  exit 0
fi

mkdir -p "$WORKSPACE_DIR"
cp "$COMMITTED" "$GENERATED"
echo "installed ios/$COMMITTED into ios/$GENERATED"
