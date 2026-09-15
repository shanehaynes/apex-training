# iOS app — status board

Living document. **Every session updates this file before it ends**: flip the workstream's
state, add one line under "Recent sessions", and refresh "Next up". Keep it short; detail
belongs in the workstream brief's session log.

States: `ready` · `in progress (branch)` · `in review (PR #)` · `done (PR #)` · `blocked on …`

| WS | Title | State | Machine | Notes |
|---|---|---|---|---|
| W0 | Backend read foundation | done (PR #95) | Linux | no migration |
| W1 | iOS scaffold + app icon + CI | done | Mac | TestFlight build 0 (0.1.0/285) shipped and installed |
| W2 | Schedule read, cache, realtime, auth links | done (#110, #111, #112, #114) | Mac | TestFlight build 1 + device runs are Shane's |
| W3 | Backend tracker consolidation | done (PR #96) | Linux | web switched in the same PR |
| W4 | Tracker UI + write queue | done (#117, #118, #119) | Mac | TestFlight build 2 (0.3.0/295); airplane-mode device run passed 2026-09-11 on build 306 |
| W5a | Backend chat v2 (server prompt) | done (PR #98) | Linux | web switched in the same PR |
| W5b | Backend `/api/coach-tool` | done (PR #99) | Linux | services extracted; web confirm switched |
| W6 | Coach tab | done (#126, #127, #128) | Mac | TestFlight build 3 (0.4.0/301); device run passed 2026-09-11 on build 306, kill-mid-card relaunch included |
| W7 | Event CRUD + builder | done (#137, #138, #139, #140) | Mac | TestFlight build 5 (0.6.0/312) uploaded 2026-09-11; Shane's device run outstanding |
| W8 | Backend analytics compute | done (PR #100) | Linux | web keeps its browser path |
| W9 | Analytics tab (editable layout) | done (#153, #154, #155, #156) | Mac | TestFlight build 6 (0.7.0/324) uploaded 2026-09-14; Shane's device run outstanding |
| W10 | Library, Blocks, Meals | ready | both | small cycle endpoint |
| W11 | Profile, integrations, account | done (#149, #157) | both | on TestFlight build 6; phase41 applied in prod? (Shane); device runs are Shane's |
| W12 | Live Activity | done (#131, #132) | Mac | TestFlight build 4 (0.5.0/306); device run passed 2026-09-11 (30-min background and the Done linger not timed) |
| W13 | Release + polish | blocked | Mac | App Store gate |

## Next up
1. Shane's device runs on TestFlight build 6 (0.7.0/324, carries W9's Analytics tab and W11's
   You tab): W9 (reorder and resize on the phone → the web dashboard shows the new `y/h`; a spec
   the web rejects shows the server's message in the builder; the coach drawer on a real key) and
   W11 (COROS connect inside the app, a sync that fills a planned workout, a bad key's Anthropic
   message). Confirm phase41 is applied in prod. Then W10, W13 after. The W7, W9 and W11
   worktrees can be tidied — the two git-ignored release files die with them (item 3).
2. Still open from earlier: the W2 device runs; two W12 timings nobody has clocked (30 minutes
   backgrounded, the 5-minute Done linger on the Lock Screen).
3. Releases are one command: `ios/scripts/testflight.sh` from a worktree that has
   `ios/Config/Secrets.xcconfig` (`ios/scripts/secrets.sh`) and `ios/Config/appstoreconnect.env`
   (`printf` the two ids back after a tidy) — both git-ignored, so never from the primary checkout.

## Recent sessions
- 2026-09-15 · fix · Build-6 device run: a refused save (blank title) in the tile builder toasted
  under the sheet. Both builder sheets now show the refusal inline above Cancel/Save
  (`saveProblem` / `problem`); `applyDraft` throws instead of toasting.
- 2026-09-14 · W9 · D merged (#156); TestFlight build 6 (0.7.0/324) uploaded — W9 and W11 (#157) both aboard.
- 2026-09-13 · W11 · Mac: the You tab end to end — `YouModel`/`CorosModel`/`ConnectorModel`/
  `ActivityLogModel` over the #149 endpoints, thirteen pushed screens, `ASWebAuthenticationSession`
  connect with the mock's browserless seam, the sync confirmation bottom sheet, the 24 avatars and
  the guide's eight figures generated from the web sources, W11 mock routes, 26 model tests, 20
  snapshots, the `testYouOnFixtures` smoke leg. D-030. PR pending.
- 2026-09-13 · W9 · PR D: three smoke legs (dashboard with a pinned value and edit mode, the
  builder with the coach, the kebab), every tap-then-type in the smoke now waits for keyboard
  focus (the `testCoachKeySetupOnFixtures` flake), 0.7.0, D-029, the architecture/design-spec
  rows, `testflight.sh --dry-run`; build 6 waits on Shane's go.
- 2026-09-13 · W9 · PR C: the tile builder — `TileBuilderModel` with the debounced server preview,
  the series editor with the catalog's dimming, the shared `DraftCoachDrawer`, mock analytics chat;
  10 model tests, 5 snapshots.
- 2026-09-13 · W9 · PR B: the Analytics tab — `AnalyticsModel`, tile cards with Swift Charts
  renderers (tap-to-pin values; drags swallow the page's flick), edit mode, mock routes, 16 model
  tests, 12 snapshots.
- 2026-09-12 · W9 · PR A: `GET /api/analytics-tiles`, draft bodies on tiles POST and compute,
  the generated `AnalyticsCatalog.swift`, the ApexCore analytics layer, seven analytics fixtures.
- 2026-09-11 · W11 · Backend + ApexCore (the Mac builds the You tab in parallel): phase41
  `provider_connections.client`, `connect-start { client: 'ios' }`, a `providerCallback` that
  reads the pending row before every failure branch so a declined or expired iOS connect still
  closes the in-app browser (reasons denied/missing_code/expired/exchange_failed; the web's two
  strings byte-identical), `GET /api/profile` widened to the profiles row + server-composed
  `calendarFeedUrl` + the model catalog, ten first-ever callback tests, six new fixtures on
  agent2 with three new secret/volatility scrubs, and 20 ApexCore endpoints + models + the
  `DeepLink` `reason` fix. 321 `swift test` green in Docker. D-028. Scope items 4 and 5 needed
  no code. PR pending — HELD on the migration.
- 2026-09-11 · device · Shane's run on TestFlight build 4 (0.5.0/306): session restore on a signed
  build; W12 island + long-press + Lock Screen banner, tap-to-open, kill mid-session → relaunch
  from the island (the GRDB cache kept it), finish and cancel both clear it; W4 airplane-mode
  start → finish → sync; W6 coach creates a workout that lands on Schedule, Stop keeps the
  partial; kill mid-card → relaunch → the card comes back. Not timed: the 30-minute background
  and the 5-minute Done linger.
- 2026-09-10 · W7 · Plan (four decisions by Shane) and PR A: `POST /api/workout-draft`, supersets
  normalised in the services, `originalDate` on schedule stubs, regenerated + five new fixtures,
  ApexCore `Repeat`/`Supersets`/`Slug`/`WorkoutDraft`/`ScheduleEdit`/index mutators/W7 endpoints
  and the builder chat path (302 `swift test` green). Web switch filed as #136.
- 2026-09-10 · W7 · PR B: the event sheet's edit paths (rename, native day/time pickers,
  difficulty, Edit exercises, Delete this day / series), the "+" entries, the `/app/event` route,
  `ScheduleModel+Edits`, the sections editor + picker, mock CRUD routes, 12 model tests, 8
  snapshots, the event-edits smoke leg.
- 2026-09-10 · W7 · A merged (#137). PR C: the builder sheet (template search, form, repeat
  picker, coach drawer with the server-side reduce), `BuilderModel`, 8 model tests, 6 snapshots,
  two builder smoke legs.
- 2026-09-10 · W7 · PR D: 0.6.0, D-027, the screens/design-spec rows, `testflight.sh --dry-run`;
  CI dropped one tap in the event-edits smoke, so `openEvent` now re-sends it.
- 2026-09-11 · W7 · D merged (#140); TestFlight build 5 (0.6.0/312) uploaded.
- 2026-09-02 · plan · Master plan and all briefs written (PR #94).
- 2026-09-03 · W0 · Read endpoints, server-built quick-complete, Swift types emit, fixtures — PR #95 merged.
- 2026-09-03 · W3 · Tracker bootstrap/finish consolidation, streaming coach summary, web switched — PR #96 merged.
- 2026-09-03 · W5a · Server-side prompt assembly, chat v2 body, labelled tool_use events, web switched — PR #98 merged.
- 2026-09-03 · W5b · Services extraction, `/api/coach-tool`, web confirm switched — PR #99 merged.
- 2026-09-03 · W8 · `/api/analytics-compute`, server-side spec validation on save — PR #100 merged.
- 2026-09-03 · W1 · iOS scaffold merged across five PRs (#102 app, #103 CI + guard, #104
  universal links, #105 ApexCore Linux fix, #106 export-compliance key). Sign-in verified on
  iPhone 17 (iOS 26) and iPhone 16 (iOS 18.6) against the local stack; the `ios` CI job's first
  real build passed on `macos-26`; the deployed AASA serves 200 as `application/json`.
  D-021, D-022.
- 2026-09-04 · W1 · Acceptance closed: session restore and sign-out verified on a signed build,
  and TestFlight build 0 (0.1.0/285) uploaded headlessly via `ios/scripts/testflight.sh` and
  installed on Shane's phone. W1 is done end to end.

- 2026-09-04 · W2 · Plan; PR A0 (phase40 realtime publication, #110) and PR A (ApexCore
  schedule/deep-link/completion modules, fixtures, web invite hand-off, #111). D-023.
- 2026-09-04 · W2 · PR B: the Schedule tab (Day, Month, day and event sheets, stream charts),
  `ScheduleModel` over the GRDB cache, `RealtimeHub` (one channel per table group — a single
  channel silently dropped everything on a fresh stack), the `-apexMockClient` fixture seam
  the XCUITest smoke now runs on, snapshots recorded. Realtime proved on the simulator against
  the local stack.
- 2026-09-04 · W2 · PR C: `AuthService.handle` for both link shapes, `needsPassword` held
  until a password lands, `SetPasswordView` with the terms toggle, `AppModel.open` routing,
  `AuthLinkUITests` on the mock; invite hand-off and spent link proved on the simulator with
  minted tokens.
- 2026-09-05 · W2 · All four PRs merged (#110, #111, #112, #114); phase40 applied in prod by
  Shane. W7 and W10 unblocked.

- 2026-09-05 · W4 · Plan and PR A: `ApexCore.TrackerEditor` (edits, shadow commits, extra
  sets, swap, zero-fill, row serialisers), `WriteQueue` + `WriteQueueStore` + `RetryPolicy`
  (per-session FIFO, save coalescing, backoff, pause on 401, failed-op surfacing, cancel purge),
  `DurationBuffer`/`CountSpec`/`SessionScore` ports (D-024), tracker `Endpoint`s, a streaming
  seam on `HTTPTransport`/`ApexClient`, backend `bootstrap { peek: true }`, fixtures
  `bootstrap-peek.json` + `coach-summary.ndjson`. 170 `swift test` cases green.

- 2026-09-05 · W4 · PR B: `GRDBWriteQueueStore` + `v2_tracker_ops`, `TrackerModel` over editor +
  queue (render-first open, offline start from a cached peek, 800 ms debounce → queued save,
  finish gate → queued finish + completion, offline finish with "PRs pending sync", cancel
  purge, swap over cached definitions, streamed coach summary with 402/409/in-band degrade),
  the tracker views (`fullScreenCover` from the event sheet's live Start Workout, keyboard
  accessory Next/Done/Use last/Abc·123, keyboard-avoiding confirm bar and score card, summary
  overlay, swap picker, sync strip), peek prefetch in `ScheduleModel`, mock routes, 14 snapshots.
  Proved live on the simulator against the local stack: open → log → finish → server rows,
  autofill and completion all correct.

- 2026-09-05 · W4 · PR C: `WriteQueueDriver` (network path, scene active/background with a
  background task, `BGAppRefreshTask`), `UIBackgroundModes`, the mock's started `bootstrap` and
  `-apexMockFailOnce`, `testTrackerOnFixtures` (event → Start → ghost commits → pending chip
  clears → Finish → confirm → streamed summary → Back), accessibility identifiers scoped with
  `.accessibilityElement(children: .contain)` (an outer identifier otherwise replaces every
  child's). Code complete; TestFlight build 2 waits on Shane's go.
- 2026-09-08 · W4 · A/B/C merged (#117, #118, #119; each squash conflicted the next PR on the
  living docs and the files it layered over — resolved keeping the newer branch's side). TestFlight
  build 2 (0.3.0/295) archived and uploaded via `ios/scripts/testflight.sh`.
- 2026-09-08 · W6 · Plan (four product calls made by Shane: model via `/api/profile`, key sheet
  in W6, Notes = new conversation, Stop keeps the partial) and PR A: `ApexCore.ChatSession` +
  `ActionQueue` (web vectors verbatim) + `ApiMessage` shapes + `MarkdownBlocks` +
  `ConversationStore`, `Endpoint.chat/.coachTool/.setAnthropicKey`, `GET /api/profile`
  `coachModel`/`coachModelLabel` + regenerated `profile.json`. 246 `swift test` green. D-025.
- 2026-09-08 · W6 · PR B: `v3_conversations` + `GRDBConversationStore`, `CoachModel` (event-fed
  mirror with a marker-drained sync), the Coach tab (thread, Markdown, cursor, card, composer,
  conversations, Notes, model badge), `AnthropicKeyView`, chunked mock `/api/chat` +
  `/api/coach-tool` + `-apexMockHasKey`; 88 unit + 15 snapshots green; proved live on the
  simulator under the mock.
- 2026-09-08 · W6 · PR C: `testCoachOnFixtures` + `testCoachKeySetupOnFixtures` (screenshots
  11–16), 0.4.0, TestFlight dry-run archive green; upload and device run left for Shane.
- 2026-09-09 · W6 · A/B/C merged (#126, #127, #128; each squash conflicted the next because the
  stacked branch still carried the lower commit — `git rebase --onto origin/main <old-tip>` each
  time). TestFlight build 3 (0.4.0/301) uploaded via `ios/scripts/testflight.sh`. W9 unblocked.
- 2026-09-09 · W12 · Plan and PR A: `ApexActivity` package target (attributes with ids, content
  state with a reserved rest-timer field, island + Lock Screen views), `ApexWidgets` extension,
  `NSSupportsLiveActivities`, versions moved to project level, 4 snapshots. Found: `pendingRoute`
  is never consumed and the custom scheme has no `app` host — both land in PR B. Dry-run archive
  signed both bundles. PR A is #131.
- 2026-09-09 · W12 · PR B: `DeepLink.tracker` + scheme `app` host, `TrackerActivityPublishing`
  seam + stateless `LiveActivityController`, the three `TrackerModel` hooks, `RouteBus` (the
  first `pendingRoute` consumer) + `RootTabView` selection + `ScheduleTab` consumer, relaunch
  adopt/end, sign-out `endAll`, 0.5.0, D-026. Proved on the simulator under the mock: compact,
  expanded, Lock Screen, tap-to-open warm and cold, relaunch reconcile, Done on the Lock Screen.
- 2026-09-09 · W12 · A (#131) and B (#132) merged via the babysitter; B needed the
  `git rebase --onto origin/main <old-A-tip>` after A's squash, as W6 did. 0.5.0 is on main;
  the TestFlight upload waits on Shane.
- 2026-09-09 · W12 · TestFlight build 4 (0.5.0/306) uploaded via `ios/scripts/testflight.sh`
  from the W12 worktree, detached at main (2158e2b, which includes the #129 web dependency bump).
- 2026-09-09 · Shane added `apextraining://auth` to the Supabase Redirect URLs;
  `scripts/auth-redirect-check.sh` passes all five checks.

## Open questions
- (none — all twelve design questions were answered 2026-09-02; see decisions.md)
