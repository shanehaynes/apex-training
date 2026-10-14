# Improvement doc 3 — platform and reach

**Date:** 2026-10-13 · **Status:** proposal; corrected 2026-10-14 against main — §1 largely
superseded by W16 · **Scope:** integrations, iOS native surface, web platform, account, sharing
**Source:** a feature-gap review of the whole repo. This doc covers what sits around the product
rather than inside it: where data comes from, where the app can live, who can get in, and whether
anything can be shared.

Most of these only matter if Apex is a product rather than one athlete's log. Each item says
which identity it serves. Sizes as in doc 1 (S / M / L). **The product rows wait on one decision
that is Shane's: whether signup opens.** While production stays invite-only, only the rows marked
personal, and the correctness fix in §4, earn their cost.

A day after it was written, W16 (Apple Health, D-056) took over most of §1, and the core-loop
fleet shipped a weight-unit setting. Evidence was re-checked against main on 2026-10-14; changes
are marked inline as *Corrected:*.

## 1. One integration, activities only — **P1 (product) · mostly W16**

**Evidence.** `SyncProvider = 'coros'` ([providers/connection.ts:17](../../api/_lib/providers/connection.ts));
the DB check constraint allows only `coros` (phase27). Garmin and Apple exist only as values of an
event's `source` ([workout.ts:198](../../src/types/workout.ts)); *Corrected:* Strava is not one of
them. A FIT decoder exists for COROS. Per activity Apex takes sport, time, distance, elevation, HR,
calories and streams ([coros/client.ts:23-42](../../api/_lib/providers/coros/client.ts)).
*Corrected:* per-activity HRV and training load are not lost. They travel in `summaryExtras` into
the stored summary and reach `computeLoad` and the coach
([coach/physiology.ts:53-54](../../api/_lib/coach/physiology.ts)). What Apex never fetches is
COROS's *daily* data: the client calls three activity tools and nothing for sleep or daily HRV. Disconnect cannot revoke the grant
at COROS ([providerSync.ts:108](../../api/_lib/handlers/providerSync.ts)). Matching requires the
same local day and a compatible type ([sync/matching.ts:43-45](../../src/lib/sync/matching.ts)).

**Owned by W16** ([W16-apple-health.md](../ios/workstreams/W16-apple-health.md), D-056, which
supersedes D-018), so not repeated here:
- HealthKit read as provider `apple` on the provider-sync rails (M0, M2b, M2i).
- HealthKit write of finished workouts (M1, merged #430). *Corrected:* it writes no energy, so it
  does **not** close Activity rings, by design.
- A `daily_metrics` table and sleep, HRV, resting HR, steps and body mass for the coach (M3b,
  M3i); body weight both ways.
- No Watch app and no GPS routes (D-056, "not now").

*Corrected:* W16 ships write first, then read. This doc had the order reversed.

**Fix — what W16 leaves open.**
1. Fetch COROS daily sleep and HRV into W16's `daily_metrics`, if COROS's API exposes them (not
   checked). This is a new fetch, not a parse, since W16 fills `daily_metrics` from Apple only.
   Per-activity load already feeds `computeLoad` and should stay there (W16 decision 8). (M, if
   the endpoint exists)
2. Strava or Garmin direct, only if Health does not reach the users who ask. (L per provider)

*Corrected:* the ±1-day matching tolerance is dropped. `matching.ts:9-10` refuses day fuzz on
purpose: the local day comes from the connection's timezone, and that conversion is the source of
truth. That splits the original item in two:
- Timezone crossings are a stale connection timezone, which is §4's fix.
- A session planned for 23:30 that starts at 00:05 stays unmatched. That is accepted by design;
  it imports standalone. A matcher test should pin it either way.

## 2. The calendar feed is a title and a time — **P2 · S**

**Evidence.** Each VEVENT carries UID, DTSTAMP, DTSTART/DTEND, SUMMARY, LOCATION, RRULE, EXDATE
and nothing else ([calendar-feed.ts:164-208](../../api/calendar-feed.ts)). There is no DESCRIPTION,
no VALARM and no completion state, and times float by design (:48-50). `ics_token` is never
client-writable and has no rotate endpoint ([profile.ts:15-18](../../api/_lib/handlers/profile.ts)).

**Fix, in this order.** First, a "Rotate link" button that rewrites `ics_token`. The feed URL is a
bearer credential, and today a leaked one cannot be revoked; the next item makes leaking it cost
more, so rotation ships first or alongside. Then a DESCRIPTION with the exercise list and a deep
link; an optional VALARM offset chosen in Profile; and `STATUS:COMPLETED` or a ✓ prefix on done
occurrences. Each is S, and the feed is one file.

## 3. iOS native surface — **P1 (product) · S–L**

**Evidence.** No home-screen widget: the widget bundle holds only the Live Activity
([ApexWidgetsBundle.swift:21](../../ios/ApexWidgets/ApexWidgetsBundle.swift)). There is no
user-facing push (APNs only ends the Live Activity, D-051), no Sign in with Apple
([app-store.md:53](../ios/app-store.md)), no biometric lock, no Siri/App Intents and no Spotlight.
The app is portrait-only and dark-only ([Info.plist:30-36](../../ios/Apex/Info.plist)) and
iPhone-only ([project.yml:94-96](../../ios/project.yml), reasoned from D-009's phone-only spec). Coach threads on the phone never
meet the web's (D-013): the server table landed in #303, and iOS sync is still backlog.
*Corrected:* "no HealthKit" no longer holds; see §1 and W16. No Watch app is a decision (D-056).

**Fix, in order.**
- A today's-workout widget for the home screen and Lock Screen, with a Start link (M). The
  schedule cache is on the device but in the app's own container
  ([Database.swift:52](../../ios/Packages/ApexKit/Sources/ApexPersistence/Database.swift)); no App
  Group exists, so the widget needs one on both targets, or a snapshot the app writes into a group
  container (HELD: entitlements, project.yml). The only tracker deep link is
  `tracker/<id>/<date>` ([DeepLink.swift:25](../../ios/Packages/ApexCore/Sources/ApexCore/Auth/DeepLink.swift)),
  so the widget has to resolve today's occurrence itself.
- App Intents: "Start today's workout", "Log a meal", "What's on today" (M). Siri and Shortcuts
  come with them.
- Sign in with Apple (M; Supabase supports it). Apple requires it only if a third-party login
  exists, so it is optional today, but it is the lowest-friction invite path once signup opens.
- A biometric app lock behind a toggle (S).
- D-013 thread sync (M).
- iPad layout and landscape (L). The design spec is phone-only (project.yml cites D-009); revisit only
  if iPad users appear.

*Corrected:* push is not listed as a fix here. Doc 2 §4 owns the channel, and D-017 ("none for
now") is still a live decision, so pursuing push means revisiting D-017 first.

## 4. Web platform — **P1 for timezone · P2 for the rest · S each**

**Evidence.**
- There is no manifest or service worker; `public/` has none.
- The web app is dark-only: there is one `:root` palette ([tokens.css:3](../../src/styles/tokens.css))
  and no `prefers-color-scheme` anywhere. D-010 says "for now".
- Weeks start on Monday, hard-coded in [dateHelpers.ts:10](../../src/utils/dateHelpers.ts) (and
  also at :21, :51, :66), in `calendar/copy.ts`, `physiology/compute.ts` and `coach/prompt.ts`.
- *Corrected:* units are no longer simply imperial. Weight is a profile setting (`weight_unit`,
  phase55, #420/#421). Distance has no preference, only a mi/km toggle per form that defaults to
  mi, and numbers are formatted as `'en-US'` in six places.
- There is no timezone setting. "Today" in the app is the browser clock
  ([clock.ts:16-23](../../src/lib/clock.ts)), and the server has no user timezone
  ([mcp/data.ts:250-253](../../api/_lib/mcp/data.ts)). Where that bites:
  - **MCP**: when a client omits `today`, three tools fall back to UTC (`writeTools.ts:58`,
    `tools/sessions.ts:49`, `tools/blocks.ts:105`).
  - **Reflection cron** (05:00 UTC): it reflects on `yesterdayUtc`
    ([reflection/inputs.ts:64](../../api/_lib/reflection/inputs.ts)). Sessions are matched on
    that date, but chat messages on a UTC window. In the Americas the date is right but the chat
    window is shifted by hours, and in Pacific or Hawaii time the day is not over yet when the
    cron runs.
  - **Template copy**: clients that send no start date (older iOS builds) get their starter block
    anchored on UTC today ([templateCopy.ts:22](../../api/_lib/handlers/templateCopy.ts)).
  - **Provider cron**: it falls back to `'UTC'` when a connection has no timezone
    ([providerCron.ts:72](../../api/_lib/handlers/providerCron.ts)), and a connection's timezone
    is refreshed only by a manual sync.
  - Not affected: in-app chat, analytics and the weekly review, which require the client's
    `today`. The review cron runs at 14:00 UTC, when the UTC date equals the local date from
    UTC-12 to UTC+9, so its UTC periods are a near miss rather than a bug.
- Escape is the only shortcut ([useModalChrome.ts:18](../../src/hooks/useModalChrome.ts)).

**Fix.** The first item is a correctness bug and leads the sequencing. The rest are polish.
- **`profiles.timezone`, captured at sign-in and refreshed when the browser's zone changes** (S +
  migration, HELD). Use it in the MCP fallbacks, the reflection cron's day and chat window, the
  template copy fallback, and as the provider cron's fallback.
- A manifest plus a cache-shell service worker, so the web app installs on Android and desktop (S).
- `week_start` and a distance unit next to `weight_unit` (S).
- A light theme through the existing token layer (M).
- A handful of shortcuts: `t` today, `←/→` period, `n` new workout, `/` coach (S).

## 5. Account, security and support — **P1 (product) · S–M**

**Evidence.**
- Sign-in is email + password only ([AuthContext.tsx:137](../../src/context/AuthContext.tsx)).
- There is no MFA.
- Password change does not ask for the current password
  ([ProfileView.tsx:159-168](../../src/components/profile/ProfileView.tsx)). The local
  `secure_password_change` is `false` and `double_confirm_changes` is `true`
  ([config.toml:233-237](../../supabase/config.toml)); production's dashboard values are unchecked.
- The email address cannot be changed.
- There is no self-serve signup or waitlist. Production signup is off, and the only door is a
  dashboard invite ([DEPLOY_MULTI_USER.md](../../DEPLOY_MULTI_USER.md)).
- There is no in-app feedback or support surface on the web. The address
  `support@apex-training.app` already exists and forwards to Shane, and iOS links it for invite
  requests.
- The error boundary offers Reload only and reports nowhere.

**Fix.**
- **Re-authenticate before a password change** (S). Either ask for the current password and
  verify it by signing in, or turn on `secure_password_change` and add the client's
  `reauthenticate()` nonce step. The setting alone is not enough: `setNewPassword` sends no nonce.
- **Email change** through Supabase's double confirmation (S). Check that production has
  `double_confirm_changes` on, as the local config does.
- **TOTP MFA** behind a toggle (M; Supabase supports it).
- **A request-access form** that writes to a `waitlist` table and emails Shane (S). The invite-only
  stance stays; the funnel becomes visible.
- **Support link and feedback.** Add a support@ line to the help index (S, no new code paths).
  Help components belong to the onboarding board
  ([docs/onboarding/MASTER.md](../onboarding/MASTER.md)), so it goes through that board. Then, if
  needed, a "Send feedback" row in Profile.
  - *Corrected:* there is no existing client-side error-report webhook to post to.
    `api/_lib/errorReport.ts` is server-only and off unless `APEX_ERROR_WEBHOOK_URL` is set.
  - The feedback row needs its own route (S–M).
  - It should carry only the user's own words, the app version, the route and the user agent.
    Console lines are out: they carry Postgres error text with row values
    ([api.ts:69](../../src/lib/api.ts)), which would break errorReport's "nothing from the
    request" rule.

## 6. Sharing and roles — **P2 (product) · decision, then L**

**Evidence.** The single cross-user flow is the one-time starter-plan copy
([templateCopy.ts:10](../../api/_lib/handlers/templateCopy.ts)). No shared templates, no public
profile, no coach-to-client role, no friends.

**Options.**
1. **Share a template or block by link** — read-only, copy-on-accept, the smallest useful
   social surface and the one a climbing partner actually asks for (M).
2. **Coach–client role** — a human coach sees a client's calendar and logs, proposes through the
   same confirm cards the AI uses. This reuses the whole mutation and audit path and is the
   natural product expansion; it is also an RLS redesign (L, migration, HELD).
3. Nothing — defensible while invite-only.

Pick 1 now if any; defer 2 until there is a second coach who wants it.

## 7. Export and import — **P2 · S–M**

**Evidence.** Export is a single raw JSON download
([account.ts:22](../../api/_lib/handlers/account.ts)): 31 user tables plus `profiles` and an
`mcp_tokens` summary. There is no CSV, GPX or FIT export and no import of any kind.

**Fix.** CSV per domain (sessions, set logs, cardio, meals) from the same query (S); a Strong /
Hevy CSV importer mapped onto the `log_workout` write path
([mcp/writeTools.ts](../../api/_lib/mcp/writeTools.ts)) (M) — the single most common ask from
anyone switching trackers.

## Sequencing

| Order | Item | Identity served |
|---|---|---|
| 1 | §4 `profiles.timezone`; §5 support@ link (onboarding board) and a check of production's auth settings | personal + product; fixes a correctness bug |
| 2 | §2 rotate link, then description + alarm; §3 widget | personal |
| 3 | §7 CSV export; §1 COROS daily sleep/HRV into `daily_metrics` (after W16 M0, if COROS has it) | personal |
| 4 | §5 waitlist, MFA, email change, feedback route | product, once signup is decided |
| 5 | §3 App Intents, Sign in with Apple; §4 PWA + light theme | product |
| 6 | §6 share-by-link; §1 Strava/Garmin direct | product, only on demand |

*Corrected:* HealthKit read and write are no longer rows here; W16 sequences them. Doc 2 §7's need
for resting HR and sleep is now met by W16 M3b/M3i rather than by this doc.

§2's alarm preference, §4's timezone, week start and distance unit, §5's waitlist and §6 all carry
migrations, because `profiles` has fixed columns and no settings blob, so they are HELD. Any §3
item that adds an entitlement or Info.plist key touches the iOS release surface and is HELD as
well: the widget's App Group, App Intents, Sign in with Apple, and the Face ID usage string.
