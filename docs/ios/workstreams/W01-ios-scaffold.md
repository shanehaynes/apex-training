# W1 — iOS scaffold

**Machine:** Mac · **Depends on:** — (runs in parallel with W0) · **Unblocks:** W2, W11
**Status:** ready

## Goal
A running app that signs in against Supabase, shows four empty tabs in the house style, and is
buildable by CI and by any worktree. TestFlight build 0.

## Scope
In:
- `ios/project.yml` (XcodeGen): app target `Apex` (bundle id `com.apextraining.app`, iOS 17.0,
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
- (none yet)
