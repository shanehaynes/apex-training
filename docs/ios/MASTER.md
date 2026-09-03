# Apex Training — native iOS app

**Start here.** This is the master document for the iOS port. It holds the big picture; the
detail lives in the linked files. If you are a Claude session picking up iOS work, follow the
[session protocol](#session-protocol) below before anything else.

| Document | What it holds |
|---|---|
| [STATUS.md](STATUS.md) | Living board: workstream states, next up, recent sessions |
| [decisions.md](decisions.md) | Every decision with the options and pros/cons that were considered |
| [architecture.md](architecture.md) | Swift app structure, state, navigation, auth, API client, cache, write queue, realtime, coach loop |
| [backend-changes.md](backend-changes.md) | Every API/DB change the port needs, in landing order, with shapes and sizes |
| [design-spec.md](design-spec.md) | Native design spec: palette, type, spacing, motion, component map, icons, charts, app icon brief |
| [screens.md](screens.md) | Screen-by-screen parity map (web → iOS) and the tab/stack navigation model |
| [ux-improvements.md](ux-improvements.md) | The checklist of small and medium improvements over the mobile web, with evidence |
| [testing-and-ci.md](testing-and-ci.md) | What Linux vs Mac sessions can verify, CI jobs, TestFlight, App Store gate |
| [workstreams/](workstreams/) | One self-contained brief per workstream (W0–W13) |

## Vision

A native SwiftUI app with the web app's full functionality and its warm-charcoal look, that is
plainly better on a phone: 44pt targets, native keyboards that never zoom, sheets that drag,
gestures for days and months, a tracker that works in a basement gym with no signal, an elapsed
timer in the Dynamic Island, and a coach you can read. Same backend, same data, same coach.

## Principles

1. **Swift never reimplements anything that has a `__tests__` dir under `src/lib/`.** The
   server owns recurrence, PR detection, stats, alias resolution, analytics compute, prompt
   assembly and tool execution. Swift owns UI state. ([D-008](decisions.md#d-008--where-shared-logic-lives--server-side-behind-the-existing-api))
2. **Parity first, then improvement.** Every web surface in [screens.md](screens.md) ships;
   improvements ride along in the same workstream, never instead of parity.
3. **Aesthetics are generated, not copied.** Tokens come from the web's source files through
   `gen-tokens.mjs`; drift fails CI.
4. **Decisions live in `ApexCore`** so a Linux session can prove them with `swift test`.
5. **Backend before client.** A Swift workstream starts only after the backend PR it consumes
   has merged and its fixtures are committed.
6. **The repo's rules apply unchanged**: worktree per task, claims, HELD paths, `agent:check`,
   phase numbers claimed at PR time. See the root [CLAUDE.md](../../CLAUDE.md).

## Decisions in one glance

| Topic | Decision | Ref |
|---|---|---|
| Stack | Native SwiftUI, iOS 17 floor, Swift 6 | D-000, D-004 |
| Repo | Monorepo, `ios/` directory, XcodeGen, `.xcodeproj` ignored | D-001, D-005 |
| Distribution | TestFlight first, App Store later | D-002 |
| Offline | GRDB read cache + tracker write queue | D-003, D-007 |
| State | MVVM on Observation | D-006 |
| Shared logic | Server-side behind the existing API | D-008 |
| Week view on phone | Omitted | D-009 |
| Appearance | Dark only | D-010 |
| Analytics layout on phone | Editable (reorder + S/M/L) | D-011 |
| Tabs | Schedule · Coach · Analytics · You (Library/Blocks/Meals under You) | D-012 |
| Chat persistence | Local now, server table later | D-013 |
| Chat Markdown | Rendered | D-014 |
| Live Activity | Yes — timer + title | D-016 |
| App icon | New icon on the house palette | D-019 |
| Invite hand-off | Web button + redirectTo | D-020 |

## Architecture in one paragraph

The app reads through Supabase (anon key + JWT under SELECT-only RLS) and three new read
endpoints (`/api/schedule`, `/api/query`, `/api/analytics-compute`), writes only through
`/api/*`, streams the coach over the existing NDJSON protocol, and executes confirmed coach
actions through `/api/coach-tool`. `ApexCore` (SDK-free SwiftPM package) holds models, the API
client, the chat queue, the tracker editor and the write-queue state machine; `ApexPersistence`
(GRDB) holds the cache, the queue and local conversations; `ApexAuth` wraps supabase-swift;
`ApexUI` holds generated tokens, bundled fonts and components; `ApexFeatures` holds one target
per tab or screen family. Full detail: [architecture.md](architecture.md).

## Roadmap

```
Linux (backend)            Mac (Swift)
──────────────             ───────────
W0 read foundation ──┐     W1 scaffold + icon + CI ──┐
                     ├────────────────────────────────┴─▶ W2 schedule (TestFlight 1)
W3 tracker ──────────┼──────────────────────────────────▶ W4 tracker + queue (TestFlight 2) ─▶ W12 Live Activity
W5a chat v2 ─▶ W5b coach-tool ──────────────────────────▶ W6 coach (TestFlight 3) ─▶ W7 events + builder
W8 analytics compute ───────────────────────────────────▶ W9 analytics (needs W6 too)
                                                          W10 library/blocks/meals (after W2)
                                                          W11 profile/integrations/account (after W1)
                                                          W13 release + polish (last) ─▶ App Store
```

Gates: W0→W2, W3→W4, W5a/b→W6, W8→W9, W4→W12. Parallel: W0 ∥ W1; W3 ∥ W2; W5a/W5b/W8 ∥ W4;
W10 ∥ W7/W9; W12 ∥ W7–W11. Migrations: only W11 (`provider_connections.client`, possibly FK
cascades for account deletion). Current state: [STATUS.md](STATUS.md).

## Backlog (deferred on purpose — do not lose these)

- Rest timer between sets (D-015)
- Push notifications: `device_tokens` migration, `/api/devices`, APNs sender from the crons (D-017)
- HealthKit workout write; Apple Watch companion (D-018)
- Server-side `coach_conversations` table for cross-device chat (D-013)
- Light appearance (D-010)
- Week view on phone (D-009)
- Home-screen widget for today's workout
- Web: adopt the new app icon as the favicon; move the volatile schedule block out of the
  chat `system` prompt now that assembly is server-side (see the caching note in `api/chat.ts`)

## Session protocol

1. Read this file, then [STATUS.md](STATUS.md), then exactly one brief in
   [workstreams/](workstreams/). Do not start a Swift workstream whose backend gate is not
   `done`.
2. Branch with `scripts/git-new.sh <type>/<slug> "W<n>: <what you touch>"` (add `--no-install`
   for Swift-only work). The claim names the workstream so other sessions see it.
3. Mac sessions: `cd ios && xcodegen generate` in the worktree; never build in the primary
   checkout. Linux sessions: `swift test --package-path ios/Packages/ApexCore` is your gate for
   `ApexCore`; UI verification is Mac-session work — say so in the PR instead of guessing.
4. Backend changes that a Swift screen consumes ship with fixtures in `ios/Fixtures/` and an
   integration test; the brief's "Backend contract consumed" section is the checklist.
5. Before ending: update the brief's Status and Session log, update
   [STATUS.md](STATUS.md) (state, one line under Recent sessions, Next up), append to
   [decisions.md](decisions.md) if anything was decided, and update the memory entry
   `apex-ios-app-project` if the next step changed.
6. Change this file only when scope, architecture or a principle changes, and note it in the
   changelog below.

## Changelog

- 2026-09-02 — v1. Plan created; all twelve design questions answered by Shane; monorepo
  decided; roadmap W0–W13.
