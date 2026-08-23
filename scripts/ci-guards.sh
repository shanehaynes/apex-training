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

# Production dependencies must be free of high/critical advisories. Dev-only
# advisories don't block — dependabot PRs handle those as fixes land.
npm audit --omit=dev --audit-level=high
