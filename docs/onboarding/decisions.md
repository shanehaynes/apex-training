# Progressive onboarding — decisions

Append-only. One entry per decision, with the options that were on the table. The iOS log
(`docs/ios/decisions.md`) uses plain D-numbers; this one uses D-O to keep the two apart.

## D-O01 · "Seen" lives in `profiles.tips_seen`, mirrored locally until the column is in prod
**Status:** decided · Shane · 2026-09-24
- **Options.** (a) A JSONB column on `profiles`, written through `PATCH /api/profile` like
  `onboarding_dismissed_at` — cross-device, shared with iOS, but a migration (HELD, applied to
  prod by hand, historically weeks late). (b) localStorage only — no migration, but a tip
  returns on every new device or browser and iOS keeps its own flags.
- **Decision.** (a), with the client tolerating the column's absence: `loadProfile` is
  `select('*')`, so the key is `undefined` until the migration lands; the client PATCHes only
  when the key is present and always mirrors to `localStorage['apex:tips-seen:<userId>']`;
  the server answers 409 `column-missing` rather than 500. Nothing waits on the migration.
- **Shape.** `tips_seen JSONB NOT NULL DEFAULT '{}'` (id → ISO timestamp), same "when" posture
  as `onboarding_dismissed_at`; no backfill — tips are useful to the few existing users too.

## D-O02 · Tips are plain cards on the `.modal` pattern, not anchored coachmarks
**Status:** decided · Shane · 2026-09-24
- **Options.** (a) A card (bottom sheet on a phone) with title, one or two sentences, **Got
  it**, optional **Show me how** — reuses the existing `createPortal` + `.modal-backdrop` +
  `.modal` pattern. (b) A bubble with an arrow pointing at the exact button — slicker, but the
  app has no popover primitive, and anchored bubbles break inside scrolling overlays and on
  phones.
- **Decision.** (a). One tip per app load, never over `WelcomeFlow` or a blocking dialog,
  z-index 150 (above every overlay, below toasts), no `useModalChrome` (its scroll lock is
  last-writer-wins and would unlock the overlay beneath). Copy names the button; the card does
  not point at it.

## D-O03 · Help is a route (`/help/<slug>`), signed-out reachable, opened in a new tab
**Status:** decided · orchestrator · 2026-09-24
- **Options.** (a) An in-app overlay flag (`helpOpen`) like Library — stays inside the SPA
  but is unreachable signed out or from an email, and opening it mid-tracker risks the
  tracker's state. (b) A path match in `App.tsx` above `AuthProvider`, like `/terms` — works
  from anywhere, needs no `vercel.json` change (the rewrite already covers it), and a
  `target="_blank"` link never unmounts a live tracker or builder. (c) Keep the guide on
  GitHub — not Apex-hosted, no screenshots.
- **Decision.** (b). Tips and the intro link with `<a href="/help/<slug>" target="_blank">`;
  iOS opens the same URL in an in-app browser. `GUIDE_URL` becomes `/help`.

## D-O04 · Screenshots are Playwright generator specs; PNGs are committed
**Status:** decided · orchestrator · 2026-09-24
- **Options.** (a) Hand-drawn SVG figures like `ConnectorGuide` — deterministic, but Shane
  asked for real screenshots. (b) Hand-taken screenshots — drift the moment the UI changes.
  (c) `e2e/shots/<slug>.shots.ts` in two Playwright projects (`shots-phone`, `shots-desktop`)
  that drive the mock app and write `public/help/<slug>/<nn>-<name>.<phone|desktop>.png`; a
  vitest checks every referenced PNG exists and every PNG is referenced.
- **Decision.** (c). The projects are excluded from `--project=mock`, so CI never runs them.
  Fonts render as fallbacks until Inter/JetBrains Mono are installed locally. External sites
  (console.anthropic.com, coros.com, Apple/Google Calendar) cannot be mocked: the orchestrator
  captures them through Chrome in one serialized step and Shane reviews each file; until then
  the page carries an `<!-- EXTERNAL: … -->` placeholder the test tolerates.

## D-O05 · The intro is four cards, the coach card included
**Status:** decided · Shane · 2026-09-24
- **Options.** (a) Three cards, the coach introduced by a tip on first chat — the lightest
  intro. (b) Four cards, the coach card carrying **Add key** and a link to
  `/help/get-api-key` — front-loads the hardest setup step, but the coach is the feature that
  makes Apex different and the key is the one thing a user cannot discover alone. (c) Keep the
  eight-step tour and add tips on top.
- **Decision.** (b). The other four of the old eight steps become tips or help pages
  (`MASTER.md`, "Intro"). No new `ActionKind`, so the HELD `ios/scripts/` generator is
  untouched.

## D-O06 · A Claude subscription is researched, not built
**Status:** decided · Shane · 2026-09-24
- **The question.** Shane asked the API-key help page to cover users who already pay for
  Claude ("an OAuth key if they already have a subscription"). Today the app accepts only an
  Anthropic API key; a claude.ai subscription does not include API access, and the repo's
  own use of subscription entitlement (the eval gate, D-047) runs through the Agent SDK on a
  developer machine with no documented policy for a per-user, unattended path.
- **Decision.** Lane O06 (read-only) reports what is and is not possible; the help page
  states the honest current answer (a key from console.anthropic.com is separate from a
  subscription) and that a subscription path is being looked into. Nothing ships from the
  research without a decision here.
- **Update 2026-09-24 (O06 report, [research/anthropic-subscription-oauth.md](research/anthropic-subscription-oauth.md)).**
  Not supported and expressly prohibited: Anthropic's legal-and-compliance page forbids
  third-party apps from offering claude.ai login or routing requests through Pro/Max
  credentials, and subscription tokens are rejected server-side outside Claude Code. The
  only technically-working path (a `setup-token` stored by Apex, driven through the Agent
  SDK) is the named prohibited conduct. **Recommendation: research only, do not build**; the
  help page uses the report's §3 wording; re-open if Anthropic publishes a developer
  approval / "Sign in with Claude" programme or an explicit hosted-app path. Shane to confirm.

## D-O07 · A tip spec isolates itself from every other lane's tips
**Status:** decided · orchestrator · 2026-09-25 · wave-2 fold
- **The problem.** Each lane's spec passed alone and failed on the fold: with nine lanes'
  `useTip` calls live, the calendar under every screen offers `day-complete-circle`
  (priority 1, first in the catalog) and the coach rail offers `coach-first-message`
  (priority 0) on any desktop load with a key, so another lane's tip took the one slot per
  load — or its backdrop swallowed the next click. The tips-core spec's demo tip lost the
  same tie.
- **Decision.** Every tip spec serves a profile whose `tips_seen` marks every catalog id
  outside its own lane as seen, built from `TIPS` so future tips stay excluded; `TipHost`
  offers only the demo tip while `__APEX_TIPS_DEMO__` is set; the live e2e project sets
  `__APEX_TIPS_OFF__` like the mock fixtures do (#327, #328, #329, #331). The rule now
  lives in `MASTER.md`'s brief skeleton.
- **Rejected.** Lowering the calendar tip's priority (it is the right first tip for a
  phone user) and dropping the one-per-load rule (the point of the design).
- **Closed 2026-09-25 (Shane): research only.** The API-key help page carries the O06 §3
  wording for subscribers. Re-open if Anthropic publishes a developer approval / "Sign in
  with Claude" programme for third-party apps, or an explicit hosted-app path for the
  Agent SDK credit programme.
