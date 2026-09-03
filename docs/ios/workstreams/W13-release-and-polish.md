# W13 — Release engineering + polish

**Machine:** Mac · **Depends on:** everything · **Unblocks:** App Store submission
**Status:** blocked

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
- (none yet)
