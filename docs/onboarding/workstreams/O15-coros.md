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
