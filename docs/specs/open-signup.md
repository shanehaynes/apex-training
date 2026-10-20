# Open sign-up, finished — spec

Web sign-up went live on 2026-10-17 (PR #452, `DEPLOY_MULTI_USER.md` §6):
`/api/signup` verifies a Turnstile token and mails a Supabase invite, with no
password. This spec covers the remainder: an age check at sign-up, a way to
watch the caps, and sign-up inside the iOS app.

**Owns:** `api/_lib/handlers/signup.ts` and its test; `src/components/auth/`;
`src/context/AuthContext.tsx` `signUp` and `src/context/auth.ts` types;
`src/components/legal/AgeCheckbox.tsx` (new); `public/turnstile-bridge.html`
(new); `scripts/supervisor-report.sh` sign-up section; iOS `SignInView.swift`,
a new `ApexFeatures` sign-up sheet, the ApexCore sign-up endpoint, the
`SmokeUITests` invite-only assertion; `docs/ios/app-store.md` §5;
`DEPLOY_MULTI_USER.md` §6.
**Forbidden:** gate-protected paths, `legal/*.md` (wording is Shane's call:
see Decisions), `vercel.json`, migrations.
**Depends on:** PR #452 (merged).
**Status:** in progress (feat/signup-age-check)

## Goal
Anyone holding the TestFlight link, or visiting apex-training.app, can create
an account in the place they are standing, after confirming they are 18 or
older (the terms already require it, `legal/terms-v1.md` §2). Shane can see
how close the daily caps are without reading logs.

## Scope
In:
- An 18+ attestation box next to the terms box. Its own act, never pre-ticked.
  The server refuses a sign-up without it, and the attestation and its time
  are stored in the invite's user metadata.
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
- [x] A passing request stores `age_confirmed_at` (ISO time) in `generateLink`'s `options.data`.
- [x] The web Create account tab, in open mode (site key set), shows an unticked 18+ box. Submit stays disabled until both boxes are ticked and a token exists.
- [x] Unit tests for all three; `npm run agent:check` green.

### M2 — Cap monitoring
- [ ] `scripts/supervisor-report.sh` prints `signup mails today: N/50`, read with the production service key the report already uses. At N ≥ 50 it prints an `ACTION` line. If the key is missing it prints a skip line instead of failing.
- [ ] The report's own test covers the three cases.

### M3 — iOS sign-up
- [ ] `public/turnstile-bridge.html` renders the widget with the public site key and posts the token to `window.webkit.messageHandlers.turnstile`. The page is static, needs no app bundle, and is served by Vercel as-is.
- [ ] `SignInView` has a Create account mode: email, terms box, 18+ box, and a Turnstile sheet (`WKWebView` loading that page). It posts `{email, captchaToken, ageConfirmed}` to `/api/signup` and shows the "check your inbox" state.
- [ ] A UITest drives the mode up to the sheet. The smoke test no longer asserts "invite-only".
- [ ] `docs/ios/app-store.md` §5: the 5.1.1 row describes in-app sign-up.
- [ ] Shane runs one real sign-up from a TestFlight build.

## Gate
`npm run agent:check`. M3 also needs `ios/scripts` tests and an xcodebuild UI test run on one simulator. The real Turnstile and email round trip is Shane's, on production.

## Done means
Every box checked, every PR merged, `scripts/git-tidy.sh --yes` run, Next brief filled.

## Decisions
- 2026-10-19 · Age check is an attestation box, not a date of birth. The terms' 18+ clause is a representation, and asking for a DOB would be new personal data the privacy policy doesn't list.
- 2026-10-19 · `legal/terms-v1.md` §2 still says "Accounts are currently created by invitation", and its LEGAL REVIEW note says there is no age gate. Both are now stale, and changing legal text is Shane's call. Flagged in the M1 PR, not edited.
- 2026-10-19 · iOS gets its token from Turnstile in a web view (Shane's choice over App Attest), so the server path stays the same.

## Session log
- 2026-10-19 · spec written. M1 built on feat/signup-age-check. Verified on the local stack with Turnstile test keys: submit stays disabled until both boxes are ticked, `age_confirmed_at` lands in user metadata, and a request without `ageConfirmed` gets 400. Not verified: there is no client unit test (vitest has no DOM environment); the browser check stands in for it.

## Next brief
(filled at the end of each milestone)
