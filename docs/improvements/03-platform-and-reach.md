# Improvement doc 3 — platform and reach

**Date:** 2026-10-13 · **Status:** proposal · **Scope:** integrations, iOS native surface, web
platform, account, sharing
**Source:** a feature-gap review of the whole repo. This doc covers what sits around the product
rather than inside it: where data comes from, where the app can live, who can get in, and whether
anything can be shared.

Most of these only matter if Apex is a product rather than one athlete's log. Each item says
which identity it serves. Sizes as in doc 1 (S / M / L).

## 1. One integration, activities only — **P1 (product) · L per provider**

**Evidence.** `SyncProvider = 'coros'` ([providers/connection.ts:17](../../api/_lib/providers/connection.ts));
the DB check constraint allows only `coros` (phase27). Garmin, Apple and Strava are type strings
([workout.ts:198](../../src/types/workout.ts)) and a FIT decoder. Per activity Apex takes sport,
time, distance, elevation, HR, calories and streams
([coros/client.ts:199](../../api/_lib/providers/coros/client.ts)); sleep, HRV, training load and
body metrics are not parsed. Disconnect cannot revoke the grant at COROS
([providerSync.ts:107](../../api/_lib/handlers/providerSync.ts)). Matching requires the same
calendar day and exact type ([sync/matching.ts:38](../../src/lib/sync/matching.ts)).

**Fix, in value order.**
1. **HealthKit read on iOS** (workouts, resting HR, sleep, HRV, body mass) posted through the
   existing provider-sync shape as `provider: 'apple'`. One integration covers Apple Watch,
   Garmin-via-Health, Whoop-via-Health and the scale. Entitlement + privacy strings + App Store
   privacy answers change (app-store.md §1).
2. **HealthKit write** of tracked sessions so Apex workouts close Activity rings (D-018).
3. Parse COROS daily sleep/HRV/load into a `daily_metrics` table; physiology already wants them.
4. Strava or Garmin direct only if HealthKit does not reach the users who ask.
5. ±1-day matching tolerance for late-night sessions and timezone crossings.

## 2. The calendar feed is a title and a time — **P2 · S**

**Evidence.** Each VEVENT carries UID, DTSTART/DTEND, SUMMARY, LOCATION, RRULE, EXDATE and
nothing else ([calendar-feed.ts:130-209](../../api/calendar-feed.ts)). No DESCRIPTION, no VALARM,
no completion state, floating times by design. `ics_token` is never client-writable and has no
rotate endpoint ([profile.ts:17](../../api/_lib/handlers/profile.ts)).

**Fix.** DESCRIPTION with the exercise list and a deep link; an optional VALARM offset chosen in
Profile; `STATUS:COMPLETED` or a ✓ prefix for done occurrences; a "Rotate link" button that
rewrites `ics_token`. All S; the feed is one file.

## 3. iOS native surface — **P1 (product) · S–L**

**Evidence.** No HealthKit, Watch, home-screen widget (the widget bundle holds only the Live
Activity, [ApexWidgetsBundle.swift:21](../../ios/ApexWidgets/ApexWidgetsBundle.swift)), no
user-facing push, no Sign in with Apple ([app-store.md:53](../ios/app-store.md)), no biometric
lock, no Siri/App Intents, no Spotlight. Portrait, iPhone and dark only
([project.yml](../../ios/project.yml), Info.plist). Coach threads on the phone never meet the
web's (D-013).

**Fix, in order.**
- Today's-workout home-screen and Lock Screen widget with a Start deep link (S–M; the schedule
  cache is already on device).
- Push channel (doc 2 §4; D-017).
- App Intents: "Start today's workout", "Log a meal", "What's on today" (M); Siri and
  Shortcuts come free.
- Sign in with Apple — required by Apple only if a third-party login exists, so optional today,
  but the lowest-friction invite path once signup opens (M; Supabase supports it).
- Biometric app lock behind a toggle (S).
- iPad layout and landscape (L; the design spec is phone-only by decision — revisit only if iPad
  users appear).
- D-013 thread sync (M).

## 4. Web platform — **P2 · S each**

**Evidence.** No manifest or service worker (public/ has none); dark only
([app.css:781](../../src/styles/app.css)); Monday weeks hard-coded
([dateHelpers.ts:10](../../src/utils/dateHelpers.ts)); imperial and en-US fixed; no timezone
setting — "today" is the browser clock ([clock.ts:17](../../src/lib/clock.ts)) and the MCP server
uses UTC ([mcp/data.ts:248](../../api/_lib/mcp/data.ts)); Escape is the only shortcut
([useModalChrome.ts:18](../../src/hooks/useModalChrome.ts)).

**Fix.** A manifest plus a cache-shell service worker so the web app installs on Android and
desktop (S); `profiles.timezone` captured at sign-in and used by MCP and the crons (S, fixes a
real correctness bug for travellers); `week_start` and unit preferences next to it (S); a light
theme via the existing token layer (M, D-010 says "for now"); a handful of shortcuts — `t` today,
`←/→` period, `n` new workout, `/` coach (S).

## 5. Account, security and support — **P1 (product) · S–M**

**Evidence.** Email + password only ([AuthContext.tsx:135](../../src/context/AuthContext.tsx));
no MFA; password change does not ask for the current password
([ProfileView.tsx:132](../../src/components/profile/ProfileView.tsx)); email cannot be changed;
no self-serve signup or waitlist — production signup is off and the only door is a dashboard
invite ([DEPLOY_MULTI_USER.md](../../DEPLOY_MULTI_USER.md)); no in-app feedback or support
surface; the error boundary offers Reload only.

**Fix.** Re-authenticate before password change (S); email change via Supabase's double
confirmation (S); TOTP MFA behind a toggle (M; Supabase supports it); a request-access form that
writes to a `waitlist` table and emails Shane (S) — the invite-only stance stays, the funnel
becomes visible; a "Send feedback" row in Profile that posts to the existing error-report webhook
with the last 20 console lines (S); a support@ link in the help index (S).

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

**Evidence.** Export is one raw JSON dump of 31 tables
([account.ts:21](../../api/_lib/handlers/account.ts)); no CSV, GPX or FIT; no import of any kind.

**Fix.** CSV per domain (sessions, set logs, cardio, meals) from the same query (S); a Strong /
Hevy CSV importer mapped onto `log_workout` (M) — the single most common ask from anyone
switching trackers.

## Sequencing

| Order | Item | Identity served |
|---|---|---|
| 1 | §4 timezone column; §5 re-auth + feedback row | personal + product, cheap |
| 2 | §3 widget; §2 feed description + alarm | personal |
| 3 | §1 HealthKit read | product; unlocks doc 2 §7 |
| 4 | §5 waitlist + MFA; §7 CSV | product |
| 5 | §1 HealthKit write; §3 App Intents; §4 PWA + light theme | product |
| 6 | §6 share-by-link | product, only on demand |

§1, §5 (waitlist), §6 carry migrations and are HELD; §1 and §3 touch the iOS release surface
(entitlements, Info.plist) and are HELD too.
