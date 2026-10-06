# W15 — Connector access level

**Machine:** Mac · **Depends on:** W11, backend #371 (merged 2026-10-06) · **Unblocks:** —
**Status:** in review (PR #379)

## Goal
The phone offers the same choice the web does when it mints a connector token — look-only or
full access — and tells the truth about what each token and connected app may do, now that
`/api/mcp` can change data for a token whose scope names `mcp:write`.

## Backend contract consumed
Landed in #371 (web PR; `docs/ios/backend-changes.md` W15 addendum):
- `POST /api/mcp-tokens { name, access: 'full' | 'read' }` — **absent `access` mints read-only**,
  which is exactly what the app did before this workstream (it sent only `name`). The level is
  fixed at mint.
- `GET /api/mcp-tokens` tokens and connections carry `scope: string | null`. `mcp:write` in it
  means the holder may change data; `null` is a token or grant from before write access existed,
  read-only for life.
- Fixture `ios/Fixtures/mcp-tokens.json` already carries the field (regenerated in #371: the
  emitter's token is `mcp:read`, the seeded connection `null`).

## Scope
In:
- `ApexCore`: `McpAccess`, `McpScope.grantsWrite`, `scope`/`canWrite` on `McpToken` and
  `McpConnection`; `mintMcpToken(name:access:)` with `access` required.
- `ConnectorModel`: `allowChanges` (default on, like the web's tick box), sent on every mint;
  `mintedCanWrite` for the reveal sheet; `read-only` tag on the token and connection lines, only
  where it applies.
- `ConnectorView`: a **Can make changes** switch under the name field while naming a token,
  with a footer that states the consequence either way; the reveal sheet says which kind it
  minted; the hint reworded to the web's.
- `ConnectorGuideView`: intro, shield callout and glossary reworded to the web's
  (`ConnectorGuide.tsx`): "You choose how much it can do", "Access level" in place of
  "Read-only".
- Mock: the mint honours `access` (read-only when absent, as the server does).
- Tests: endpoint body, fixture decode (`scope`, `canWrite`), scope rule, model lines, the
  mint's `access`; snapshots re-recorded for `connector`, `connector-axxxl`, `token-reveal`,
  `connector-guide`.
Out:
- Changing a token's level after mint (the server forbids it; revoke and mint again).
- A per-connection level on the phone — OAuth consent happens on the web's `/connect` page.
- The figures (drawings) in the guide: the consent-screen drawing says what the web's
  `ConnectorFigures.tsx` says; regenerate with `gen-connector-figures.ts` only if that changes.

## Acceptance
- `swift test --package-path ios/Packages/ApexCore` green (fixture contract decodes `scope`).
- `ApexTests/YouModelTests` + `YouSnapshotTests` green on the iPhone 17 (26.5) simulator;
  snapshots reviewed.
- Smoke `testYouOnFixtures` still mints a token through the row → name → Create → reveal flow
  (the switch defaults on, so the leg is unchanged).

## Session log
- 2026-10-06 · Mac · Opened after #371/#376 shipped write access on the web. Everything above
  implemented in one pass; `swift test` 432 green (22 fixture-contract tests incl. the new scope
  rule). Decision D-050: the phone's switch defaults ON and always sends its answer, because the
  server's absent-`access` default is read-only on purpose — a client that cannot show the choice
  must not widen a token by omission, and this client now can.
