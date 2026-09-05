# Testing, CI and release

## Who can verify what

| Check | Linux session | Mac session | CI |
|---|---|---|---|
| `swift test --package-path ios/Packages/ApexCore` (models, API client, NDJSON parser, action queue, tracker editor, write-queue state machine) | ✅ needs a Swift toolchain (`swiftly` or the swift.org tarball) | ✅ | `apexcore-linux` job |
| Fixture contract (`ios/Fixtures/*.json` decode into `ApexCore` models) | ✅ part of `swift test` | ✅ | both jobs |
| `ios/scripts/gen-tokens.mjs --check` (design tokens in sync with `src/styles/tokens.css`, `src/utils/workoutColors.ts`, `src/lib/analytics/palette.ts`) | ✅ | ✅ | `check` job (add to `ci:guards`) |
| `scripts/db-types.sh --check` including the Swift emit | ✅ (needs the local stack) | ✅ | `full` job |
| Backend endpoint tests (`api/__tests__/integration`) | ✅ | ✅ | `full` job |
| `xcodebuild test` (unit + snapshot + XCUITest smoke) | ❌ read the macOS job's `.xcresult` and screenshot artifacts via `gh run download` | ✅ | `ios` job |
| Simulator screenshots for a UI change | ❌ | ✅ `ios/scripts/screenshots.sh` (boots a simulator, runs the XCUITest smoke, collects attachments) | artifacts |
| On-device / TestFlight | ❌ | ✅ | `testflight.yml` (manual dispatch) |

Rule for briefs: a Linux session may take a Swift workstream only if its acceptance criteria are
fully covered by `swift test` and the fixture contract. UI workstreams are Mac-session work and
say so.

## Test layers

1. **`ApexCore` unit tests** — every decision in Swift-land: `OccurrenceID` round-trips,
   `Repeat` (the `builder/repeat.ts` port, with its test vectors copied), `ActionQueue`
   (`settleHead`, `appendUserText` — copy the cases from `src/lib/coach/__tests__/actionQueue.test.ts`),
   `TrackerEditor` (shadow commit, dirty keys, extra-set numbering, `collectUntouchedPlanned`),
   `WriteQueue` (coalescing, ordering, retry classes, cancel purge), `APIError` mapping
   (401/402/413/429 + `Retry-After`), NDJSON line parser (split chunks, partial lines, `error`
   events).
2. **Fixture contract tests** — a vitest in the web repo
   (`api/__tests__/fixtures/emitIosFixtures.test.ts`) runs the real handlers against the local
   stack and writes canonical responses to `ios/Fixtures/`: `schedule.json`,
   `bootstrap.json`, `bootstrap-peek.json`, `finish.json`, `chat-stream.ndjson`, `coach-summary.ndjson`, `analytics-compute.json`,
   `query-*.json`, `profile.json`. `swift test` decodes every file. The emitter runs inside the
   integration suite (`api/__tests__/integration/ios-read.integration.test.ts`): by default it
   **checks** the committed files and fails on drift; `APEX_FIXTURES_WRITE=1` regenerates them
   after a deliberate shape change. CI's `full` job therefore checks them with no extra step.
3. **Snapshot tests** (`swift-snapshot-testing`) in `ApexFeatures`: Day view (empty, three
   events, completed), tracker set row in each state (planned / shadow / logged / autofilled /
   extra), confirmation card, KPI and line tiles, event detail sheet. iPhone 17 (iOS 26) and,
   where the runtime is installed, iPhone 16 (iOS 18) — dark, default and one large Dynamic
   Type size. Snapshots are opt-in behind `TEST_RUNNER_APEX_SNAPSHOTS=1` (xcodebuild strips any other environment) and reviewed on a Mac, never a
   CI gate: their bytes depend on the OS's own text rendering, and a suite that is red for
   environmental reasons is a suite people learn to ignore.
4. **XCUITest smoke** — launch with `-apexMockClient` (W2: `ios/Apex/Mock/`, an in-process
   `HTTPTransport` answering every `/api/*` route from the bundled fixtures, any-credentials
   auth, "today" fixed to the fixture day; CI's unsigned build has no Keychain, so a real
   sign-in could never carry the smoke) → sign in → today → month → day sheet → event → complete.
   W4 extends it into the tracker. It attaches screenshots at each step;
   `ios/scripts/screenshots.sh` collects them. The live flavour (`testSignInRevealsTheFourTabs`)
   still signs in against the local stack and skips when none is reachable.
5. **Backend** — every new endpoint gets an integration test in `api/__tests__/integration`
   (real JWT, cross-user isolation) and unit tests for any pure helper. The `.js`-specifier
   import-graph guard runs in `scripts/ci-guards.sh`.

## CI jobs (added to `.github/workflows/ci.yml`; the workflow file is HELD → Shane merges)

```yaml
apexcore-linux:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v7
    - uses: swift-actions/setup-swift@v2
      with: { swift-version: "6.1" }          # ApexCore is tools-version 6.0; no Apple SDK needed
    - run: swift test --package-path ios/Packages/ApexCore

ios:
  # macos-15's default Xcode cannot build a tools-version 6.2 manifest or Swift 6.3
  # sources, which is what ApexKit is.
  runs-on: macos-26
  timeout-minutes: 40
  steps:
    - uses: actions/checkout@v7
      with: { fetch-depth: 0 }
    - name: Skip when no iOS paths changed
      run: |
        base=$(git merge-base origin/main HEAD)
        if git diff --quiet "$base" HEAD -- ios/ ; then echo "no ios changes"; echo "skip=1" >> "$GITHUB_ENV"; fi
    - run: brew install xcodegen
      if: env.skip != '1'
    - run: xcodegen generate --spec ios/project.yml
      if: env.skip != '1'
    - run: xcodebuild -project ios/Apex.xcodeproj -scheme Apex -configuration Local -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath ios/build/dd -resultBundlePath ios/build/Apex.xcresult CODE_SIGNING_ALLOWED=NO test
      if: env.skip != '1'
    - uses: actions/upload-artifact@v7
      if: always() && env.skip != '1'
      with: { name: ios-results, path: ios/build/Apex.xcresult, retention-days: 7 }
```

Why the early-exit instead of `on.paths`: the merge queue's `merge_group` event and required
status checks do not compose with path filters — a required check that never starts blocks the
queue. The job always starts and finishes green in seconds for web-only PRs.

## Local loop on the Mac

```bash
brew install xcodegen
cd ios && xcodegen generate            # per worktree; .xcodeproj is git-ignored
xcodebuild -project Apex.xcodeproj -scheme Apex -configuration Local \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build/dd CODE_SIGNING_ALLOWED=NO test
ios/scripts/screenshots.sh             # runs the smoke, writes ios/build/screens/<device>/*.png
ios/scripts/screenshots.sh 'iPhone 16' 18.6 # the iOS 18 chrome, if that runtime is installed
```

The first generate + build in a fresh worktree takes several minutes: supabase-swift pulls
`swift-syntax`, whose macro plugin compiles from source.

Pointing a simulator build at the local Supabase stack: build configuration `Local` sets
`APEX_API_BASE=http://127.0.0.1:$(APEX_LOCAL_PORT)` and `SUPABASE_URL=http://127.0.0.1:54321`
with the committed local anon key from `.env.agent`. Override the port for your worktree in
`ios/Config/Local.local.xcconfig` (git-ignored). A simulator build must never point at
production Supabase — `AppConfig.assertSafe()` makes that a launch-time trap rather than a
rule people remember.

## TestFlight

1. **One command, no Xcode** — this is how build 0 (0.1.0/285) shipped:

   ```bash
   ios/scripts/testflight.sh --check     # credentials only, builds nothing
   ios/scripts/testflight.sh --dry-run   # archive + export to disk, no upload
   ios/scripts/testflight.sh             # archive + upload
   ```

   It needs an App Store Connect API key (App Store Connect → Users and Access →
   Integrations → App Store Connect API → Team Keys): the `.p8` at
   `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8` and the two ids in
   `ios/Config/appstoreconnect.env` (git-ignored; see the `.example`). That key also lets
   `xcodebuild -allowProvisioningUpdates` create the Apple Distribution certificate and the
   provisioning profile on its own, so there is no signing setup to do first — this machine
   had neither when the first build shipped.

   Build numbers come from `git rev-list --count HEAD`, which only increases. App Store
   Connect rejects a build number it has already seen for a marketing version, and that is the
   usual way a release gets stuck. The marketing version stays in `ios/project.yml`.

   Uploading publishes a build to Apple — confirm with Shane before running it without
   `--dry-run`.

2. By hand in Xcode, if the script cannot run:

   ```bash
   ios/scripts/secrets.sh                 # the anon key; git-ignored, so per-worktree
   cd ios && xcodegen generate
   open Apex.xcodeproj
   ```

   Sign in under Xcode → Settings → Accounts, set the destination to **Any iOS Device
   (arm64)** (Archive is disabled while a simulator is selected), then **Product → Archive** →
   **Distribute App → TestFlight & App Store → Upload**.

   Prerequisites either way: the Apple Developer account, App ID
   `com.shanehaynes.apextraining` with the associated-domains capability, and — easy to miss,
   and separate from the App ID — an **App Store Connect app record** for that bundle id, or
   the upload is rejected.

3. Later, if this ever needs to run in CI: `.github/workflows/testflight.yml` on
   `workflow_dispatch` (HELD), calling the same script with the key from repo secrets and
   `github.run_number` as the build number.
4. Builds expire after 90 days — W13 sets a release cadence note in MASTER.md.

## App Store gate (W13)

- `PrivacyInfo.xcprivacy` listing required-reason APIs (UserDefaults, file timestamps).
- App Privacy answers: email (account), fitness data the user enters (linked to identity), no
  tracking, no HealthKit.
- In-app account deletion (guideline 5.1.1(v)) → `DELETE /api/profile` (W11).
- BYO Anthropic key: the app is fully usable without it; the coach is presented as optional;
  no pricing shown. Review notes explain it and provide a demo account with a key already saved.
- Invite-only sign-up: the sign-in screen states it and gives a contact path rather than a dead
  end.
