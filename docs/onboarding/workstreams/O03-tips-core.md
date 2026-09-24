# O03 — Tips core

**Wave:** 1 · **Depends on:** O01 · **Unblocks:** every wave-2 lane
**Status:** ready · branch `feat/tips-core` · port 5212

## Goal
`useTip('<id>', when)` in any component shows that tip once per account, one at a time,
remembered on the server when the column exists and locally always.

## Scope
In:
- `src/context/TipsContext.tsx` — candidates register/unregister by id (+ `when`); exposes
  `pending`, `dismiss()`.
- `src/hooks/useTip.ts` — `useTip(id: TipId, when = true): void`; registers on mount while
  `when`, unregisters on unmount. Renders nothing.
- `src/components/onboarding/TipHost.tsx` — the arbiter (MASTER.md, "Tips"): eligibility,
  ordering (priority → conditioned → catalog order), 600 ms settle, one per page load,
  deferral on small viewport / focused input, `window.__APEX_TIPS_OFF__` kill switch.
- `src/components/onboarding/TipCard.tsx` — `createPortal`, `div.modal-backdrop.modal-backdrop--tip`,
  `div.modal.tip` with `role="dialog" aria-modal aria-labelledby`; **Got it**; **Show me how**
  as `<a href={helpPath(slug)} target="_blank" rel="noreferrer">`. Backdrop tap = Got it.
  No `useModalChrome`. Phone: bottom sheet clear of `MobileBottomNav`.
- `src/styles/tips.css` — `.modal-backdrop--tip { z-index: 150 }`, `.tip`, phone variant.
- `src/components/onboarding/OnboardingHost.tsx` — mount `<TipHost />` after the WelcomeFlow
  early return, regardless of `overlayOpen`.
- `src/context/AuthContext.tsx` — `markTipSeen(id)`: optimistic `setProfile`, localStorage
  mirror `apex:tips-seen:<userId>`, `patchJson('/api/profile', { tip_seen: id })` only when
  `'tips_seen' in profile`; `tipsSeen` = server ∪ local exposed on the context.
- `src/lib/db/types.ts` — `tips_seen?: Record<string, string>` on `ProfileRow`.
- `api/_lib/handlers/profile.ts` — `tip_seen` in the PATCH allowlist validated with
  `isTipId` (import `../../../src/lib/onboarding/tips/index.js`); read-merge-write; add
  `tips_seen` to the `profileFields` select; `tipsSeen: string[]` in the GET `onboarding`
  block; 42703 / PGRST204 → 409 `column-missing`. Tests in `api/__tests__/profile.test.ts`.
- `e2e/lib/session.mjs` — `driverProfile()` gains `tips_seen: {}`.
- `e2e/lib/fixtures.ts` — option `tips: 'off' | 'on'`, default `'off'` → init script sets
  `window.__APEX_TIPS_OFF__ = true`.
- `e2e/mock/tips-core.spec.ts` — fresh profile, `tips: 'on'`: one tip per load; Got it
  persists (PATCH stub); Show me how opens a new page at `/help/<slug>`; no tip while
  WelcomeFlow is up; default `'off'` shows nothing.
- `src/lib/onboarding/__tests__/tipHost.test.ts` — the pure ordering/eligibility function.
Out: any feature trigger site, any help page, `content.ts`, `tips/<feature>.ts`.

## Acceptance
- `npm run agent:check` green with the existing suite unchanged (tips off by default).
- With a stubbed profile lacking `tips_seen`, Got it still latches for the session and
  survives reload (localStorage); no request is made.

## Session log
