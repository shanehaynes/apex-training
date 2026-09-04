# W2 — Schedule: read, cache, realtime, auth links

**Machine:** Mac (+ a small web change) · **Depends on:** W0, W1 · **Unblocks:** W4, W7, W10
**Status:** in progress — PR A0 (#110, HELD) and PR A open; B (UI) and C (auth links) next

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
