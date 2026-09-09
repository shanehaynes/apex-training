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
| W4 | Tracker UI + write queue | done (#117, #118, #119) | Mac | TestFlight build 2 (0.3.0/295) uploaded; Shane's airplane-mode device run outstanding |
| W5a | Backend chat v2 (server prompt) | done (PR #98) | Linux | web switched in the same PR |
| W5b | Backend `/api/coach-tool` | done (PR #99) | Linux | services extracted; web confirm switched |
| W6 | Coach tab | done (#126, #127, #128) | Mac | TestFlight build 3 (0.4.0/301) uploaded 2026-09-09; Shane's device run outstanding |
| W7 | Event CRUD + builder | ready | Mac | W2 + W5b done |
| W8 | Backend analytics compute | done (PR #100) | Linux | web keeps its browser path |
| W9 | Analytics tab (editable layout) | ready | Mac | W8 + W6 done |
| W10 | Library, Blocks, Meals | ready | both | small cycle endpoint |
| W11 | Profile, integrations, account | ready | both | the only migration (`provider_connections.client`) |
| W12 | Live Activity | ready | Mac | `ApexWidgets` target; tracker start/finish/cancel hooks are in `TrackerModel` |
| W13 | Release + polish | blocked | Mac | App Store gate |

## Next up
1. Shane's W6 device run on TestFlight build 3 (0.4.0/301): add a key in the sheet, ask the coach
   to create a workout tomorrow → card → Confirm → it appears on Schedule; Stop mid-stream →
   the Vercel log shows the aborted upstream call; kill the app mid-card → relaunch → the card
   comes back. Then W12 (Live Activity), W9 (analytics — now unblocked), W7 or W10.
2. Still open from earlier: the W4 airplane-mode run on build 2; add `apextraining://auth` to
   Supabase → Authentication → URL Configuration → Redirect URLs (`scripts/auth-redirect-check.sh`
   check 2c fails until then); the W2 device runs.
3. Releases are one command: `ios/scripts/testflight.sh` from a worktree that has
   `ios/Config/Secrets.xcconfig` (`ios/scripts/secrets.sh`) and `ios/Config/appstoreconnect.env`
   (`printf` the two ids back after a tidy) — both git-ignored, so never from the primary checkout.

## Recent sessions
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

## Open questions
- (none — all twelve design questions were answered 2026-09-02; see decisions.md)
