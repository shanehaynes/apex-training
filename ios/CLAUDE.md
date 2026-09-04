# The iOS app

Native SwiftUI port of the web app. Plan of record: [docs/ios/MASTER.md](../docs/ios/MASTER.md)
— read it and [STATUS.md](../docs/ios/STATUS.md) before starting, and follow the session
protocol there. The repo-wide rules in the root [CLAUDE.md](../CLAUDE.md) apply unchanged:
worktree per task, claims, HELD paths, `agent:check`.

## The tree

```
ios/
  project.yml            XcodeGen spec — the .xcodeproj is generated and git-ignored
  Config/*.xcconfig      per-configuration API base, Supabase URL and anon key
  Apex/                  @main app, AppConfig, AppModel, Info.plist, entitlements, icon
  ApexTests/             unit + snapshot tests (simulator)
  ApexUITests/           XCUITest smoke
  Design/                app icon source (SVG)
  Fixtures/              JSON emitted by the web repo's integration suite — never hand-edited
  Packages/
    ApexCore/            NO dependencies, NO Apple imports. Linux-buildable.
    ApexKit/             ApexAuth · ApexPersistence · ApexUI · ApexFeatures (iOS only)
  scripts/               gen-tokens.mjs · render-icon.mjs · screenshots.sh
```

**`ApexCore` has no dependencies and no Apple-only imports. That is a CI-enforced
invariant, not a convention** — `scripts/ci-guards.sh` greps for it, because a Linux session
proves Swift decisions with `swift test` on that package and one `import SwiftUI` ends that
for everybody. Anything needing UIKit/SwiftUI, supabase-swift or GRDB goes in `ApexKit`.

## What you can prove where

**Linux session.** `swift test --package-path ios/Packages/ApexCore` is your only gate. It
covers the API client's 401 policy, `APIError` mapping, the NDJSON parser, `Endpoint` URLs
and the fixture-decode contract. `ApexKit` is `platforms: [.iOS]`, so `swift build` on it
fails by design — that is not a bug to fix. Never guess at UI: write "Mac verification
needed" in the PR.

**Mac session**, from your own worktree (never the primary checkout — the hook blocks it):

```bash
cd ios && xcodegen generate
xcodebuild -project Apex.xcodeproj -scheme Apex -configuration Local \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build/dd CODE_SIGNING_ALLOWED=NO test
ios/scripts/screenshots.sh                 # visual evidence for the PR
ios/scripts/screenshots.sh 'iPhone 16' 18.6 # the iOS 18 chrome, if that runtime is installed
```

Pin the OS for any device whose name prefixes another (`iPhone 16` vs `iPhone 16 Pro`):
xcodebuild reports only "unable to find a device matching the provided destination specifier".

The first `xcodegen generate` + build in a fresh worktree takes several minutes: supabase-swift
pulls in `swift-syntax` and its macro plugin has to compile. It has not hung.

Snapshot tests are opt-in (`APEX_SNAPSHOTS=1`): their bytes depend on the OS's text rendering,
so they are reviewed by eye on a Mac rather than enforced on a runner.

## Configuration

`Local` (the scheme's run and test configuration) points at this worktree's vite server and
the local Supabase stack. The dev port is per-worktree — `npm run -s port` prints yours; put it
in `ios/Config/Local.local.xcconfig` (git-ignored) rather than editing `Local.xcconfig`:

```
APEX_LOCAL_PORT = 5314
```

`AppConfig.assertSafe()` traps at launch if a simulator build points anywhere but `127.0.0.1`,
which is the same rule the web harness enforces. `Debug` and `Release` point at production;
everything they need is in `Base.xcconfig` except the anon key, which goes in
`ios/Config/Secrets.xcconfig`:

```bash
ios/scripts/secrets.sh          # writes it; --check verifies it
```

That file is git-ignored, so it exists in one worktree and **dies with it** when
`git-tidy.sh` removes the worktree after its PR merges. Missing, it does not fail at build
time — the app builds, installs, and then traps at launch on the `REPLACE_ME` sentinel. Run
the script in any worktree you do a device or Release build from.

A local user to sign in as: `agent@apex.local` / `apex-agent-password`
(`scripts/create-local-users.mjs`).

Note `//` starts a comment in xcconfig, so URLs are written `http:$(SLASH)$(SLASH)host`.

## Regenerating

- `node ios/scripts/gen-tokens.mjs` — after any change to `src/styles/tokens.css`,
  `src/utils/workoutColors.ts` or `src/lib/analytics/palette.ts`. `--check` runs in
  `npm run ci:guards`, so drift fails the build rather than the brand.
- `npm run db:types` — after any migration. It writes
  `Packages/ApexKit/Sources/ApexAuth/Generated/DatabaseTypes.swift` as well as the TS types.
- `node ios/scripts/render-icon.mjs` — after editing `Design/app-icon.svg`.
- `Fixtures/` come from `api/__tests__/integration/ios-read.integration.test.ts`
  (`APEX_FIXTURES_WRITE=1` to update after a deliberate shape change). Never edit them by hand.
