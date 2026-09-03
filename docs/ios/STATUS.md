# iOS app — status board

Living document. **Every session updates this file before it ends**: flip the workstream's
state, add one line under "Recent sessions", and refresh "Next up". Keep it short; detail
belongs in the workstream brief's session log.

States: `ready` · `in progress (branch)` · `in review (PR #)` · `done (PR #)` · `blocked on …`

| WS | Title | State | Machine | Notes |
|---|---|---|---|---|
| W0 | Backend read foundation | done (PR #95) | Linux | no migration |
| W1 | iOS scaffold + app icon + CI | in review (PR pending) | Mac | two HELD PRs (ci.yml + guard; AASA + vercel.json) |
| W2 | Schedule read, cache, realtime, auth links | blocked on W1 | Mac | first TestFlight with value |
| W3 | Backend tracker consolidation | done (PR #96) | Linux | web switched in the same PR |
| W4 | Tracker UI + write queue | blocked on W1 | Mac | W3 done |
| W5a | Backend chat v2 (server prompt) | done (PR #98) | Linux | web switched in the same PR |
| W5b | Backend `/api/coach-tool` | done (PR #99) | Linux | services extracted; web confirm switched |
| W6 | Coach tab | blocked on W1 | Mac | W5a + W5b done |
| W7 | Event CRUD + builder | blocked on W2 | Mac | W5b done |
| W8 | Backend analytics compute | done (PR #100) | Linux | web keeps its browser path |
| W9 | Analytics tab (editable layout) | blocked on W6 | Mac | W8 done |
| W10 | Library, Blocks, Meals | blocked on W2 | both | small cycle endpoint |
| W11 | Profile, integrations, account | blocked on W1 | both | the only migration (`provider_connections.client`) |
| W12 | Live Activity | blocked on W4 | Mac | |
| W13 | Release + polish | blocked | Mac | App Store gate |

## Next up
1. W2, W4 or W6 on the Mac in any order — every backend gate is merged and W1 gives them the
   app to build in. Remaining Linux work: W10's cycle endpoint, W11's COROS `client:'ios'` migration.
2. Shane: `shipit` on W1's two HELD PRs (ci.yml jobs + the xcodebuild guard rule; AASA +
   vercel.json header), then enable the associated-domains capability on the App ID.
3. Shane: Xcode → Archive → Distribute for TestFlight build 0 (the Release configuration is
   ready; `ios/Config/Secrets.xcconfig` is filled in locally and git-ignored).

## Recent sessions
- 2026-09-02 · plan · Master plan and all briefs written (PR #94).
- 2026-09-03 · W0 · Read endpoints, server-built quick-complete, Swift types emit, fixtures — PR #95 merged.
- 2026-09-03 · W3 · Tracker bootstrap/finish consolidation, streaming coach summary, web switched — PR #96 merged.
- 2026-09-03 · W5a · Server-side prompt assembly, chat v2 body, labelled tool_use events, web switched — PR #98 merged.
- 2026-09-03 · W5b · Services extraction, `/api/coach-tool`, web confirm switched — PR #99 merged.
- 2026-09-03 · W8 · `/api/analytics-compute`, server-side spec validation on save — PR #100 merged.
- 2026-09-03 · W1 · iOS scaffold: two SwiftPM packages, XcodeGen project, sign-in against
  Supabase, four tabs in the house style, generated design tokens, app icon. Sign-in verified
  on iPhone 17 (iOS 26) and iPhone 16 (iOS 18) simulators against the local stack. D-021, D-022.

## Open questions
- (none — all twelve design questions were answered 2026-09-02; see decisions.md)
