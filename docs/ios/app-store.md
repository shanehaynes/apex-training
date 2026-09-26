# App Store submission — the console answers, the review notes, the demo account

W13's App Store readiness, in one place. The code side is done (`ios/Apex/PrivacyInfo.xcprivacy`,
in-app account deletion since W11, the invite link on the sign-in screen); everything below is
filled in by hand in [App Store Connect](https://appstoreconnect.apple.com) by Shane, because
the console has no API for most of it and the demo account needs a real key.

> Who can mint an App Store Connect API key, where each secret is escrowed, and how to recover
> the Apple Account without the release machine: [ops-runbook.md](../ops-runbook.md).

## 1. App Privacy (App Store Connect → App → App Privacy)

These answers must match `PrivacyInfo.xcprivacy`, which App Store Connect reads from the
uploaded build. Answer **"Yes, we collect data from this app"**, then:

| Data type | Collected? | Linked to identity | Used for tracking | Purpose |
|---|---|---|---|---|
| Contact Info → Email Address | Yes | Yes | No | App Functionality (the sign-in identity) |
| Contact Info → Name | Yes | Yes | No | App Functionality (the optional display name) |
| Health & Fitness → Fitness | Yes | Yes | No | App Functionality (workouts, sets, meals, HR zones, a connected watch's activities) |
| User Content → Other User Content | Yes | Yes | No | App Functionality (coach chat, goal and context text) |
| Identifiers → User ID | Yes | Yes | No | App Functionality (the account id every row is keyed by) |
| Health & Fitness → Health | **No** | | | The app does not read HealthKit (D-018) |
| Location | **No** | | | A watch activity's route is stored as the provider sent it; the app never asks for location |
| Diagnostics, Usage Data, Purchases, Financial Info, Browsing, Search | **No** | | | None collected; no analytics SDK, no crash reporter |

"Data used to track you": **none**. `NSPrivacyTracking` is `false` and the manifest lists no
tracking domains.

Privacy policy URL (App Information): `https://apextrainingcalendar.vercel.app/privacy` — the
same page the About screen links to. Terms: `/terms`.

## 2. App Information

- **Name** Apex Training · **Subtitle** Plan, log, and coach your training
- **Category** Health & Fitness · **Secondary** none
- **Age rating** 4+ (no objectionable content; the coach is text about the user's own training)
- **Copyright** © 2026 Shane Haynes
- **Support URL** `https://github.com/shanehaynes/apex-training` (README + WELCOME.md)
- **Invite contact** the sign-in screen's "Request an invite" link comes from
  `APEX_INVITE_CONTACT` in `ios/Config/Base.xcconfig` — the one line to change, and the only
  place the address lives. It is `support@apex-training.app`, a forwarding alias; it ships in
  the binary and is frozen there once archived (#214). No screenshot is affected; the address is
  never drawn on screen and the set below has no sign-in shot.
- **Marketing URL** `https://apextrainingcalendar.vercel.app`
- **Sign in with Apple** not required: the app offers only its own email + password, no
  third-party or social login (guideline 4.8 applies to third-party login only).
- **Export compliance** answered in the build: `ITSAppUsesNonExemptEncryption = false`
  (`ios/Apex/Info.plist`) — HTTPS only.
- **Account deletion** (5.1.1(v)): You → Data → Delete account → `DELETE /api/account`
  (W11), typed confirmation, signs out. Mention it in the review notes; reviewers look for it.

### Before the archive: prove production's schema

Archiving freezes `APEX_API_BASE` and the Supabase project into the binary, so a shipped build
can only ever talk to the database production has *today* — and production's migrations are
pasted into the SQL editor by hand, where a skipped one is invisible from the app. In September
2026 production ran four days missing phase38, phase41 and `phase32_quarantine`, so
`GET /api/profile` and `DELETE /api/account` 500'd while `/api/version` reported current code.
A 500 on account deletion is the 5.1.1(v) rejection above, arriving by a different door.

So before every archive, from the primary checkout (it reads `VITE_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` out of `.env.local`; the key goes into request headers only and
`limit=0` means no row is ever read):

```bash
node scripts/prod-schema-check.mjs     # exit 0 in sync · 1 drift · 2 could not check
```

On exit 1 it names each missing table, column or function together with the
`supabase/migrations/phaseN_*.sql` that creates it. Paste those files into Supabase → SQL Editor
in `sort -V` order, then re-run until it exits 0 — do not archive on a 1. `ios/scripts/testflight.sh`
runs the same check before it archives and stops there too (`APEX_SKIP_SCHEMA_CHECK=1` overrides
it), so this is a second pair of eyes on the same gate, not a different one. What it cannot see:
triggers, RLS policies, grants, constraints, defaults, column types, function signatures and
realtime publication membership — a migration that only changes those can still be missing.

Last hand-run: **2026-09-19, exit 0** — all 30 tables (344 columns) and 2 functions `main` expects
are present in production.

## 3. App Review Information

### Sign-in required: the demo account

The app is invite-only, so App Review needs an account that already exists, with an Anthropic
key saved so the coach can be exercised. **Shane creates it once**; it is a real account on
the production project:

1. Supabase → Authentication → Users → **Invite user** with a dedicated address (e.g.
   `apex-review@<your domain>` or a plus-address you control). Open the invite email on a
   laptop, set a password, accept the terms. Write both down for the form below.
2. Sign in to that account in the app (or the web) and, under **You → AI coach → Anthropic
   key**, save a key from a Console workspace that carries a small spend cap — the reviewer's
   chats bill it. `sk-ant-…` keys are validated live on save; the You row reads "Saved · …last4"
   when it took.
3. Give the account something to look at: **You → Training** is empty for a fresh account, so
   copy the starter plan (the welcome flow's "Copy the starter plan", or the setup card on
   Schedule) and log one workout through the tracker so Analytics and the exercise library
   are not blank.
4. Do not connect COROS on it (nothing to connect to), and do not mint a connector token.
5. Enter in App Store Connect → App Review Information → **Sign-in required**: the email and
   password from step 1.

Rotate the key (Console → API keys → revoke) after approval, and again if the account is ever
reused for a later review.

### Notes to the reviewer (paste into the Notes field)

> Apex Training is a personal training log with an optional AI coach. Accounts are created by
> invitation only (the sign-in screen says so and offers a "Request an invite" link); please use
> the demo account above.
>
> The AI coach (the Coach tab) runs on the user's own Anthropic API key, which the user pastes
> in under You → AI coach → Anthropic key. The app is fully usable without a key: scheduling,
> the workout tracker, meals, blocks, the library and analytics never need one. Nothing is
> sold in the app and no price is shown; the key is a credential the user already holds with
> Anthropic, not a purchase. The demo account has a key saved, so the Coach tab works as is —
> try "What did I do this week?".
>
> Account deletion is in the app: You → Data → Delete account.
>
> The tracker keeps a Live Activity (elapsed timer) while a workout is open; start one from any
> workout's sheet with "Start Workout" and end it with "Finish".
>
> COROS (You → Integrations) is an optional watch sync and needs a COROS account; it is not
> required to review anything.

Contact: Shane Haynes, the phone number and email in the form.

## 4. Screenshots

Apple wants one set at the 6.9" size (iPhone 17 Pro Max: 1320 × 2868, portrait); smaller
sizes are derived. `ios/scripts/screenshots.sh` produces the smoke's attachments on any
simulator, with the mock backend's fixture data:

```bash
ios/scripts/screenshots.sh 'iPhone 17 Pro Max'     # → ios/build/screens/iPhone-17-Pro-Max/*.png
```

The set worth uploading, in this order (the file names the script writes):

| # | File | Screen |
|---|---|---|
| 1 | `02-day.png` | Schedule, Day view — four workouts, the meals line |
| 2 | `03-month.png` | Schedule, Month view |
| 3 | `05-event.png` | A workout's sheet, with the synced-run badge |
| 4 | `07-tracker.png` | The tracker mid-workout |
| 5 | `12-coach-card.png` | The Coach thread with a confirmation card |
| 6 | `29-analytics.png` | Analytics tiles |
| 7 | `w11-01-you.png` | The You tab |
| 8 | `w10-07-block-detail.png` | A training block's by-week attainment |

The fixture data says "Fixture Push Day"; for the store, the same screens from Shane's own
account on a device are better copy. Take them on an iPhone 17 Pro Max (Settings → Display →
screenshot lands in Photos at the exact size) and never mix the two sets — the fixture ones
carry a 2026-09-08 date. No text overlays, no device frames: Apple's own frame is added for you.

## 5. What could get it rejected, and the answer

| Risk | Where it is handled |
|---|---|
| 5.1.1 — sign-up required but no way to get an account | the sign-in screen states invite-only and links "Request an invite"; the demo account is in the review form |
| 5.1.1(v) — no in-app account deletion | You → Data → Delete account, since W11 |
| 3.1.1 — "paying" for a feature outside IAP | the key is a credential, not a purchase; no price, no purchase flow, the app works without it — the notes say so |
| 2.1 — a crash or an empty screen on review | the demo account has a starter plan and one logged workout (§3 step 3) |
| 2.3.3 — screenshots that do not match the app | the fixture screenshots are the app; prefer device shots from a real account |
| Missing privacy manifest / required-reason API reason | `ios/Apex/PrivacyInfo.xcprivacy` declares UserDefaults (CA92.1) and file timestamps (C617.1); GRDB ships its own; `ios/ApexWidgets/PrivacyInfo.xcprivacy` declares the extension's nothing, because the scan is per binary (ITMS-91053) |
| App Privacy answers disagree with the manifest | §1 is the manifest, row for row |

If a rejection arrives, record the exact guideline number and Apple's wording in
[STATUS.md](STATUS.md) and the W13 brief, and the fix plan under it, before touching code.

## 6. Release safety — phased release, an expedited fix, and the first week

The backend addresses are frozen into the binary (`APEX_API_BASE`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY` in `ios/Apex/Info.plist`, filled from `ios/Config/*.xcconfig`), so a bad
build cannot be fixed from the server: the only rollback is another build through App Review.
Everything below is the plan for that, and it is App Store Connect work, not code.

### Phased Release does not apply to 1.0 — plan around it

Apple's help is explicit that phased release is for **version updates**: "When you release a
version update of your app, you can choose to release the new version to the App Store in
stages", and it rolls out to users with automatic updates on over seven days (1%, 2%, 5%, 10%,
20%, 50%, 100%). A first version has no installed base to update, so there is no phased-release
control on 1.0 and nothing to enable on it. The ceiling on a bad 1.0 is therefore however many
people install it on day one — which, for an invite-only app, is the invite list.

So for **1.0**, the day-one controls are these, in the order you would reach for them:

1. **Release it yourself, not automatically.** App Store Connect → **Apps** → Apex Training →
   the version in the **sidebar** → **App Store Version Release** → select **"Manually release
   this version"** → **Save** (top right). Approval then parks the version at *Pending Developer
   Release* instead of shipping it while you are asleep. Release it with **Release This Version**
   → **Confirm** on the version page; it can take up to 24 hours to appear on the App Store.
   The public listing is `https://apps.apple.com/app/id6808637152` (the App Store Connect app
   id; `APEX_APP_STORE_URL` in `ios/Config/Base.xcconfig` carries it for the update screen).
2. **Smoke the released build yourself before telling anyone.** Install from the public App
   Store listing on a device that has never had a TestFlight build, sign in, open Coach, log a
   set. The frozen config is exactly what a TestFlight build cannot prove — a Release build
   points at production, and the first real proof that the shipped `APEX_API_BASE` is right is a
   fresh install from the store.
3. **If the build is broken, pull the listing while you fix it.** Apps → Apex Training →
   **Pricing and Availability** → bottom of the page → **Remove App From Sale** → **Remove**.
   Removal takes up to 24 hours and only stops *new* downloads: people who already installed it
   keep the broken build and can redownload it, so this buys quiet, not a rollback. The fix is
   still 1.0.1.
4. **Submit 1.0.1 and request an expedited review** (below).

### From 1.0.1 on, turn phased release on with the version

Every update after 1.0 gets it, and it is free:

> Apps → Apex Training → the version in the **sidebar** → scroll to **Phased Release for
> Automatic Updates** → select **"Release update over a 7-day period using phased release"** →
> **Save**.

**The rule, from 1.0.1 on: every version sets phased release the moment it is created, while
it reads *Prepare for Submission*, before a build is attached or anything else on the page is
filled in.** Apple's help does list *Waiting for Review* and *In Review* among the statuses
where the option is still available, but a submission is a bad moment to be discovering which
statuses Apple honours. The same moment is when "Manually release this version" is set (step 1
above); the App Store Connect API reports both on the version — `releaseType` is `MANUAL`,
not `AFTER_APPROVAL` — so a read-only `GET /v1/apps/6808637152/appStoreVersions` with the
escrowed API key is the check that neither was forgotten.

Two controls exist once it is live, on the *Ready for Distribution* version's page:
**Pause Phased Release** (up to 30 days total, and it resumes on the day it paused) and
**Release to All Users** (top right) when a release is proven good and you want the rest of the
installed base on it. Note the hole in it: phased release only throttles *automatic* updates.
Anyone who opens the App Store and taps Update gets the new build immediately, so a phased
rollout reduces exposure, it does not gate it.

### Requesting an expedited review

Apple reviews about 90% of submissions in under 24 hours, so the normal path is usually fast
enough. Expedite only when users are stuck on a broken build.

1. Upload and submit the fix version normally first — the request references a submission.
2. Go to <https://developer.apple.com/contact/app-store/?topic=expedite> (Apple Developer
   sign-in required; it is also linked from the
   [App Review page](https://developer.apple.com/distribute/app-review/)) and pick the
   **critical bug fix** reason.
3. Write, in the request: what the bug does to users ("every launch on iOS 26 crashes before the
   sign-in screen"), **the steps to reproduce it on the version currently on the App Store** —
   Apple asks for these by name — the version number of the fix waiting in review, and what
   changed in it. Keep it to a paragraph and make it checkable.
4. Do not stack requests. Apple grants expedites on a limited basis and says outright that
   repeated requests may stop being prioritised, so spending one on a cosmetic bug costs the
   next real outage. One a release at the very most.

If the fix is only a guideline dispute rather than a crash, do not expedite: for apps already on
the App Store, Apple no longer holds bug fixes over non-legal guideline violations — ship the
fix and answer the guideline in the next submission.

### Crash checks for the first week

Crash reports for an App Store build come from users who have opted into sharing diagnostics
(TestFlight users always share, App Store users only if they said yes), and there is no crash
SDK in this app, so Xcode's Organizer is the whole picture. **Xcode → Window → Organizer →
Crashes**, with **Apex Training** and the shipped version selected.

| When | What to look at | What makes it an incident |
|---|---|---|
| Day 0, ~2h after release and again that evening | Crashes, sorted by count | Any crash at all in a build with a handful of users — one report means one of very few installs |
| Days 1–7, once each morning | Crashes for the released version; the trend, not the total | A crash rising with installs, or anything in `ApexClient`/`ApexAuth` (a config or token bug hits everyone) |
| Day 7 | Crashes, plus Organizer → **Metrics** for launch time and hangs | Anything still open decides whether 1.0.1 is a fix release or a planned one |
| After that | Weekly, and always within a day of releasing a version | — |

Expect the list to be thin and lagging: reports arrive in Apple's own batches rather than live,
so an empty Organizer on release day is not evidence of a healthy build. Treat the signal you
control as primary — the fresh-install smoke in step 2 above, and Supabase's API logs, where a
build that cannot reach the backend shows up as the absence of requests from new accounts.
Record anything you act on in [STATUS.md](STATUS.md), as with a rejection.

Sources, current as of 2026-09-19:
[phased release](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/) ·
[version release options](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option/) ·
[app availability](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/manage-availability-for-your-app-on-the-app-store/) ·
[App Review and the expedite form](https://developer.apple.com/distribute/app-review/) ·
[crash reports in Organizer](https://developer.apple.com/documentation/xcode/acquiring-crash-reports-and-diagnostic-logs).
