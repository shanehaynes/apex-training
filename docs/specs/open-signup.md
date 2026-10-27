# Open sign-up, finished — spec

Web sign-up went live on 2026-10-17 (PR #452, `DEPLOY_MULTI_USER.md` §6):
`/api/signup` verifies a Turnstile token and mails a Supabase invite, with no
password. This spec covers the remainder: an age check at sign-up, a way to
watch the caps, and sign-up inside the iOS app.

**Owns:** `api/_lib/handlers/signup.ts` and its test; `src/components/auth/`;
`src/context/AuthContext.tsx` `signUp` and `src/context/auth.ts` types;
`src/components/legal/AgeCheckbox.tsx` (new); the `/signup-check` route in
`src/App.tsx` (see Decisions, 2026-10-20); `scripts/supervisor-report.sh`
sign-up section; iOS `SignInView.swift`, a new `ApexFeatures` sign-up sheet,
the ApexCore sign-up endpoint, the app's wiring (`ios/Apex/ApexApp.swift`,
`AppModel.swift`, the mock's `/api/signup` answer), the `SmokeUITests`
invite-only assertion; `docs/ios/app-store.md` §7; `docs/ios/backend-changes.md`;
`DEPLOY_MULTI_USER.md` §6.
**Forbidden:** gate-protected paths, `legal/*.md` (wording is Shane's call:
see Decisions), `vercel.json`, migrations.
**Depends on:** PR #452 (merged).
**Status:** M1 done (#477), M2 done (#476), M3 in review (feat/ios-open-signup)

## Goal
Anyone holding the TestFlight link, or visiting apex-training.app, can create
an account in the place they are standing, after confirming they are 18 or
older (the terms already require it, `legal/terms-v1.md` §2). Shane can see
how close the daily caps are without reading logs.

## Scope
In:
- An 18+ attestation box next to the terms box. Its own act, never pre-ticked.
  The server refuses a sign-up without it, and the attestation and its time
  are stored in the account's `app_metadata` (service-role-only).
- Supervisor report: today's sign-up mails against the cap of 50, and an
  ACTION line once the cap is reached.
- iOS: a Create account mode on the sign-in screen (email, terms box, 18+
  box). It gets a Turnstile token from a page on apex-training.app shown in
  a web view, then posts to `/api/signup`. The invite email's existing
  hand-off finishes in the app.
Out:
- App Attest, date-of-birth collection, age *verification*.
- Edits to the legal documents.
- An age check on dashboard invites (Shane vouches for those people himself).

## Milestones

### M1 — Age check (web + server)
- [x] `/api/signup` answers 400 unless `ageConfirmed === true`. Nothing is called (siteverify, lookup, generate_link) before that check.
- [x] Every passing request (new or pending address) stores `age_confirmed_at` (ISO time) in the user's `app_metadata` before the mail goes out. If it can't be stored, no link is sent.
- [x] The web Create account tab, in open mode (site key set), shows an unticked 18+ box. Submit stays disabled until both boxes are ticked and a token exists.
- [x] Unit tests for the server, plus `e2e/mock/open-signup.spec.ts` for the form (using a dev-only site-key override and a fake widget); `npm run agent:check` green.

### M2 — Cap monitoring
- [x] `scripts/supervisor-report.sh` prints `signup mails today: N/50`, read with the production service key the report already uses. At N ≥ 50 it prints an `ACTION` line. If the key is missing it prints a skip line instead of failing.
- [x] The report's own test covers the three cases.

### M3 — iOS sign-up
- [x] `/signup-check` (`src/components/auth/SignupCheckPage.tsx`) renders the widget with the public site key and posts the token to `window.webkit.messageHandlers.turnstile`. It renders above the auth gate, like `/terms` (see Decisions).
- [x] `SignInView` has a Create account mode: email, terms box, 18+ box, and a Turnstile sheet (`WKWebView` loading that page). It posts `{email, captchaToken, ageConfirmed}` to `/api/signup` and shows the "check your inbox" state.
- [x] A UITest drives the mode up to the sheet. The smoke test no longer asserts "invite-only".
- [x] `docs/ios/app-store.md`: the in-app sign-up wording is in §7, kept apart from build 509's notes.
- [ ] Shane runs one real sign-up from a TestFlight build.

## Gate
`npm run agent:check`. M3 also needs `ios/scripts` tests and an xcodebuild UI test run on one simulator. The real Turnstile and email round trip is Shane's, on production.

## Done means
Every box checked, every PR merged, `scripts/git-tidy.sh --yes` run, Next brief filled.

## Decisions
- 2026-10-19 · Age check is an attestation box, not a date of birth. The terms' 18+ clause is a representation, and asking for a DOB would be new personal data the privacy policy doesn't list.
- 2026-10-19 · `legal/terms-v1.md` §2 still says "Accounts are currently created by invitation", and its LEGAL REVIEW note says there is no age gate. Both are now stale, and changing legal text is Shane's call. Flagged in the M1 PR, not edited.
- 2026-10-19 · The stamp lives in `app_metadata`, not `user_metadata` (review of M1). `generate_link`'s `data` is applied only when the user is created, so a pending address would keep no record. `user_metadata` is the user's own to rewrite with `updateUser`.
- 2026-10-20 · The check page is an SPA route (`/signup-check`), not a static `public/turnstile-bridge.html`. It reuses `TurnstileWidget` and the build's site key, so there is no second copy of either. Vercel's rewrite already serves it.
- 2026-10-19 · iOS gets its token from Turnstile in a web view (Shane's choice over App Attest), so the server path stays the same.
- 2026-10-20 · The in-app sign-up wording is `app-store.md` §7, not an edit to §5: build 509 is in review and invite-only, and its notes must stay true for any reply about it.
- 2026-10-27 · Every M3 build offers Create account; there is no client flag. Closing sign-up stays a server act (unset the site key), and the check sheet then says "Sign-up isn't open right now." The invite-only footer remains for a `SignInView` built without `SignUpOptions`, which is what the opt-in sign-in snapshot renders.
- 2026-10-27 · The check sheet cannot be swiped away (review of M3): a swipe leaves no moment to close the latch before the animation ends, so a token landing mid-swipe would still submit. Cancel is the only exit.
- 2026-10-27 · The web view keeps a non-persistent data store even though each sheet re-downloads the SPA (review of M3): nothing from the check page should outlive it. Revisit with a lazy route chunk if the first open is slow on cellular.
- 2026-10-27 · The sheet fails hard only on a 404 or 5xx check page (second review). Other 4xx render, because a Vercel firewall challenge (403/429) is a page that resolves itself, and that is exactly when abuse would turn one on. Not verified against Vercel's real challenge codes.
- 2026-10-27 · VoiceOver hears "Sign in" twice on the screen (the mode segment and the submit), as on the web's toggle. Left as is: the segment reads as a tab of two, the button as a button.
- 2026-10-27 · `ios/Config/Base.xcconfig`'s comment on the invite contact and the sign-in snapshot is now partly stale. Left alone: `ios/Config/` is HELD, and a comment is not worth holding this PR.

## Session log
- 2026-10-19 · spec written. M1 built on feat/signup-age-check. Verified on the local stack with Turnstile test keys: submit stays disabled until both boxes are ticked, `age_confirmed_at` lands in user metadata, and a request without `ageConfirmed` gets 400. Review fixes: the stamp moved to app_metadata via updateUserById, proven on the local stack for a pending invitee and a new address (provider field kept). Both boxes reset whenever the form opens. A mock e2e spec covers the form.
- 2026-10-20 · M3 built on feat/ios-open-signup: `/signup-check`, the Create account mode, the Turnstile sheet, ApexCore `SignUp`, App Store §7. PR held until #477 merged (it did, 2026-10-20).
- 2026-10-27 · M3 brought up to main (W17). A full unsigned UI run on its own simulator failed 22/24 smoke tests: the mode picker's "Sign in" segment made the shared sign-in helper's `buttons["Sign in"]` ambiguous. The submit now has `signin.submit`. Review fixes: the sheet shows a failure when the widget errors, the page answers 4xx/5xx, or the web process dies; no swipe dismissal; the email rule is the server's (`SignUp.isPlausibleEmail`, ApexCore, with tests); the check page reads `turnstileSiteKey()` and has mock e2e for the token, the load failure and a plain browser; `-apexMockSignupToken` lets the smoke reach the server's answer, and the mock refuses what the handler refuses. Second review: the email rule follows JavaScript on Unicode scalars and UTF-16 length (U+FEFF, U+0085, combining marks, emoji and İ pinned), the mock checks with the handler's own pattern, the bad-email step uses an address the old rule let through, and the swipe and Cancel steps run on a token held back 8 s (`-apexMockSignupTokenDelay`), so Cancel provably stops a late token and the test needs no local server.

## Next brief
M3's last box: Shane's real sign-up from a TestFlight build. After M3 merges, cut a TestFlight build with `ios/scripts/testflight.sh` (confirm with Shane first; uploading publishes). On a phone:
- Create account with a fresh inbox; the Cloudflare check passes in the sheet.
- The email arrives from invites@.
- Its link opens apex-training.app; "Open in the Apex app" lands on set-password.
- The new password signs in on the app and the web.
- In Supabase, the user's `raw_app_meta_data.age_confirmed_at` is set.

Before that build goes to App Review: edit `legal/terms-v1.md` §2 (Shane), and use app-store.md §7's wording.
