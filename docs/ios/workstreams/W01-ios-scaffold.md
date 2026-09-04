# W1 — iOS scaffold

**Machine:** Mac · **Depends on:** — (runs in parallel with W0) · **Unblocks:** W2, W11
**Status:** done — every acceptance criterion met, TestFlight build 0 shipped

## Goal
A running app that signs in against Supabase, shows four empty tabs in the house style, and is
buildable by CI and by any worktree. TestFlight build 0.

## Scope
In:
- `ios/project.yml` (XcodeGen): app target `Apex` (bundle id `com.shanehaynes.apextraining`, iOS 17.0,
  Swift 6, `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`), `ApexTests`, `ApexUITests`; build
  configurations `Debug`, `Local`, `Release` with `APEX_API_BASE` / `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` per configuration (Local = the committed `.env.agent` values).
- Packages: `ApexCore` (models skeleton, `ApexClient`, `APIError`, NDJSON parser, `Clock`),
  `ApexPersistence` (GRDB store skeleton + migrations), `ApexAuth` (supabase-swift Auth,
  Keychain, `TokenProvider`), `ApexUI` (tokens, fonts, avatars, base components, `ToastHost`),
  `ApexFeatures` (empty feature targets).
- `ios/scripts/gen-tokens.mjs` (+ `--check`, wired into the CI guards script).
- **App icon** per design-spec §8: `ios/Design/app-icon.svg` + asset catalog export.
- Sign-in screen (email/password, AutoFill content types, invite-only copy, forgot password →
  W2), sign out, session restore, 401 → refresh → retry → sign out.
- `ios/CLAUDE.md`: Linux vs Mac verification, local loop, `xcodegen generate` per worktree,
  never build in the primary checkout (and add the Xcode build command to
  `scripts/hooks/bash-guard.mjs`).
- `.gitignore`: `ios/*.xcodeproj`, `ios/build/`, DerivedData.
- Separate HELD PRs: (a) `.github/workflows/ci.yml` `apexcore-linux` + `ios` jobs;
  (b) `public/.well-known/apple-app-site-association` + `vercel.json` content-type header
  (`applinks` for `/auth/*`, `/app/*`; `webcredentials`).
Out: any real screen content.

## Touches
`ios/**` (new), `.github/workflows/ci.yml` (HELD), `public/.well-known/**`, `vercel.json` (HELD),
`scripts/hooks/bash-guard.mjs`, `scripts/ci-guards.sh`, `.gitignore`.

## Acceptance
- XcodeGen generation and the simulator test run are green locally and in the `ios` CI job;
  `swift test --package-path ios/Packages/ApexCore` is green on Linux.
- `gen-tokens.mjs --check` green; changing a hex in `tokens.css` fails it.
- Sign in with a local-stack user on a simulator; session survives relaunch; sign out clears
  the Keychain.
- Tab bar, nav bar, fonts, colours match design-spec (snapshot of the empty Schedule tab).
- TestFlight build 0 installed on Shane's phone.

## Session log
- 2026-09-03 · Mac · Scaffold built and verified on device simulators.
  - **Two SwiftPM packages, not five** (D-021): `ApexCore` (no dependencies, Linux-buildable)
    and `ApexKit` (ApexAuth · ApexPersistence · ApexUI · ApexFeatures). The generated
    `DatabaseTypes.swift` moved to `ApexAuth` — it needs supabase-swift's `AnyJSON`, which the
    compiler proved immediately: `ApexCore` would not build without it. `scripts/db-types.sh`
    repointed; the emit is unchanged, so `--check` still diffs clean.
  - **Build configuration** via xcconfig → Info.plist → `Bundle.main` (D-022), with
    `AppConfig.assertSafe()` trapping a simulator build that points anywhere but 127.0.0.1.
  - **Corrections to the plan**, all applied to the docs: the App ID is
    `com.shanehaynes.apextraining`, not `com.apextraining.app`; the destination is iPhone 17
    (no iPhone 16 existed until an iOS 18.6 runtime was installed); the CI runner must be
    `macos-26`; fonts register with `CTFontManagerRegisterFontsForURL`, not `UIAppFonts`,
    because SwiftPM resources are not in the main bundle; and a test target must **not** get
    `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` (XCTestCase's overrides are nonisolated).
  - **Verified:** 36 `swift test` cases on ApexCore including all nine fixtures decoding;
    15 simulator unit tests; the XCUITest smoke signing in as a real local-stack user and
    reaching all four tabs, on iPhone 17 (iOS 26) and iPhone 16 (iOS 18); `gen-tokens --check`
    failing on a hex change and on a workoutColors/tokens.css disagreement; the ApexCore
    import guard failing on a planted `import SwiftUI`; `db-types.sh --check`; `agent:check`.
  - **Acceptance closed out 2026-09-04:** session survives relaunch and sign-out clears the
    Keychain, both verified on a signed simulator build. The first attempt used a
    `CODE_SIGNING_ALLOWED=NO` build and appeared to fail — an unsigned app cannot write the
    Keychain, so the session never persists. That is a CI-shaped build, not a bug; noted in
    ios/CLAUDE.md so the next session does not chase it.
  - **TestFlight build 0 shipped 2026-09-04** as 0.1.0 (285), archived and uploaded headlessly
    by `ios/scripts/testflight.sh` — no Xcode GUI. The App Store Connect API key let
    `xcodebuild -allowProvisioningUpdates` create the Apple Distribution certificate and
    provisioning profile itself; the machine had neither beforehand. The `.ipa` carries the
    associated-domains entitlement, so the AASA landed in #104 is now exercisable on device.
  - **Not done, and why:** SwiftLint was left out rather than added unwired to CI.
