#!/usr/bin/env bash
# Release gate: refuse to build an archive that carries placeholder configuration.
#
# WHY THIS EXISTS
# ios/Config/Secrets.xcconfig is git-ignored, so it lives in exactly one worktree
# and dies with it — git-tidy.sh has already taken it twice (scripts/secrets.sh).
# Without it Base.xcconfig leaves SUPABASE_ANON_KEY = REPLACE_ME, which is a
# syntactically valid non-empty string: the archive builds, signs, exports,
# uploads, passes App Store Connect processing, and then trips
# AppConfig.assertSafe()'s precondition on launch for 100% of users. That
# precondition stays as belt and braces, but the App Store is the wrong place to
# discover this. This phase moves the failure to build time, where it belongs.
#
# HOW IT RUNS
# XcodeGen inlines this file's *contents* into the generated .pbxproj rather than
# invoking it by path (PBXProjGenerator.generateBuildScript: `case let .path(path):
# shellScript = try (project.basePath + path).read()`), so the build never reads
# it from disk and the phase needs no declared inputFiles to satisfy
# ENABLE_USER_SCRIPT_SANDBOXING: YES (project.yml). It reads build settings out
# of the environment and touches no files at all. Re-run `xcodegen generate`
# after editing this file, or the project keeps the old copy.
#
# It is also runnable standalone, which is how the logic is proved without a Mac:
#
#   CONFIGURATION=Release APEX_API_BASE=https://apextrainingcalendar.vercel.app \
#     SUPABASE_ANON_KEY=REPLACE_ME ios/scripts/verify-release-config.sh
set -euo pipefail

# Debug and Local are developer configurations: Local's anon key is committed,
# and a Debug device build is expected to trap at launch rather than refuse to
# build. Release is the only configuration that can reach a user.
if [ "${CONFIGURATION:-}" != "Release" ]; then
  echo "note: verify-release-config: skipped for the ${CONFIGURATION:-unset} configuration"
  exit 0
fi

# Stated here rather than derived from the xcconfig that sets it: a gate that
# reads its expectation out of the value it is checking checks nothing. Keep in
# step with APEX_API_BASE in ios/Config/Release.xcconfig.
EXPECTED_API_BASE="https://apextrainingcalendar.vercel.app"

# The base64 of {"iss":"supabase-demo" — the head of the Supabase CLI's demo anon
# key, identical for every local project and committed in Local.xcconfig. A
# Release build carrying it would point at production with a key for a stack that
# is not there.
LOCAL_ANON_KEY_MARKER="eyJpc3MiOiJzdXBhYmFzZS1kZW1v"

# "error:" at the start of a line is what makes Xcode surface this in the issue
# navigator and fail the build.
fail() { echo "error: $*" >&2; exit 1; }

FIXIT="Run ios/scripts/secrets.sh in this worktree to write ios/Config/Secrets.xcconfig, then build again."

key="${SUPABASE_ANON_KEY:-}"
case "$key" in
  "")
    fail "Release build: SUPABASE_ANON_KEY is empty. $FIXIT" ;;
  REPLACE_ME)
    fail "Release build: SUPABASE_ANON_KEY is still the REPLACE_ME placeholder from Base.xcconfig, so ios/Config/Secrets.xcconfig is missing or unset. $FIXIT" ;;
  *"$LOCAL_ANON_KEY_MARKER"*)
    fail "Release build: SUPABASE_ANON_KEY is the local Supabase demo key from Local.xcconfig, not the production anon key. $FIXIT" ;;
esac

if [ "${APEX_API_BASE:-}" != "$EXPECTED_API_BASE" ]; then
  fail "Release build: APEX_API_BASE is \"${APEX_API_BASE:-}\", expected the production origin \"$EXPECTED_API_BASE\". Check ios/Config/Release.xcconfig (and any Local.local.xcconfig that leaked into this build)."
fi

echo "note: verify-release-config: Release is production — $EXPECTED_API_BASE, ${#key}-character anon key"
