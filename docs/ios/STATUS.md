# iOS app — status board

Living document. **Every session updates this file before it ends**: flip the workstream's
state, add one line under "Recent sessions", and refresh "Next up". Keep it short; detail
belongs in the workstream brief's session log.

States: `ready` · `in progress (branch)` · `in review (PR #)` · `done (PR #)` · `blocked on …`

| WS | Title | State | Machine | Notes |
|---|---|---|---|---|
| W0 | Backend read foundation | done (PR #95) | Linux | no migration |
| W1 | iOS scaffold + app icon + CI | ready | Mac | two HELD PRs (ci.yml; AASA + vercel.json) |
| W2 | Schedule read, cache, realtime, auth links | blocked on W1 | Mac | first TestFlight with value |
| W3 | Backend tracker consolidation | in review (PR pending) | Linux | web switched in the same PR |
| W4 | Tracker UI + write queue | blocked on W3 | Mac | |
| W5a | Backend chat v2 (server prompt) | blocked on W0 | Linux | |
| W5b | Backend `/api/coach-tool` | blocked on W5a | Linux | services extraction |
| W6 | Coach tab | blocked on W5a | Mac | actions need W5b |
| W7 | Event CRUD + builder | blocked on W5b, W2 | Mac | |
| W8 | Backend analytics compute | blocked on W0 | Linux | |
| W9 | Analytics tab (editable layout) | blocked on W8, W6 | Mac | |
| W10 | Library, Blocks, Meals | blocked on W2 | both | small cycle endpoint |
| W11 | Profile, integrations, account | blocked on W1 | both | the only migration (`provider_connections.client`) |
| W12 | Live Activity | blocked on W4 | Mac | |
| W13 | Release + polish | blocked | Mac | App Store gate |

## Next up
1. Merge W3; then W5a or W8 on Linux (one at a time — both touch `rateLimit.ts`/`app.ts`). W1 on the Mac can start now.
2. Shane: Apple Developer Program membership; App ID `com.apextraining.app`; add
   `https://apextrainingcalendar.vercel.app/auth/callback` to Supabase Additional Redirect URLs.
3. Shane: merge the two HELD PRs from W1 (ci.yml jobs; AASA + vercel.json header).

## Recent sessions
- 2026-09-02 · plan · Master plan and all briefs written (PR #94).
- 2026-09-03 · W0 · Read endpoints, server-built quick-complete, Swift types emit, fixtures — PR #95 merged.
- 2026-09-03 · W3 · Tracker bootstrap/finish consolidation, streaming coach summary, web switched — PR opened.

## Open questions
- (none — all twelve design questions were answered 2026-09-02; see decisions.md)
