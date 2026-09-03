# W11 — Profile, integrations, account

**Machine:** both · **Depends on:** W1 (W2 for realtime-aware sync results) · **Unblocks:** W13
**Status:** blocked on W1

## Goal
The You tab root and every integration the web profile offers, plus the App Store's
account-deletion requirement.

## Scope
In:
- Backend (Linux): account deletion already exists (`DELETE /api/account`, PR #93) — nothing to add;
  `provider-sync connect-start { client: 'ios' }` + **migration `provider_connections.client`**
  (claim with `scripts/next-phase.sh` at PR time) + callback redirect to
  `apextraining://connected?provider=coros` / `connect_error`; add the web's Delete account
  entry; `scripts/auth-redirect-check.sh` asserts `/auth/callback`.
- You root: avatar picker (24), display name, email, HR zones, change password, sign out,
  About (Terms / Privacy links), Delete account (typed confirmation).
- AI Coach: goal (rotating placeholder), context, Anthropic key save/replace/remove with
  masked last-4 and Anthropic's error text (PR #90 behaviour), model picker (PR #91).
- Activity log (`/api/mutations-log`).
- Calendar feed: URL, copy, share sheet, `webcal://` subscribe.
- AI connector: endpoint, mint token (one-time reveal + copy), token list/revoke, connected
  apps/disconnect, guide screen (existing figures as images).
- COROS: connect via `ASWebAuthenticationSession(callbackURLScheme: "apextraining")`,
  reconnect, disconnect, auto-sync toggle (optimistic + revert), Sync now → preview → per-fill
  confirmation sheet queue ("Keep separate" / "Fill it", "N more") → apply; pending-fill badge.
Out: push (Backlog).

## Acceptance
- Integration: delete-account removes every `user_id` row; `client:'ios'` round-trips through
  the callback redirect; migration types regenerated (`db:types` TS + Swift).
- Device: COROS connect completes inside the app; a sync fills a planned workout and the
  event sheet shows metrics; key save shows Anthropic's message on a bad key.
- Snapshots: You root, key section, token reveal, sync confirmation sheet.

## Session log
- (none yet)
