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
| W3 | Backend tracker consolidation | done (PR #96) | Linux | web switched in the same PR |
| W4 | Tracker UI + write queue | blocked on W1 | Mac | W3 done |
| W5a | Backend chat v2 (server prompt) | done (PR #98) | Linux | web switched in the same PR |
| W5b | Backend `/api/coach-tool` | done (PR #99) | Linux | services extracted; web confirm switched |
| W6 | Coach tab | blocked on W1 | Mac | W5a + W5b done |
| W7 | Event CRUD + builder | blocked on W2 | Mac | W5b done |
| W8 | Backend analytics compute | in review (PR pending) | Linux | web keeps its browser path |
| W9 | Analytics tab (editable layout) | blocked on W6 | Mac | W8 in review |
| W10 | Library, Blocks, Meals | blocked on W2 | both | small cycle endpoint |
| W11 | Profile, integrations, account | blocked on W1 | both | the only migration (`provider_connections.client`) |
| W12 | Live Activity | blocked on W4 | Mac | |
| W13 | Release + polish | blocked | Mac | App Store gate |

## Next up
1. Merge W8 — every Swift screen then has its backend gate merged. Remaining Linux work: W10's cycle endpoint, W11's COROS `client:'ios'` migration.
2. W1 on the Mac (Shane setting up); then W2/W4/W6 in any order.
2. Shane: Apple Developer Program membership; App ID `com.apextraining.app`; add
   `https://apextrainingcalendar.vercel.app/auth/callback` to Supabase Additional Redirect URLs.
3. Shane: merge the two HELD PRs from W1 (ci.yml jobs; AASA + vercel.json header).

## Recent sessions
- 2026-09-02 · plan · Master plan and all briefs written (PR #94).
- 2026-09-03 · W0 · Read endpoints, server-built quick-complete, Swift types emit, fixtures — PR #95 merged.
- 2026-09-03 · W3 · Tracker bootstrap/finish consolidation, streaming coach summary, web switched — PR #96 merged.
- 2026-09-03 · W5a · Server-side prompt assembly, chat v2 body, labelled tool_use events, web switched — PR #98 merged.
- 2026-09-03 · W5b · Services extraction, `/api/coach-tool`, web confirm switched — PR #99 merged.
- 2026-09-03 · W8 · `/api/analytics-compute`, server-side spec validation on save — PR opened.

## Open questions
- (none — all twelve design questions were answered 2026-09-02; see decisions.md)
