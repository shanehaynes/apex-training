# W13 — Release engineering + polish

**Machine:** Mac · **Depends on:** everything · **Unblocks:** App Store submission
**Status:** B #191 and D #194 merged 2026-09-17; C #193 in review (blocked only by Vercel's preview rate limit); A #190 HELD for `shipit`; App Store submission is Shane's console work

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
    63 shots at 1320 × 2868. Trap: `testEventEditsOnFixtures` (`SmokeUITests.swift:363`, the
    `editor.link.fx-c3` tap does not flip to "Unlink") and `testYouOnFixtures` (`:693`,
    `you.row.activity` not found after the COROS back tap) fail on the **iPhone 17 Pro Max** and
    pass on the iPhone 17 — reproduced on an idle machine, so it is the device's layout, not
    contention. Unfixed; the App Store set does not need their later attachments.
  - **C — onboarding (#193, D-035).** Copy generated from `content.ts`; verdicts from the
    server (`GET /api/profile` → `onboarding`, `progress.ts` imported into the handler);
    `OnboardingModel` / `WelcomeFlowView` / `SetupNudgeCard`; `RouteBus.pendingYou`. Traps: a new
    test file needs `xcodegen generate` again or `-only-testing` runs zero tests; the COROS step
    needs the provider status before the You tab has loaded it, so the model asks at `start()`.
    CI trap (twice on this PR, `testYouOnFixtures`): the runner minted a token named "CClaude
    Code" — the smoke's `type(_:into:)` landed one "C", its delete was dropped too, and the
    retyped name passed a *suffix* check. An exact-value rewrite of the helper failed two other
    legs locally with a message the new code cannot emit (a stale test bundle, most likely), so it
    was withdrawn — the hardening landed as #195 (below). The `ios` job is not a required
    check (`check`, `e2e-mock`, `full` are).
  - **D — polish (#194).** Haptics per design-spec §9 (the tracker and coach already had four of five;
    `.selection` on `ApexSegmented`, `ChipPicker`, `MultiChipRow`; `.success` on sheet/day-card
    completion via `ScheduleModel.completedCount`). Dynamic Type: every text through
    `.apex(relativeTo:)` (the only fixed sizes left are SF Symbol icons), four 10pt texts to the
    11pt floor, the Live Activity's fonts `relativeTo:`, `.accessibility3` snapshots for the day,
    tracker, dashboard and thread. Reduce Motion: `Motion.animate` / `Motion.current` in ApexUI
    replace 29 `withAnimation(Motion.spring)` and 5 `.animation(Motion.spring)` sites; the month
    slide gated. VoiceOver: an audit script over every `Button`/`Menu` with an icon-only label
    found each carries `accessibilityLabel`. `ux-improvements.md` gained a Status column with
    evidence per row; nothing moved to Backlog.
  - **Follow-up — `type(_:into:)` hardened (#195).** Success is the exact value (`after ==
    base + text`, case-insensitive; `base` is `before` only while `after` still starts with it,
    since an empty field reads back its placeholder; secure fields by bullet count). The value is
    waited on (`XCTWaiter`, 3 s) after the type and after each erase, since the read lags
    keystrokes on a starved runner; the erase is proven back to `before` before the retype,
    re-erased three times at most; the `XCTFail` carries the read-back value. Proven on the
    iPhone 17 with a fresh `-derivedDataPath`: You, Coach key, Builder, Tile builder, Onboarding,
    Library legs. Trap: the earlier attempt's "message the new code cannot emit" was a stale
    `ApexUITests` bundle under `ios/build/dd` — clear its test products (or use a fresh
    derived-data path) before trusting a local result.
  - Not done: the optional favicon web PR (Backlog in MASTER); the App Store submission itself
    (console work, `app-store.md`); the end-to-end proof of the workflow (needs the secrets).
