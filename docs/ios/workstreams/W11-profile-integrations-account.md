# W11 — Profile, integrations, account

**Machine:** both · **Depends on:** W1 (W2 for realtime-aware sync results) · **Unblocks:** W13
**Status:** backend in review (PR pending, `feat/w11-backend`) · You tab UI is the Mac session's

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
- 2026-09-11 · backend (Linux) · The half the Mac cannot prove. **Migration** `phase41_provider_client.sql`
  (`provider_connections.client`, nullable, no CHECK — the phase38 call); `connect-start` takes
  `{ client: 'ios' }`, validates it beside `provider` and ahead of the rate limit, and `beginOAuth`
  writes it unconditionally so an abandoned iOS attempt cannot redirect a later web connect.
  **`providerCallback`** now reads the pending row *before* every failure branch — it is the only
  place the client is recorded, and the two commonest failures (declining at COROS, and a consent
  screen left past the 10-minute TTL) have to dismiss `ASWebAuthenticationSession` just as a
  success does. That needed `findPendingByState` to return a `PendingLookup` carrying `client` on
  both arms; an expired row otherwise stranded the in-app browser on a web page. Reasons:
  `denied` · `missing_code` · `expired` · `exchange_failed`, iOS only — the web's
  `/?connected=coros` and `/?connect_error=coros` are byte-identical, 302, no `reason` param.
  **`GET /api/profile` widened** to the rest of the `profiles` row plus a server-composed
  `calendarFeedUrl` and the coach model catalog, so the You tab reads one endpoint rather than the
  table and nobody hand-ports `models.ts` (the W6 precedent, D-008). **Tests**: `providerCallback`
  had none — it has ten now; `provider-sync` covers persist/null/400. **Fixtures**: six new
  (`mutations-log`, `mcp-tokens`, `mcp-token-mint`, `provider-status`, `provider-preview`,
  `provider-apply`) plus a regenerated `profile.json`, emitted on agent2 because the connection row
  and the token list are per-user singletons that other files in the directory already own on
  agent. Two scrubbing rules added to `normalize()`: a uuid inside a `?token=` URL (the feed URL
  would have committed a working ICS token) and the minted PAT — plus `token_last4`, which is
  re-minted every run and would have failed the drift check rather than a real shape change.
  **ApexCore**: 20 endpoints, the `Integrations.swift` models, `ProfileResponse` + 8 optionals, and
  a `DeepLink` fix — `.connectError` parsed `message`/`error` but never `reason`, so the callback's
  code would have decoded to nil. 321 `swift test` green (swift:6.1 in Docker; no native toolchain
  on this machine).
- Scope items closed with no code: `scripts/auth-redirect-check.sh` already asserts
  `/auth/callback` and passes all five checks (Shane added it 2026-09-09); `DELETE /api/account`
  needs nothing, and `provider_connections` is covered by the `account.test.ts` sweep through
  `REDACTED_TABLES` — deliberately excluded from the *export* because the tokens are encrypted,
  while deletion rides `ON DELETE CASCADE`.
- Left for the Mac session: every screen in Scope above, the four snapshots in Acceptance, the
  device runs (COROS connect inside the app, a fill, a bad key), and `ProviderSyncControls`-style
  copy. The Endpoint cases and models it consumes are all in this PR.
