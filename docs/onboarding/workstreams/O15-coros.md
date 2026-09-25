# O15 — COROS tips + `connect-coros` page

**Wave:** 2 · **Depends on:** O03, O04 · **Unblocks:** O16 external shots
**Status:** ready · branch `feat/help-coros` · port 5229 · lock slot e2e_slot_1

## Tips (`src/lib/onboarding/tips/coros.ts`) — all gated on `useProviderSync().configured`
| id | trigger | condition |
|---|---|---|
| coros-connected | `ProviderSyncControls` after the `?connected=coros` return | next calendar mount (a toast fires today; the tip follows it, not over it) |
| coros-fill-queue | `ProviderSyncControls` | first render of `sync-confirm-card` |
| coros-expired | `ProviderSyncControls` / `CorosConnection` | `status === 'expired'` |

## Help page `help/connect-coros.md`
Problem: "I want my watch runs to show up without typing." Shots: 01 Profile → COROS not
connected with **Connect COROS** (mock, route status `disconnected`, `configured:true`);
external placeholders 02 COROS sign-in (375, redact email), 03 COROS consent naming Apex
(375); 04 the **Sync** button in the top nav (mock, connected); 05 the Fill it / Keep
separate card (mock, reuse `e2e/mock/coros-sync.spec.ts`'s proposals); 06 a workout with
metrics + heart-rate chart (mock — add a streams stub via `page.route`); 07 connected with
the nightly toggle and **Disconnect COROS**. Explain nightly sync and Reconnect.

## Ownership
`src/components/sync/*`, `src/components/profile/CorosConnection.tsx`,
`src/lib/onboarding/tips/coros.ts`, `help/connect-coros.md`, `public/help/connect-coros/`,
`e2e/shots/connect-coros.shots.ts`, `src/styles/help/connect-coros.css`,
`e2e/mock/tips-coros.spec.ts`, this file.

## Session log

### 2026-09-24 — O15 lane (feat/help-coros)
- Tips: all three offered from `ProviderSyncControls` (it already holds the status; no second
  `useProviderSync` mount), `coros-expired` also from `CorosConnection`. `coros-connected` needs a
  device mark (`localStorage` `apex:coros-just-connected`) written by the `?connected=coros`
  return and read at mount, so the return load shows only the toast and a later load offers the
  tip. Copy names the circling-arrows icon, since the nav button is icon-only under 768px.
- `sync-confirm-card` gets an opaque background (inline, in the component): the shared
  `chat-confirm-card` tint is 6% over transparent, so the floating card's text collided with the
  calendar under it. Worth moving to `app.css` `.sync-confirm` when that file is open again.
- Help page + shots: 01, 04 (phone + desktop), 05, 06, 07 generated; 02 sign-in and 03 consent are
  `EXTERNAL:` placeholders for O16.
- e2e: `e2e/mock/tips-coros.spec.ts` marks every other tip seen, so each test keeps its
  one-per-load slot once the wave-2 lanes combine.
- 2026-09-25 · orchestrator. Merged as #336; coros-expired now names Reconnect COROS, checkbox reworded (#338); 2 external shots pending.
