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
2. **Fixture contract tests** — the integration suite
   (`api/__tests__/integration/ios-read.integration.test.ts`) runs the real handlers against the local
   stack and writes canonical responses to `ios/Fixtures/`: `schedule.json`,
   `bootstrap.json`, `bootstrap-peek.json`, `bootstrap-full.json`, `bootstrap-amrap.json`, `finish.json`, `chat-stream.ndjson`, `chat-stream-builder.ndjson`,
   `coach-summary.ndjson`, `coach-tool.json`, `coach-tool-draft.json`, `workout-draft-{create,edit,detach}.json`,
   `analytics-compute.json`, `query-*.json`, `profile.json`. `swift test` decodes every file, but
   Swift's decoder ignores keys it does not know, so a field the server adds never fails it. By
   default the suite **checks** the committed files byte for byte and fails on drift; `npm run
   fixtures:ios` (stack-locked reset, then `APEX_FIXTURES_WRITE=1`) regenerates them after a
   deliberate shape change. It needs the local stack, so `agent:check` skips it; CI's `full` job
   and `npm run agent:check:full` run it. The tracker's opening response — the file most often drifted (#417, #419,
   #422) — also has a no-DB check that `agent:check` does run:
   `api/__tests__/ios-fixture-shape.test.ts` rebuilds all four bootstrap fixtures
   through `loadResolvedOccurrence` and `buildBootstrap` on a fake client seeded with typed rows,
   and compares field names (array elements merged, PRs per `kind`), so a field added to or
   dropped from every element of an array fails locally; one element losing a field its siblings
   keep is left to the byte-for-byte check in CI. `bootstrap-full.json` exists for that coverage:
   a finished for-time session with a workout score record, every PR kind, a percentage target,
   a pitch, an added exercise, a swap, a duration shadow, a cardio shadow and the session's
   summary and note. A session row carries one score type, so `bootstrap-amrap.json` holds the
   other: an AMRAP session (`score_rounds`, `score_reps`) and its record. Both scenarios are the
   last tests in the integration file and delete their rows, because `get_prs` reads all of the
   user's records and would otherwise move `query-get_prs.json`.
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

changes:
  # Decides on ubuntu whether ios must run. In ci.yml the script sits between
  # ios-paths markers, and scripts/__tests__/ci-ios-paths.test.ts runs it from there.
  runs-on: ubuntu-latest
  timeout-minutes: 5
  outputs: { ios: "${{ steps.paths.outputs.ios }}" }
  steps:
    - uses: actions/checkout@v7
      with: { fetch-depth: 0 }
    - id: paths
      run: |
        ios=true
        case "$GITHUB_EVENT_NAME" in
          pull_request | merge_group)
            if base=$(git merge-base origin/main HEAD) &&
              git diff --quiet "$base" HEAD -- ios/ .github/workflows/ci.yml; then ios=false; fi ;;
        esac
        echo "ios=$ios" >> "$GITHUB_OUTPUT"

ios:
  needs: changes
  if: ${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.ios != 'false') }}
  # macos-15's default Xcode cannot build a tools-version 6.2 manifest or Swift 6.3
  # sources, which is what ApexKit is.
  runs-on: macos-26
  timeout-minutes: 75
  steps:
    - name: Fail when the changes job did not decide
      if: needs.changes.result != 'success'
      run: echo "::error::The changes job ended '${{ needs.changes.result }}' …"; exit 1
    - uses: actions/checkout@v7
      with: { fetch-depth: 0 }
    - run: brew install xcodegen
    - run: xcodegen generate --spec ios/project.yml
    - run: xcodebuild -project ios/Apex.xcodeproj -scheme Apex -configuration Local -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5' -derivedDataPath ios/build/dd -resultBundlePath ios/build/Apex.xcresult -retry-tests-on-failure -test-iterations 2 CODE_SIGNING_ALLOWED=NO test
    - uses: actions/upload-artifact@v7
      if: always()
      with: { name: ios-results, path: ios/build/Apex.xcresult, retention-days: 7 }
```

Why `timeout-minutes: 75`: the cap is there to stop a hung job, so it sits 15 minutes above
the slowest legitimate run seen, not at the typical one. Under the old 40-minute cap, 7 of
October's 201 built runs were killed and none was hung. Five had passed every test and died
writing or uploading the results; two were partway through ApexUITests and passing.

Where a run goes: the build takes 4–10 minutes. The test host's first launch on the simulator
takes 2–12, and shows in the log only as silence between the last build line (`Touch
…ApexUITests.xctest`) and the first test; the `.xcresult` puts the install at under a second,
so the cost is the launch. ApexTests takes under 2 minutes and ApexUITests 16–21 (26 cases).
Green runs were 34 minutes at p50 over October and 37 in its last week, but that distribution
stops at 40 because every longer run was killed. The killed runs had the longest first
launches (9–12 minutes) and builds at or past the top of the green range (8–20), and needed
41–48 minutes. #502, with a 20-minute build and a 12-minute first launch, would have needed ~57.
The job's p50 has grown by 1–2 minutes a week as UI cases are added (21 in mid-October, 26 now).

When any run gets within 15 minutes of the cap (past 60), shorten the job rather than raise
the cap again. First find out whether the first launch is the simulator still booting: time a
`xcrun simctl boot` plus `xcrun simctl bootstatus -b` step before the build for a few runs. If
it is, boot it during the build; if not, shard ApexUITests across jobs.

A run the cap kills ends `cancelled`, with an `.xcresult` that cannot be read. So the cap frees
the runner, but a hang still shows up as no test result at all.

Why a job-level skip decided on ubuntu, instead of `on.paths` or a skip inside the job:
- A path filter does not compose with required status checks (or the merge queue's
  `merge_group` event): a required check that never starts blocks the merge forever.
- A skip step inside `ios` needs a macOS runner just to exit, so every web-only PR waits for
  one. In the 2026-09-21 fleet, #237's skip started 114 minutes after its other checks, and a
  macOS outage would hold every web-only PR whose `ios` is required.
- So the `changes` job decides on ubuntu, and `ios` is skipped at job level. GitHub counts a
  job skipped by its `if:` as passing a required check.

Because a skip passes, the skip fails closed: `ios` skips only when `changes` succeeded and
said `false`.
- A `changes` that failed or timed out (GitHub reports a timeout as `cancelled`) makes `ios`
  run, and its first step fails with an `::error::` naming `changes`. `!cancelled()` replaces
  the implicit `success()`, which would skip `ios` whenever `changes` failed.
- When the whole run is cancelled, by hand or by a newer push, `ios` ends `cancelled` without
  ever getting a runner. That fails a required check too.
- A `changes` that succeeded without writing `ios=` leaves the output `''`, and `ios` builds.
  That is why the condition is `!= 'false'`: `== 'true'` would skip.

Push, schedule and dispatch always build: there the merge base is HEAD, so the diff is empty
and would skip the nightly run, the one that most needs to build the app. `ci.yml` counts as
an iOS path (the whole file, so a `coach-gate` edit too), and a PR that edits it runs this job.

Why `-retry-tests-on-failure -test-iterations 2`: a failed test is run once more and the job
is green if the second run passes — and the `.xcresult` marks it "passed on retry", which is
the only record of how often the suite actually flakes. The retry deliberately lives here and
not inside the tests: the smoke's helpers used to re-send taps a starved runner had dropped
([#192](https://github.com/shanehaynes/apex-training/issues/192)), which made a flaky run
indistinguishable from a clean one. A test that needs two runs every time is a bug report, not
a green check.

Why `OS=26.5`: a destination without one matches every runtime that carries an iPhone 17, and
xcodebuild picks the first — so the image deciding to ship a second runtime would change what
the tests ran on, quietly. Pinned, that same image change fails the job with "Unable to find a
device matching the provided destination specifier", and the pin moves in a PR. `screenshots.sh`
takes the runtime as its second argument for the same reason.

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

A red leg does not skip the export: `screenshots.sh` captures xcodebuild's status, always
exports and renames what the run attached, prints the list, then exits with that status.

The first generate + build in a fresh worktree takes several minutes: supabase-swift pulls
`swift-syntax`, whose macro plugin compiles from source.

The web gate (`npm run agent:check`) no longer cares whether `ios/build` exists in the worktree:
vite's dependency scan is pinned to `index.html` (`vite.config.ts`), so the SwiftPM checkouts' own
HTML under `build/dd/SourcePackages` is never crawled.

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

3. **From GitHub, with no local steps** (W13): `.github/workflows/testflight.yml` on
   `workflow_dispatch` calls `ios/fastlane/Fastfile`'s `beta` lane — archive and export with
   the API key signing (`-allowProvisioningUpdates`), then `upload_to_testflight`.

   ```bash
   gh workflow run testflight.yml                      # main
   gh workflow run testflight.yml --ref <branch>       # a branch
   gh workflow run testflight.yml -f changelog="…"     # a What to Test note
   ```

   It needs three repository secrets, all from the same API key the script uses
   (Settings → Secrets and variables → Actions): `ASC_KEY_ID`, `ASC_ISSUER_ID`, and
   `ASC_KEY_P8_BASE64` (`base64 -i ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 |
   tr -d '\n'`). The job fails at its first step naming whichever is missing. A fourth,
   `SUPABASE_ANON_KEY`, is optional: set, the workflow writes `ios/Config/Secrets.xcconfig`
   from it; unset, it falls back to scraping the deployed web bundle
   (`ios/scripts/secrets.sh`), which makes the release depend on the site being up. Either
   way `ios/scripts/secrets.sh --check` asserts the key before anything is built. The lane
   runs on a Mac too — `cd ios && bundle exec fastlane beta dry_run:true` archives and
   exports without uploading — reading the ids from the environment or
   `ios/Config/appstoreconnect.env`.

   Both macOS jobs `xcode-select` to `ios/.xcode-version` first, fastlane is pinned in
   `ios/Gemfile`, and the transitive SwiftPM graph is pinned by `ios/Package.resolved`
   (`ios/scripts/sync-package-resolved.sh` installs it before anything resolves) —
   `ios/CLAUDE.md`, "Toolchain pins".

   The build number is `git rev-list --count HEAD` in both paths, not the workflow's run
   number ([D-034](decisions.md#d-034--the-workflows-build-number-is-the-commit-count-not-the-run-number)).
   The count is monotonic along a branch but not at Apple — a branch that uploaded
   count+3 and then squash-merged leaves `main` at count+1, which App Store Connect
   rejects — so the lane raises it to one past the highest build the version already has
   there, and `-f build_number=357` (`APEX_BUILD_NUMBER=357` for the script and a local
   lane run) stamps a number outright when even that is wrong, which is what a build
   rejected in processing needs.
   The workflow and the Fastfile are HELD paths / release automation: Shane merges changes
   to them with the `shipit` label.
4. Builds expire 90 days after upload — the cadence note is in
   [MASTER.md](MASTER.md#release-cadence).

## App Store gate (W13)

- `PrivacyInfo.xcprivacy` listing required-reason APIs (UserDefaults, file timestamps), and a
  second one for the `ApexWidgets` extension — App Store Connect scans each binary in the
  upload on its own (ITMS-91053), and the extension links neither supabase-swift nor GRDB.
- App Privacy answers: email (account), fitness data the user enters (linked to identity), no
  tracking. HealthKit from 1.1 is write-only (W16 M1), so Health stays "not collected" until W16
  M2 reads workouts.
- Usage strings in `ios/Apex/Info.plist` for everything the app may ask for: from W17,
  `NSSpeechRecognitionUsageDescription` and `NSMicrophoneUsageDescription` (voice set logging,
  D-059). Required even though recognition is on-device only — without them the first
  authorization request crashes the app — and Audio Data stays "not collected" because nothing
  said leaves the phone.
- In-app account deletion (guideline 5.1.1(v)) → `DELETE /api/profile` (W11).
- BYO Anthropic key: the app is fully usable without it; the coach is presented as optional;
  no pricing shown. Review notes explain it and provide a demo account with a key already saved.
- Invite-only sign-up: the sign-in screen states it and gives a contact path rather than a dead
  end.
