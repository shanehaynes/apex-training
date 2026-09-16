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

Snapshot tests are opt-in: their bytes depend on the OS's text rendering, so they are
reviewed by eye on a Mac rather than enforced on a runner. xcodebuild forwards environment
to the test process only under a `TEST_RUNNER_` prefix, so it is
`TEST_RUNNER_APEX_SNAPSHOTS=1 xcodebuild … -only-testing:ApexTests/ScheduleSnapshotTests test`
(the first run records into `ios/ApexTests/__Snapshots__/`, the second compares).

**Do not test auth against a `CODE_SIGNING_ALLOWED=NO` build.** That is what CI builds, and it
is right for CI — but an unsigned app cannot write the Keychain, so the session silently fails
to persist and the app returns to sign-in on every launch. It looks exactly like a session-restore
bug and is not one. Drop the flag (the normal Xcode build signs ad-hoc) whenever you are
checking sign-in, session restore or sign-out.

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

The simulator reaches the API through this worktree's vite server, and it dials `127.0.0.1`.
Node 26 binds vite to `::1` only, so start it as `npm run dev:agent -- --host 127.0.0.1` or
every `/api/*` call fails with "No connection" while the web works fine in a browser.

**Auth links on a simulator.** Mint tokens from the local stack and open the hand-off URL:

```bash
curl -s 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' -H "apikey: $ANON" \
  -H 'Content-Type: application/json' -d '{"email":"agent@apex.local","password":"apex-agent-password"}'
xcrun simctl openurl booted 'apextraining://auth#access_token=…&refresh_token=…&type=invite&expires_in=3600&token_type=bearer'
```

`type=invite|recovery` lands on set-password; an `#error=…&error_code=otp_expired…` fragment
shows the spent-link toast. A signed build (Keychain) is needed for the session to persist.

**Fixtures instead of a backend:** launch with `-apexMockClient` and the app answers every
`/api/*` route from `ios/Fixtures/` in-process (`ios/Apex/Mock/`, DEBUG only), accepts any
credentials, and fixes "today" to 2026-09-08, the day the fixtures put four events on. This is
what the XCUITest smoke runs on, because CI's unsigned build has no Keychain (below).
`-apexMockFail completions` makes `POST /api/completions` answer 500, for the rollback path.
The tracker (W4) is answered too: `bootstrap` → `bootstrap.json` (or `bootstrap-peek.json` with
`peek: true`), `finish` → `finish.json`, `POST /api/coach-summary` → `coach-summary.ndjson`;
`save`/`swap-exercise`/`cancel` → `{"ok":true}`; a non-peek `bootstrap` gets a session started
seven minutes before the fixed clock, so Start Workout opens a live session rather than the
committed (finished) `bootstrap.json`. `-apexMockFailOnce save 3` makes the first three `save`
actions (or a path suffix) answer 500 and then succeed — the write queue's pending → synced path
the smoke asserts on; `-apexMockFail` also matches an action name now.
The Analytics tab (W9) is answered too: `GET /api/analytics-tiles` → `analytics-tiles.json` plus
every save, layout commit and delete the session made; `POST /api/analytics-compute` matches each
spec to a seeded tile and serves that slot of `analytics-compute.json` (index-aligned on purpose),
a draft with no measure → `analytics-compute-preview.json`; `POST /api/analytics-tiles { draft }`
→ `analytics-tiles-save.json` reshaped around the caller's id, draft and layout.
Under the mock an `apextraining://auth#…type=invite` link lands on set-password without GoTrue,
which is how `AuthLinkUITests` covers that screen in CI.
The You tab (W11) is answered too: every profile PATCH is replayed into the next `GET /api/profile`,
tokens minted through `POST /api/mcp-tokens` appear in the list, COROS `connect-start` answers with
the `apextraining://connected` callback itself (so Reconnect needs no browser), `preview`/`apply`
come from their fixtures, and `-apexMockCoros expired` (or `disconnected`) starts the connection in
that state. The emitter's `<timestamp>`/`<uuid>`/`<last4>`/`<token>` placeholders are put back with
stand-ins so dates parse.
The Library (W10) is answered too: `POST /api/query { tool: "search_exercises" }` is built from the
schedule fixture's definitions plus every definition the session added or PATCHed (the fixture's
own stats — last performed, references — decorate the rows it knows), `get_exercise_history` answers
`query-get_exercise_history.json` for Fixture Press by any of its current spellings and the tool's
own 400 for anything else, and `PATCH /api/exercise-definitions?id=` is replayed into both reads with
the handler's rule that a rename appends the old name as an alias.
Blocks (W10) are answered too: `get_training_blocks` is the list fixture plus every block and
objective the session wrote (`current` recomputed for the fixed clock), and with `block_id` the
requested block's summary over `query-get_training_blocks-detail.json`'s progress; `POST
/api/blocks?resource=cycle` answers by spec — the refusal fixture for a blank name, the conflict
fixture for a start inside the seeded base block, else `blocks-cycle.json` re-prefixed with the
caller's name; `?batch=1`, the single POST, PATCH and DELETE are remembered (ids `mock-block-N`),
`POST /api/objectives` mints `mock-objective-N`.

**Realtime on the local stack** needs the tables in the `supabase_realtime` publication —
phase40 adds every table a client subscribes to; a stack reset before it has nothing. The hub
joins one channel per table group on purpose: Realtime gives a join one verdict for all of its
bindings, so one unpublished table silently voids every other binding on that channel. A failed
join is logged under subsystem `com.shanehaynes.apextraining`, category `realtime`
(`xcrun simctl spawn booted log show --last 5m --info --predicate 'subsystem == "com.shanehaynes.apextraining"'`).

Note `//` starts a comment in xcconfig, so URLs are written `http:$(SLASH)$(SLASH)host`.

## TestFlight

`ios/scripts/testflight.sh` archives and uploads without opening Xcode — `--check` verifies
credentials, `--dry-run` archives and exports without uploading. It needs an App Store Connect
API key: the `.p8` at `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8` and the two ids in
`ios/Config/appstoreconnect.env` (git-ignored — see the `.example`). That key also lets
`xcodebuild -allowProvisioningUpdates` create the distribution certificate and profile, so
there is no signing setup to do first.

Uploading publishes a build to Apple. Confirm with Shane before running it without `--dry-run`.

## Regenerating

- `node ios/scripts/gen-tokens.mjs` — after any change to `src/styles/tokens.css`,
  `src/utils/workoutColors.ts` or `src/lib/analytics/palette.ts`. `--check` runs in
  `npm run ci:guards`, so drift fails the build rather than the brand.
- `node ios/scripts/gen-analytics-catalog.mjs` — after any change to `src/lib/analytics/spec.ts`
  (measures, sport blocklist, limits), `src/lib/analytics/labels.ts` (the builder's option
  labels) or `src/utils/workoutColors.ts` (type labels). Writes
  `ApexCore/Analytics/Generated/AnalyticsCatalog.swift`; `--check` runs in `npm run ci:guards`.
- `npm run db:types` — after any migration. It writes
  `Packages/ApexKit/Sources/ApexAuth/Generated/DatabaseTypes.swift` as well as the TS types.
- `node ios/scripts/render-icon.mjs` — after editing `Design/app-icon.svg`.
- `node ios/scripts/gen-avatars.mjs` — after any change to `src/lib/profile/avatars.ts` or
  `src/assets/avatars/*.svg`; writes `ApexUI/Resources/Avatars.xcassets` + `Generated/Avatars.swift`
  (`--check` for drift).
- `npx tsx --tsconfig tsconfig.app.json ios/scripts/gen-connector-figures.ts` — after editing
  `src/components/profile/ConnectorFigures.tsx`; renders the guide's drawings through Playwright
  into `ApexUI/Resources/ConnectorFigures.xcassets` + `Generated/ConnectorFigures.swift`.
- `Fixtures/` come from `api/__tests__/integration/ios-read.integration.test.ts`
  (`APEX_FIXTURES_WRITE=1` to update after a deliberate shape change). Never edit them by hand.
