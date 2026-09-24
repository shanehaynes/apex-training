# O05 — Welcome trim: four cards

**Wave:** 1 · **Depends on:** O01 · **Unblocks:** — (independent of O03/O04)
**Status:** ready · branch `feat/welcome-four-cards` · port 5214 · wakes the iOS job (generated catalog)

## Goal
The first-run tour is the four cards in MASTER.md, "Intro", and every link it carries is
Apex-hosted.

## Scope
In:
- `src/lib/onboarding/content.ts` — `WELCOME_STEPS` → `welcome`, `plan`, `log`, `coach`
  (bodies and `iosBody` from MASTER.md); `coach.link = { label: 'Get an API key', href: '/help/get-api-key' }`;
  `GUIDE_URL = '/help'`; fix the comment that says a relative path 404s (the SPA rewrite +
  `App.tsx` match make it valid). No new `ActionKind` or `ChecklistId`. The `key` checklist
  hint gains "→ Get an API key" (plain text; the row's button stays `open-profile`).
- `node ios/scripts/gen-onboarding-catalog.mjs` → commit the regenerated
  `ios/Packages/ApexCore/Sources/ApexCore/Onboarding/Generated/OnboardingCatalog.swift`.
  Do not edit `ios/scripts/` (HELD).
- `src/components/onboarding/WelcomeFlow.tsx` — the `link` renders with `target="_blank"`
  as today; drop "Step N of M" text if the four dots alone read well on a phone (iOS did,
  D-042); keep `.welcome__count` only if a spec depends on it — update the spec instead.
- `src/components/onboarding/GettingStarted.tsx` — `EXTRA_NOTES`/footer "Read the full
  guide" → `/help`.
- `e2e/mock/onboarding.spec.ts` — `STEPS_WITHOUT_COROS = 4`; last card's link.
- `src/lib/onboarding/__tests__/*` — whatever pins step ids.
Out: tips, help pages, iOS Swift tests (the later parity session).

## Acceptance
- `npm run agent:check` green, including `ci:guards`' catalog `--check`.
- Phone viewport: each card fits without scrolling at 375×812.

## Session log
