# iOS app — status board

Living document. **Every session updates this file before it ends**: flip the workstream's
state, add one line under "Recent sessions", and refresh "Next up". Keep it short; detail
belongs in the workstream brief's session log.

States: `ready` · `in progress (branch)` · `in review (PR #)` · `done (PR #)` · `blocked on …`

| WS | Title | State | Machine | Notes |
|---|---|---|---|---|
| W0 | Backend read foundation | done (PR #95) | Linux | no migration |
| W1 | iOS scaffold + app icon + CI | done | Mac | TestFlight build 0 (0.1.0/285) shipped and installed |
| W2 | Schedule read, cache, realtime, auth links | in progress (A0 #110 HELD, A #111, B open; C next) | Mac | first TestFlight with value |
| W3 | Backend tracker consolidation | done (PR #96) | Linux | web switched in the same PR |
| W4 | Tracker UI + write queue | ready | Mac | W3 done |
| W5a | Backend chat v2 (server prompt) | done (PR #98) | Linux | web switched in the same PR |
| W5b | Backend `/api/coach-tool` | done (PR #99) | Linux | services extracted; web confirm switched |
| W6 | Coach tab | ready | Mac | W5a + W5b done |
| W7 | Event CRUD + builder | blocked on W2 | Mac | W5b done |
| W8 | Backend analytics compute | done (PR #100) | Linux | web keeps its browser path |
| W9 | Analytics tab (editable layout) | blocked on W6 | Mac | W8 done |
| W10 | Library, Blocks, Meals | blocked on W2 | both | small cycle endpoint |
| W11 | Profile, integrations, account | ready | both | the only migration (`provider_connections.client`) |
| W12 | Live Activity | blocked on W4 | Mac | |
| W13 | Release + polish | blocked | Mac | App Store gate |

## Next up
1. W2 continues on the Mac: PR C (deep links, set-password) on top of B, then TestFlight
   build 1 and Shane's device runs (airplane mode, web edit → phone, recovery and invite links). W4 and W6
   remain open to any other Mac session. Remaining Linux work: W10's cycle endpoint, W11's
   COROS `client:'ios'` migration.
2. Shane: `shipit` #110 (phase40 realtime publication) and run the same file in the production
   SQL editor; add `apextraining://auth` to Supabase → Authentication → URL Configuration →
   Redirect URLs (`scripts/auth-redirect-check.sh` now asserts it).
2. Releases are one command now: `ios/scripts/testflight.sh`. Needs the App Store Connect API
   key (`.p8` in `~/.appstoreconnect/private_keys/`, ids in `ios/Config/appstoreconnect.env` —
   both git-ignored and per-machine).

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

## Open questions
- (none — all twelve design questions were answered 2026-09-02; see decisions.md)
