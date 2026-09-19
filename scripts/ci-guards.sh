#!/usr/bin/env bash
# The CI guards that used to live only as inline shell in ci.yml, so a branch
# could pass `npm run agent:check` locally and still go red in CI. Both CI and
# agent:check run this now — one definition, no drift.
#
#   npm run ci:guards
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Every root-level api/*.ts becomes its own Vercel serverless function. New
# handlers belong in api/_lib/handlers/ behind the Hono router; bump the
# expected count only for a deliberate new entry point.
expected=4  # [...path].ts, calendar-feed.ts, chat.ts, review-cron.ts
actual=$(find api -maxdepth 1 -name '*.ts' | wc -l | tr -d ' ')
if [ "$actual" -ne "$expected" ]; then
  echo "::error::api/ has $actual root-level .ts files (expected $expected)." \
    "New handlers belong in api/_lib/handlers/ behind the router;" \
    "if a new standalone function is deliberate, bump 'expected' in scripts/ci-guards.sh."
  find api -maxdepth 1 -name '*.ts'
  exit 1
fi
echo "api function count: $actual (ok)"

# The iOS design system is generated from the web's own source files
# (docs/ios/architecture.md §11). A hex changed in tokens.css that never reached
# Tokens.swift is brand drift, and the generator is the only writer of that file.
# Runs under plain node with no dependencies, so it works in a --no-install worktree.
node ios/scripts/gen-tokens.mjs --check

# The analytics catalog (measures, labels, sport blocklist) is generated the same
# way from src/lib/analytics/{spec,labels}.ts (architecture.md §13, W9): a measure
# added on the web that never reached AnalyticsCatalog.swift is a chip the phone
# cannot draw. Loads the TS under node's type stripping — no dependencies.
node ios/scripts/gen-analytics-catalog.mjs --check

# The onboarding copy (welcome steps, checklist rows) is generated from
# src/lib/onboarding/content.ts the same way (D-035, W13): a step reworded on
# the web that never reached OnboardingCatalog.swift is a phone telling a new
# user something the laptop no longer says.
node ios/scripts/gen-onboarding-catalog.mjs --check

# The iOS dependency graph's transitive half. Direct versions are exact-pinned
# in ios/project.yml and ApexKit's manifest; everything below them is decided by
# resolution, which happens inside the git-ignored .xcodeproj (D-005). So
# ios/Package.resolved is committed and ios/scripts/sync-package-resolved.sh
# installs it before every build — which makes a stale file worse than none.
# This proves it still agrees with the manifests. Warns rather than fails while
# the file is absent: only a Mac can write the first one.
node ios/scripts/check-package-resolved.mjs --check

# Every class in a MainActor-default iOS target declares `nonisolated deinit`,
# or its synthesized isolated deinit aborts on the iOS 17/18 runtime
# (docs/ios/decisions.md D-031). CI's ios job runs iOS 26 only and cannot see
# the crash, so this grep is what enforces the rule.
ios/scripts/check-deinits.sh

# ApexCore must stay Linux-buildable: it is what a Linux session can prove with
# `swift test` (architecture.md rule 2), and CI's apexcore-linux job builds the
# whole package. One Apple-only or SDK import silently ends that, and only a
# Linux run would ever notice — so check it here, where every run does.
if grep -rnE '^[[:space:]]*import[[:space:]]+(UIKit|SwiftUI|Combine|Supabase|Auth|PostgREST|Realtime|Storage|GRDB|CoreText)\b' \
     ios/Packages/ApexCore/Sources; then
  echo "::error::ApexCore imports an Apple-only or SDK module (listed above)." \
    "Move that code to ios/Packages/ApexKit (ApexAuth / ApexPersistence / ApexUI)" \
    "and keep ApexCore dependency-free."
  exit 1
fi
echo "ApexCore imports: clean"

# Production dependencies must be free of high/critical advisories. Dev-only
# advisories don't block — dependabot PRs handle those as fixes land.
#
# `npm audit` calls registry.npmjs.org, so it fails two very different ways: a
# real advisory, and the registry being slow. Only the first is a reason not to
# merge. Retry the transient case, and if the endpoint stays unreachable, warn
# rather than block — the same call scripts/auth-redirect-check.sh makes when
# Supabase is down ("a Supabase outage is not a configuration drift"), and the
# nightly run re-audits main once the registry is back.
audit_out=$(mktemp)
audit_status=1
for attempt in 1 2 3; do
  if npm audit --omit=dev --audit-level=high >"$audit_out" 2>&1; then
    audit_status=0
    break
  fi
  # A finding, not an outage: report it and stop retrying — retrying a real
  # advisory just wastes three minutes before failing anyway.
  if ! grep -qiE 'network timeout|audit endpoint returned an error|ENOTFOUND|ECONNRESET|EAI_AGAIN|socket hang up' "$audit_out"; then
    cat "$audit_out"
    echo "::error::npm audit found a high or critical advisory in production dependencies."
    rm -f "$audit_out"
    exit 1
  fi
  echo "npm audit could not reach the registry (attempt $attempt/3)"
  # An `[ … ] && sleep` here would return non-zero on the last attempt and, under
  # `set -e`, kill the script — turning the outage path into the failure it exists
  # to avoid.
  if [ "$attempt" -lt 3 ]; then
    sleep $((attempt * 5))
  fi
done

if [ "$audit_status" -eq 0 ]; then
  cat "$audit_out"
else
  echo "::warning::npm audit could not reach registry.npmjs.org after 3 attempts — \
production dependencies were NOT audited on this run. This is an npm outage, not a \
vulnerability; the nightly scheduled run re-audits main."
  tail -3 "$audit_out"
fi
rm -f "$audit_out"
