# Architecture

The iOS app is a second client of the existing backend. It reads through Supabase (anon key +
user JWT, SELECT-only RLS) and the new read endpoints, and writes only through `/api/*` with the
Supabase access token as bearer — exactly the web's posture (`api/_lib/auth.ts` `requireUser`,
column allowlists in `api/_lib/allowlist.ts`). Everything below follows from three rules:

1. **Swift never reimplements anything that has a `__tests__` dir under `src/lib/`** (D-008).
   Recurrence, PR detection, period stats, block progress, alias resolution, analytics compute,
   coach prompt assembly and coach tool execution all run on the server. Swift owns UI state.
2. **All decisions live in `ApexCore`**, a SwiftPM package with no Apple-only imports, so a Linux
   session can run `swift test`.
3. **The `.xcodeproj` is generated** (XcodeGen) so parallel worktrees never conflict on it.

## 1. Targets and packages

```
ios/
  project.yml                    XcodeGen spec: Apex (app), ApexWidgets (W12), ApexTests, ApexUITests
  Apex/                          @main App, AppDelegate (scene/URL routing), Info.plist keys,
                                 entitlements (associated domains), Assets (AppIcon only)
  Design/                        app icon source (SVG) and export notes
  Fixtures/                      JSON/NDJSON emitted by the web repo's vitest (contract tests)
  Packages/
    ApexCore/                    Linux-buildable. NO UIKit / SwiftUI / supabase-swift.
      Models/                    Codable mirrors of API JSON (WorkoutEvent, Exercise, PlannedSet,
                                 TrackedSectionGroup, ChartSpec, TileData, PersonalRecord, Meal,
                                 TrainingBlock, Profile, …) — snake_case via a shared decoder
      Generated/DatabaseTypes.swift   supabase gen types --lang=swift (row types for direct reads)
      API/                       ApexClient (actor), Endpoint enum, APIError, NDJSON line parser,
                                 ChatWireEvent
      Coach/                     ApiMessage blocks, PendingAction, ActionQueue (settleHead /
                                 appendUserText), ChatSession state machine, Markdown block model
      Cache/                     CachePolicy, CacheStore + WriteQueueStore protocols, WriteQueue
                                 actor (pure state machine), Clock protocol
      Tracker/                   TrackerEditor: in-memory edits, dirty keys, shadow commit,
                                 debounce policy, setToRow / cardioToRow, collectUntouchedPlanned
      Schedule/                  OccurrenceID (`${baseId}__${date}`), Repeat (repeat.ts port),
                                 month/day layout math
      Analytics/                 palette, unit + number formatting
    ApexPersistence/             Apple-only: GRDB implementation of CacheStore / WriteQueueStore /
                                 ConversationStore
    ApexAuth/                    Apple-only: supabase-swift Auth + Realtime wrapper, Keychain,
                                 TokenProvider, RealtimeHub (debounced table-change stream)
    ApexUI/                      design system: Tokens.swift (generated), Colors.xcassets, fonts,
                                 Avatars.xcassets, components (Card, Chip, Segmented, WorkoutTypeBadge,
                                 ConfirmBar, Toast, SheetHeader, …)
    ApexFeatures/                one target per feature: Schedule, Tracker, Coach, Builder,
                                 Analytics, Library, Blocks, Meals, Profile, Sync, Onboarding
  scripts/
    gen-tokens.mjs               tokens.css + workoutColors.ts + palette.ts → ApexUI/Tokens.swift (--check)
    screenshots.sh               simulator boot + XCUITest smoke + collect attachments
  fastlane/                      beta lane (W13)
  CLAUDE.md                      what Linux vs Mac sessions can verify; local loop; never build in the primary checkout
```

Build settings: iOS 17.0 floor (D-004); Swift 6 language mode; `SWIFT_DEFAULT_ACTOR_ISOLATION =
MainActor` for app and feature targets; `ApexCore` strict without the default (it has its own
actors). Dependencies: `supabase-swift`, `GRDB.swift`, `swift-snapshot-testing` (tests only).
Nothing else unless a brief argues for it.

## 2. State management — MVVM on Observation (D-006)

- `AppModel` (`@Observable @MainActor`) in the environment: auth state, `ApexClient`, cache,
  write queue, realtime hub, toast bus, deep-link router.
- One view model per screen, created by the screen, taking `ApexClient`-conforming and
  `Clock`-conforming protocols so tests inject fakes.
- Cross-cutting stateful pieces are actors in `ApexCore`: `WriteQueue`, `ChatSession`.
- Toasts: a module-level `ToastBus` (like `src/lib/notify.ts`) so non-view code can post.

## 3. Navigation (D-012)

```
TabView
 ├─ Schedule  NavigationStack<ScheduleRoute>   Day (default) ⇄ Month · event detail (sheet, detents .medium/.large)
 │                                              · day sheet (events + meals + macro rollup) · tracker (fullScreenCover)
 ├─ Coach     NavigationStack<CoachRoute>      thread · conversation list (D-013) · key setup
 ├─ Analytics NavigationStack<AnalyticsRoute>  dashboard (+ edit mode) · tile builder (sheet .large) · analytics coach (inside builder)
 └─ You       NavigationStack<YouRoute>        profile sections · Library → definition → editor · Blocks → detail/editor/cycle
                                               · Meals (day list, composer sheet, favorites) · COROS · MCP tokens · Anthropic key + model · account
```

- Builder and meal composer are sheets (`.large` detent, non-interactive dismiss while dirty).
- The tracker is a `fullScreenCover` — like the web's fixed overlay, it is a mode, and rotating
  the device or backgrounding must never dismiss it.
- Typed routes make every screen deep-linkable. `DeepLink` parses both `apextraining://…` and
  universal links on `apextrainingcalendar.vercel.app`:
  - `/auth/callback#…` → `auth.session(from:)` (recovery, invite)
  - `apextraining://auth#…` → same (web hand-off button, D-020)
  - `apextraining://connected?provider=coros` / `…/connect_error` → COROS result (W11)
  - `/app/event/<id>/<date>`, `/app/library/<definitionId>` → routes (future share links)
- AASA at `public/.well-known/apple-app-site-association` with `applinks` limited to
  `/auth/*` and `/app/*` (never `/` — every shared web link would open the app) and
  `webcredentials` for Password AutoFill. `vercel.json` needs a `content-type: application/json`
  header for that path (HELD file → Shane merges).

## 4. Auth (`ApexAuth`)

- `supabase-swift` `AuthClient` with Keychain storage (SDK default on Apple), `flowType: .pkce`.
- `TokenProvider` protocol (`func accessToken() async throws -> String`) is all `ApexCore`
  sees. 401 from the API → refresh once → retry once → sign out with a "session expired" state.
  Never loop.
- Sign in: email + password, `textContentType` set so AutoFill + Face ID work; the associated
  domain makes saved web credentials appear.
- Invite/recovery: `resetPasswordForEmail(redirectTo: "https://apextrainingcalendar.vercel.app/auth/callback")`
  (Shane adds that URL to Supabase Additional Redirect URLs; extend
  `scripts/auth-redirect-check.sh` to assert it). Invites are dashboard-generated at the Site
  URL root → the web root shows "Open in the Apex app" when the hash carries `type=invite`.
- Set-password screen for `needsPassword` (invite / recovery) mirrors `SetPasswordView.tsx`.
- Realtime channels need the JWT: `realtime.setAuth(token)` after every refresh.

## 5. API client (`ApexCore.ApexClient`)

- Base URL from build configuration (`Release` → prod; `Local` → the worktree's dev port and the
  local Supabase stack; never prod Supabase from a simulator).
- Injects `Authorization: Bearer <token>` and `Content-Type: application/json`; snake_case
  decoding; ISO dates as `YYYY-MM-DD` strings (never `Date`) to match the API.
- `APIError`: `.unauthorized`, `.missingAnthropicKey` (402), `.payloadTooLarge` (413),
  `.rateLimited(retryAfter:)` (429), `.server(status, message)`, `.network(URLError)`,
  `.decoding(context)`. Chat surfaces 402/429 inline (like `useChat.ts`); everything else toasts.
- Streaming: `URLSession.bytes(for:)` → `.lines` → decode one `ChatWireEvent` per line →
  `AsyncThrowingStream`. Task cancellation cancels the request, which trips `res.on('close')`
  in `api/chat.ts` and aborts the upstream Anthropic call.
- Rate-limit etiquette: never poll. Refresh on foreground and on realtime events only.

## 6. Read cache (`ApexPersistence`, GRDB — D-007)

Single SQLite file in Application Support, excluded from iCloud backup.

```
cache(kind TEXT, key TEXT, json BLOB, fetched_at REAL, PRIMARY KEY (kind, key))
```

Kinds: `schedule_window` (the `/api/schedule` response for `[today-60d, today+120d]`),
`definitions`, `templates`, `blocks`, `objectives`, `meals_window`, `profile`,
`analytics_tiles`, `analytics_result:<tileId>`, `tracker_bootstrap:<eventId>|<date>`.

Policy (`ApexCore.CachePolicy`): stale-while-revalidate. Render the cached value immediately,
refresh on `.active` and on a debounced realtime event, and show "cached · updated 3h ago" when
`fetched_at` is older than an hour **and** the last refresh failed. No local RRULE expansion:
the schedule window is the cache; a phone offline past the horizon shows "schedule cached
through <date>".

Conversations (D-013): `conversations(id, mode, title, created_at, updated_at)` and
`messages(id, conversation_id, role, api_content_json, display_text, created_at)`, shaped like
the future server table.

## 7. Tracker write queue

```
tracker_ops(id INTEGER PRIMARY KEY, event_id, event_date, action, payload BLOB,
            created_at REAL, attempts INT, last_error TEXT, state TEXT)
```

- FIFO **per (event_id, event_date)**; a `WriteQueue` actor in `ApexCore` over a
  `WriteQueueStore` protocol.
- Coalescing mirrors the web's `dirtySetsRef` + 800ms `AUTOSAVE_DEBOUNCE_MS`: edits accumulate
  in memory, then one `save` op with `setLogs / cardioLogs / removedSets`. If the previous op for
  the same session is an unsent `save`, merge (last write per set key wins; `removedSets`
  concatenated) so a long offline session leaves a short queue.
- Idempotency: `save` is already an upsert on
  `(user_id, event_id, event_date, section, exercise_id, set_number)` with server-stamped
  `updated_at`. `start {startedAt}` and `finish {finishedAt}` (backend change, W3) let a delayed
  flush stamp real times. `cancel` purges queued ops for the session before enqueueing itself.
- Flush triggers: `NWPathMonitor` satisfied; `scenePhase == .active`; `scenePhase == .background`
  → `beginBackgroundTask` + immediate flush (the `visibilitychange` analog); a registered
  `BGAppRefreshTask` for opportunistic flushes.
- Failure classes: network / 5xx / 429 → retry with backoff; 401 → refresh token then retry;
  other 4xx → mark `failed`, surface in the tracker ("2 sets could not be saved — retry"), never
  drop silently.
- Conflicts: tracker tables are not realtime-subscribed (same as web); two devices on one
  session → last write per set wins. The session's finished/cancelled state is refreshed from
  `bootstrap` when the tracker opens.
- Finish offline: allowed. `collectUntouchedPlanned` runs on the in-memory groups (needs unsaved
  edits, exactly like the web); the summary shows "PRs pending sync" until the `finish` flush
  returns `prs` and `recap`.

## 8. Realtime (`ApexAuth.RealtimeHub`)

One channel with `postgresChange(AnyAction.self, schema: "public", table:)` for
`workout_events`, `recurring_exceptions`, `exercise_definitions`, `workout_templates`
(matching `ScheduleContext`), plus `training_blocks`, `objectives`, `meals`, `meal_favorites`,
`analytics_tiles`. Events feed an `AsyncStream` debounced 250ms (Supabase emits one event per
row) → one window refresh per table group. Subscribe on `.active`, unsubscribe on `.background`;
the foreground refresh covers what was missed.

## 9. Coach loop (after W5a/W5b)

```
Swift                                  Server
──────                                 ──────
POST /api/chat {mode, messages,        builds system prompt (context.ts) → Anthropic stream
  withTools:true, today}          ←──  NDJSON: text deltas · tool_use {id,name,input,label} · done
render text; queue tool_uses
show card for head action (label)
Confirm → POST /api/coach-tool         executes tools.ts executor with server deps,
  {toolUseId,name,input,today}    ←──  {resultText} (or {resultText, draft} for draft tools)
settleHead(resultText)
… until queue drains, then
POST /api/chat {…, withTools:false,    tools-off follow-up stream
  messages + ONE user tool_result msg}
```

Swift implements only `ApiMessage` shapes, `appendUserText` folding, `toPendingActions`,
`settleHead`, the tools-off follow-up, 402/429 inline states, and Stop. The builder and
analytics coaches are the same loop with `mode: 'builder' | 'analytics'` and the current draft in
`context.draft`; their single tool reduces server-side and returns the next draft, so the Swift
forms are views over JSON drafts they never validate themselves.

## 10. Charts

Swift Charts over the server's `TileData`: `line`/`area` → `LineMark`/`AreaMark` with series
split at `nil` (gaps), `bar`/`stacked-bar` → `BarMark` with `.foregroundStyle(by:)`, `kpi` and
`table` are plain views. House style from `TileRenderer.tsx`: no axis lines, no tick lines, no
grid, no animation, 10pt ticks, legend only when >1 series. Palette from `palette.ts` via the
token generator. Value inspection by tap/scrub (`chartOverlay` + `DragGesture`).

## 11. Design system (`ApexUI`)

- `ios/scripts/gen-tokens.mjs` reads `src/styles/tokens.css`, `src/utils/workoutColors.ts`
  and `src/lib/analytics/palette.ts` → `Tokens.swift` (colours as `Color(hex:)`, radii,
  durations, type scale); `--check` in CI. The brand should fail a build when it drifts.
- Dark only (D-010): `.preferredColorScheme(.dark)`, `UIUserInterfaceStyle = Dark`.
- Fonts: Inter, JetBrains Mono, Barlow Condensed (all SIL OFL) bundled in `ApexUI` resources,
  registered via `UIAppFonts`; `Font.apex(.display|.mono|.wordmark, size:, weight:)` with
  `relativeTo:` for Dynamic Type.
- Avatars: the 24 SVGs from `src/assets/avatars/` in `Avatars.xcassets` (Preserve Vector Data).
- Full spec: [design-spec.md](design-spec.md).

## 12. Live Activity (W12, D-016)

`ApexWidgets` extension target; `ActivityAttributes { title: String }`, `ContentState
{ startedAt: Date, exerciseCount: Int? }`. The system renders the elapsed timer from the date
(`Text(timerInterval:)`), so no periodic updates. Start on tracker open, end on finish/cancel
with a final "Done · 42:10" state. Compact: timer; minimal: icon; expanded: title + timer.
Pair with `isIdleTimerDisabled` while the tracker is frontmost.

## 13. Type and contract sync (three CI-checked mechanisms)

1. `scripts/db-types.sh` emits both `src/lib/db/database.types.ts` and
   `ios/Packages/ApexCore/Sources/ApexCore/Generated/DatabaseTypes.swift`; `--check` covers both.
2. The fixture emitter vitest writes `ios/Fixtures/*`; `swift test` decodes them; `--check`
   fails on uncommitted drift.
3. `gen-tokens.mjs --check`.
No TS→Swift codegen of `src/types/workout.ts`; the fixture contract catches the same drift with
far less machinery.
