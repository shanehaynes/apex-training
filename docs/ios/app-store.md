# App Store submission — the console answers, the review notes, the demo account

W13's App Store readiness, in one place. The code side is done (`ios/Apex/PrivacyInfo.xcprivacy`,
in-app account deletion since W11, the invite link on the sign-in screen); everything below is
filled in by hand in [App Store Connect](https://appstoreconnect.apple.com) by Shane, because
the console has no API for most of it and the demo account needs a real key.

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
  place the address lives. Point it at a forwarding alias **before the archive**: it ships in
  the binary and is frozen there afterwards (#214). No screenshot is affected; the address is
  never drawn on screen and the set below has no sign-in shot.
- **Marketing URL** `https://apextrainingcalendar.vercel.app`
- **Sign in with Apple** not required: the app offers only its own email + password, no
  third-party or social login (guideline 4.8 applies to third-party login only).
- **Export compliance** answered in the build: `ITSAppUsesNonExemptEncryption = false`
  (`ios/Apex/Info.plist`) — HTTPS only.
- **Account deletion** (5.1.1(v)): You → Data → Delete account → `DELETE /api/account`
  (W11), typed confirmation, signs out. Mention it in the review notes; reviewers look for it.

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
| Missing privacy manifest / required-reason API reason | `PrivacyInfo.xcprivacy` declares UserDefaults (CA92.1) and file timestamps (C617.1); GRDB ships its own |
| App Privacy answers disagree with the manifest | §1 is the manifest, row for row |

If a rejection arrives, record the exact guideline number and Apple's wording in
[STATUS.md](STATUS.md) and the W13 brief, and the fix plan under it, before touching code.
