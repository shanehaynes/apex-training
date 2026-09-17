# W13 — Release engineering + polish

**Machine:** Mac · **Depends on:** everything · **Unblocks:** App Store submission
**Status:** in review — A #190 (HELD), B #191, C #193, D (polish); App Store submission is Shane's console work

## Goal
Repeatable TestFlight releases, App Store readiness, and the remaining UX checklist items.

## Scope
In:
- `ios/fastlane/Fastfile` `beta` lane (ASC API key, `-allowProvisioningUpdates`,
  `upload_to_testflight`); `.github/workflows/testflight.yml` (`workflow_dispatch`, HELD);
  build number = run number; release cadence note in MASTER.md (90-day expiry).
- `PrivacyInfo.xcprivacy`; App Privacy answers; review notes with a demo account (key saved);
  screenshots; sign-in copy for invite-only with a contact path.
- Onboarding: paged welcome flow (port `src/lib/onboarding/content.ts`), setup nudge card.
- Haptics pass (design-spec §9); Dynamic Type pass (11pt floor, `relativeTo:`); VoiceOver
  labels on icon-only controls; Reduce Motion.
- UX checklist audit: every `ux-improvements.md` row ticked or moved to Backlog with a reason.
- Optional: offer the new icon as the web favicon (separate web PR).
Out: anything on the Backlog.

## Acceptance
- A TestFlight build ships from the workflow with no local steps.
- App Store submission accepted (or a documented rejection with the fix plan).
- `ux-improvements.md` fully accounted for.

## Session log
- 2026-09-17 · Mac · One session, four PRs, three worktrees (`chore/w13-release`, then
  `chore/w13-appstore` in the same worktree; `feat/w13-onboarding`; `chore/w13-polish`).
  - **A — release engineering (#190, HELD).** `ios/fastlane/Fastfile` `beta`: `build_app` with the
    API key on `xcargs`/`export_xcargs` (gym does not pass `api_key` to xcodebuild), the same
    ExportOptions as `testflight.sh`, `upload_to_testflight`; `dry_run:true` stops after the export.
    `.github/workflows/testflight.yml`: `workflow_dispatch`, `fetch-depth: 0`, a first step that
    names any missing secret, `secrets.sh` for the anon key, concurrency group without cancel,
    the `.ipa` as an artifact. **Build number = `git rev-list --count HEAD`, not `run_number`
    (D-034)**: App Store Connect has seen 353 for 0.8.0. Proven: `fastlane beta dry_run:true`
    archives with the key signing and exports a signed `Apex-355.ipa`, no upload. Traps: the
    issuer id lives only in git-ignored `appstoreconnect.env` (recovered from the memory note when
    the W10 worktree took it); gym passes the API key to the export step itself, so auth flags on
    `export_xcargs` duplicate `-authenticationKeyPath` and fail — they ride on the archive's
    `xcargs` only; the Fastfile's `sh` runs from `ios/fastlane`.
  - **B — App Store readiness (#191).** `PrivacyInfo.xcprivacy` (UserDefaults CA92.1, file
    timestamps C617.1; GRDB ships its own manifest, supabase-swift none) named explicitly as a
    resource in `project.yml`; "Request an invite" on the sign-in screen from `APEX_INVITE_CONTACT`
    (Base.xcconfig → Info.plist → `AppConfig.inviteContactURL`); `docs/ios/app-store.md` with the
    App Privacy table, the review notes, the demo-account steps, the screenshot set. Pro Max run:
    63 shots at 1320 × 2868; `testEventEditsOnFixtures` and `testYouOnFixtures` timed out under
    three concurrent builds.
  - **C — onboarding (#193, D-035).** Copy generated from `content.ts`; verdicts from the
    server (`GET /api/profile` → `onboarding`, `progress.ts` imported into the handler);
    `OnboardingModel` / `WelcomeFlowView` / `SetupNudgeCard`; `RouteBus.pendingYou`. Traps: a new
    test file needs `xcodegen generate` again or `-only-testing` runs zero tests; the COROS step
    needs the provider status before the You tab has loaded it, so the model asks at `start()`.
  - **D — polish.** Haptics per design-spec §9 (the tracker and coach already had four of five;
    `.selection` on `ApexSegmented`, `ChipPicker`, `MultiChipRow`; `.success` on sheet/day-card
    completion via `ScheduleModel.completedCount`). Dynamic Type: every text through
    `.apex(relativeTo:)` (the only fixed sizes left are SF Symbol icons), four 10pt texts to the
    11pt floor, the Live Activity's fonts `relativeTo:`, `.accessibility3` snapshots for the day,
    tracker, dashboard and thread. Reduce Motion: `Motion.animate` / `Motion.current` in ApexUI
    replace 29 `withAnimation(Motion.spring)` and 5 `.animation(Motion.spring)` sites; the month
    slide gated. VoiceOver: an audit script over every `Button`/`Menu` with an icon-only label
    found each carries `accessibilityLabel`. `ux-improvements.md` gained a Status column with
    evidence per row; nothing moved to Backlog.
  - Not done: the optional favicon web PR (Backlog in MASTER); the App Store submission itself
    (console work, `app-store.md`); the end-to-end proof of the workflow (needs the secrets).
