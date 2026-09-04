# W2 — Schedule: read, cache, realtime, auth links

**Machine:** Mac (+ a small web change) · **Depends on:** W0, W1 · **Unblocks:** W4, W7, W10
**Status:** in review — A0 #110, A #111, B #112 merged; C #114 open; then TestFlight build 1

## Goal
The first vertical slice with daily value: open the app, see today and the month, open a
workout, mark it complete — online or from cache. TestFlight build 1.

## Scope
In:
- Day view (default): paging `WeekStrip`, big date numeral, `EventCard` list (type rail, time,
  title, duration, 44pt completion control), meals summary row; swipe days; long-press → "+".
- Month view: grid, chips, "+N", swipe months; day sheet; Today; segmented Day/Month.
- Event sheet (read): title, date/time, difficulty, exercise sections with supersets and
  climbing/cardio targets, `SyncMetrics` badges from `activity_streams` (direct read), stream
  charts with drag scrub, Mark Complete / Un-complete (`/api/completions` + `quick-complete`),
  Start Workout button (opens W4's tracker; disabled until W4 lands).
- Cache: `schedule_window`, `definitions`, `templates`, `profile` kinds; stale-while-revalidate;
  "cached · updated Xh ago"; pull-to-refresh.
- Realtime hub: schedule tables → debounced refresh; subscribe/unsubscribe on scene phase.
- Deep links: `/auth/callback` + `apextraining://auth` → `session(from:)`; set-password screen;
  recovery `redirectTo`; **web**: "Open in the Apex app" button on invite hash (D-020) and the
  `DEPLOY_MULTI_USER.md` note; extend `scripts/auth-redirect-check.sh`.
Out: editing events (W7), meals composer (W10), tracker (W4).

## Touches
`ios/Packages/ApexFeatures/Schedule/**`, `ApexCore/Models`, `ApexPersistence`, `ApexAuth/RealtimeHub`,
`src/components/auth/LoginView.tsx` (invite button), `DEPLOY_MULTI_USER.md`, `scripts/auth-redirect-check.sh`.

## Backend contract consumed
`GET /api/schedule`, `POST /api/completions`, `POST /api/workout-sessions quick-complete`,
direct reads of `activity_streams`, `profiles`.

## Acceptance
- Fixture-driven snapshot tests: Day (empty / 3 events / completed), Month, Event sheet.
- Airplane mode after one sync: Day and Month render from cache with the affordance;
  completion toggle fails with a clear message (write queue is W4).
- Editing an event on the web updates the phone within ~1s while foregrounded.
- Recovery email link opens the app and lands on set-password; invite link on the web shows
  the hand-off button and the app completes the flow.
- XCUITest smoke covers sign in → today → open event → complete.
- TestFlight build 1.

## Session log
- 2026-09-04 · Mac · Plan and PRs A0 + A. Landing as four PRs: A0 realtime publication
  migration (phase40, HELD); A ApexCore + fixtures + web hand-off (this PR); B Schedule UI,
  cache, realtime, `-apexMockClient` seam; C deep links + set-password. Plan of record:
  `~/.claude/plans/lets-analyze-the-next-temporal-hamming.md` on Shane's Mac.
  - **Corrections to this brief found on the way in:** GRDB was already wired by W1;
    `Endpoint.query` was GET-shaped against a POST-only handler (fixed, `[String: JSONValue]`
    args); `WorkoutEventBase`/`Exercise` lacked every event-sheet field (added: targets,
    supersets, planned sets, climbing pitch fields, sport/subtitle/location/source/template);
    the invite hand-off fragment cannot go through `session(from:)` under PKCE (see D-023 and
    architecture.md §3 — `setSession` instead); schedule tables were in the realtime
    publication only by dashboard state (A0).
  - **ApexCore (Linux-provable):** `Schedule/` — `OccurrenceID`, `DayKey` + `TimeLabel`,
    `ScheduleWindow` (today −60…+120) + `ScheduleCacheKey`, `ScheduleIndex`/`ScheduleEvent`
    (by-day index, web sort order, optimistic `settingCompletion`), `MonthGrid`, `WeekPage`,
    `CompletionRows` (allowlist-pinned), `StaleAffordance`; `Support/RefreshCoalescer`;
    `Auth/DeepLink` + `AuthLinkError`; `Models/ActivityStreams` (+ `SyncMetricsFormatter`,
    `StreamDownsample`, `ActivityStreamsReading`), `Models/Meals`, `Models/JSONValue`,
    `OkResponse`; `Endpoint.completions` / `.workoutSessions`. 83 `swift test` cases.
  - **Fixtures:** three one-off events on 2026-09-08 (run with cardio targets + a synced
    `activity_streams` row, crag with climbing targets and pitches, circuit with a superset and
    planned sets), two meals; new `schedule-empty.json`, `activity-streams.json`,
    `query-get_meals.json`; emitter output sorted so same-day rows cannot "drift".
  - **Web (D-020):** `src/lib/auth/landing.ts` + `OpenInAppButton` on the set-password screen
    (invite/recovery hash) and the sign-in card (`?code=`); `auth-redirect-check.sh` check 2c for
    `apextraining://auth`; `supabase/config.toml` allow-lists the scheme locally;
    `DEPLOY_MULTI_USER.md` updated.
  - **Shane:** add `apextraining://auth` to Redirect URLs; `shipit` #110 and run phase40 in
    the production SQL editor.
- 2026-09-04 · Mac · PR B — the Schedule tab.
  - **ApexUI:** `ApexIcon` (the W2 subset of the lucide map), `EventCard` (3pt rail, mono time,
    44pt toggle), `EventChip` (title only — at ~48pt a cell the web's `time · title` truncates
    to the time), `WeekStrip`, `WorkoutTypeBadge`, `FreshnessBanner`,
    `WorkoutTypeTokens.palette(for:)` with the unknown-type fallback.
  - **ScheduleModel** (`ApexFeatures/Schedule/`): cache → render → `/api/schedule` for
    today −60…+120 → cache; refreshes coalesce (one in flight, one pending); optimistic
    completion (rollback only when `/api/completions` fails; a failed plan-fill keeps the state
    and toasts); the window is written back after a toggle so an offline relaunch shows it;
    meals per month through `get_meals`; streams memoised per occurrence. 11 model tests over a
    scripted transport and `MemoryCacheStore`.
  - **Views:** `ScheduleTab` (period bar, Day|Month, freshness line, sheets at
    `.medium/.large`), `DayView` (week strip, big numeral, cards, meals row; swipe ±1 day, strip
    ±1 week), `MonthView` (≤3 chips + `+N`, swipe ±1 month, 0.28s slide), `DaySheet` (cards
    with the toggle — U7's month path), `EventSheet` (read-only `WorkoutModal`: meta strip,
    targets, `SyncMetricsView`, difficulty, sections with superset rails, disabled Start Workout),
    `StreamChartsView` (Swift Charts: HR line, route `Canvas`, elevation area; drag to scrub).
  - **RealtimeHub** (`ApexAuth`): one channel per table group, `subscribeWithError`,
    suspend/resume with the scene, reset on sign-out. Found on the simulator: one channel with
    every table bound never delivered — the local publication lacked `meals`/`analytics_tiles`
    and Realtime voids the whole join. phase40 (#110) now carries all ten tables.
  - **`-apexMockClient`** (`ios/Apex/Mock/`): fixture-fed transport with remembered
    completions, fixture streams, any-credentials auth, `TestClock` on the fixture day; the
    fixtures ship as a folder reference in Debug (excluded from Release). The XCUITest smoke
    runs sign in → day → month → `+1 more` → day sheet → event → Completed on it, on iPhone 17
    (iOS 26) and iPhone 16 (iOS 18.6). Snapshots recorded (`TEST_RUNNER_APEX_SNAPSHOTS=1`; the
    documented `APEX_SNAPSHOTS=1` never reached the test process).
  - **Verified live** (signed Local build, this worktree's API, local stack): session restore,
    the real schedule for today, and an `UPDATE` to `workout_events` in Postgres reaching the
    simulator within ~4 s.
  - **Not done here:** device runs (Shane), W4's write queue (the toggle is two direct calls
    marked for it), the "+" toolbar menu (W7).
- 2026-09-04 · Mac · PR C — auth links and set-password.
  - `AuthService.handle(_:originalURL:)`: `?code=` → `session(from:)` (PKCE); the web's
    `#access_token…` hand-off → `setSession` (a PKCE client refuses a fragment in
    `session(from:)`); an error fragment → sign-in with the reason. `AuthState.needsPassword`
    is held across every SDK event until `setPassword` lands; the hold is set before the SDK
    is asked so the `SIGNED_IN` that follows cannot skip the screen. PKCE never reports
    `type=recovery` (verified in 2.55.1), so `sendPasswordReset` notes `apex.pendingRecovery`.
  - `SetPasswordView` mirrors the web's, with the acceptance toggle when `/api/profile` says
    the terms are not current (`Endpoint.termsAcceptance`, POST, no body).
  - `AppModel.open(_:)` routes every `DeepLink`: auth → `AuthService`; `/app/event|library` →
    `pendingRoute` for W7/W10; `connected`/`connect_error` → a toast until W11. A link that
    arrives while restoring is parked and replayed. `.onOpenURL` in `ApexApp`.
  - Under `-apexMockClient` an invite fragment lands on set-password without GoTrue;
    `AuthLinkUITests` covers invite → set password → tabs, and the spent-link toast.
  - **Verified live on the simulator (signed build, local stack):** minted tokens opened via
    `simctl openurl` with `type=invite` → set-password → new password → tabs; the
    `otp_expired` fragment → sign-in with the toast.
  - **Not verifiable here:** the real emails (recovery from the app, dashboard invite) — Shane,
    on the phone, after merge; report which recovery path fired (`type=` or the pending note).
