# Progressive onboarding — master document

**Start here.** This is the master document for the web app's progressive onboarding: a
short first-entry intro, contextual tips the first time a user reaches a feature, and
Apex-hosted help pages with real screenshots. It holds the big picture; the board and the
briefs hold the detail. A Claude session picking up onboarding work follows the
[session protocol](#session-protocol) before anything else.

| Document | What it holds |
|---|---|
| [STATUS.md](STATUS.md) | Living board: lane states, ports, next up, recent sessions |
| [decisions.md](decisions.md) | Every decision with the options considered |
| [workstreams/](workstreams/) | One self-contained brief per lane (O01–O16) |
| [research/](research/) | Read-only lane reports (O06: subscription OAuth) |
| [../ios/MASTER.md](../ios/MASTER.md) | The iOS app — mirrors this flow later, content-equal |

## Vision

Apex has many features, most of them behind overlays. A new user — assume a tech-illiterate
adult on a phone — should meet only what gets them to their first logged workout, and then
learn each feature the moment they first reach it, in plain words, with a picture when the
thing needs setting up. Nothing is explained twice, nothing is explained early, and nothing
that needs a website of its own (an API key, a watch, a calendar subscription) is left to a
paragraph.

## Principles

1. **Four cards, then silence.** The intro is exactly four cards (calendar, put something on
   it, log a workout, the coach needs a key). Everything else is a tip or a help page.
2. **One tip at a time, once per account.** A tip is a plain card — title, one or two
   sentences, **Got it**, optionally **Show me how**. At most one per app load, never over the
   intro or a blocking dialog, remembered in `profiles.tips_seen` so it does not come back on
   another device.
3. **Setup gets a page with pictures.** `/help/<slug>` is served by Apex, works signed out,
   and its screenshots are generated from the mock app by Playwright — regenerated, never
   hand-taken. External sites are captured once by the orchestrator and reviewed by Shane.
4. **Copy is data.** Intro copy stays in `src/lib/onboarding/content.ts`; tip copy lives in
   `src/lib/onboarding/tips/<feature>.ts`, one file per lane, data only, so the server can
   validate ids and the iOS app can compile the same words.
5. **The repo's rules apply unchanged**: worktree per lane, claims, HELD paths, `agent:check`,
   phase numbers claimed at PR time ([CLAUDE.md](../../CLAUDE.md)). The parallel-agents skill
   is the fleet protocol.

## Decisions in one glance

| Topic | Decision | Ref |
|---|---|---|
| Where "seen" lives | `profiles.tips_seen` JSONB; localStorage mirror until the column is in prod | D-O01 |
| Tip form | Card / bottom sheet on the `.modal` pattern; no anchored coachmarks | D-O02 |
| Help delivery | `/help/<slug>` route, signed-out reachable, opened in a new tab | D-O03 |
| Screenshots | Playwright generator specs in `e2e/shots/`, PNGs committed under `public/help/` | D-O04 |
| Intro | Four cards, coach card included, linking `/help/get-api-key` | D-O05 |
| Subscription OAuth | Research only (O06); the app takes API keys | D-O06 |

## Architecture

### Storage — `profiles.tips_seen`
- Migration (`db/tips-seen`, HELD): `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tips_seen
  JSONB NOT NULL DEFAULT '{}'::jsonb` + `CHECK (jsonb_typeof(tips_seen) = 'object')`. No
  backfill. Then `npm run db:reset-local && npm run db:types`.
- API: `PATCH /api/profile { tip_seen: '<id>' }` — validated with `isTipId` from
  `src/lib/onboarding/tips/index.js`; read-merge-write `tips_seen[id] = now()` server-stamped;
  `tips_seen` joins the `profileFields` select; GET's `onboarding` block gains
  `tipsSeen: string[]` for iOS. A missing column (42703 / PGRST204) answers 409
  `column-missing`, never 500.
- Client: `AuthContext.markTipSeen(id)` — optimistic, then `patchJson` fire-and-forget like
  `dismissOnboarding`. **Column-presence gate:** `loadProfile` is `select('*')`, so before the
  migration reaches prod the key is `undefined`; PATCH only when `'tips_seen' in profile`, and
  always mirror to `localStorage['apex:tips-seen:<userId>']`. Seen = server ∪ local. This is
  why nothing waits on the HELD migration.

### Tips — catalog + arbiter
- Catalog: `src/lib/onboarding/tips/{types,index,<feature>}.ts`. Ids are pre-declared; a
  feature lane refines copy in its own file and never edits `index.ts`.
- `useTip(id: TipId, when = true)` (`src/hooks/useTip.ts`) is called inside the feature
  component at the first-open site. It registers a candidate with `TipsContext`; it renders
  nothing.
- `TipHost` (mounted from `OnboardingHost` **below** the WelcomeFlow return, so a tip can never
  sit over the intro) picks one candidate: profile loaded, not the template source,
  `onboarding_dismissed_at` set, id unseen, `window.__APEX_TIPS_OFF__` unset; order =
  priority, then a `when`-conditioned tip beats an unconditioned one, then catalog order;
  600 ms settle; one per page load; deferred while `visualViewport.height < 500` or an input
  has focus. `TipCard` = `createPortal` + `div.modal-backdrop.modal-backdrop--tip`
  (z-index 150) + `div.modal.tip role=dialog`; **Got it** marks seen; **Show me how** marks
  seen and opens `<a href="/help/<slug>" target="_blank" rel="noreferrer">`. Backdrop tap =
  Got it; Escape ignored. No `useModalChrome` (its scroll lock is last-writer-wins). CSS in
  `src/styles/tips.css`.
- e2e: `driverProfile()` carries `tips_seen: {}`; the fixture option `tips: 'off' | 'on'`
  defaults to `'off'` (an init script sets `window.__APEX_TIPS_OFF__`), so no existing spec
  ever sees a tip; tip specs opt in.

### Help pages — `/help`, `/help/<slug>`
- `src/lib/help/pages.ts` lists the pages; `help/<slug>.md` is the source
  ([help/README.md](../../help/README.md) has the format); `public/help/<slug>/` holds the PNGs.
- Renderer: `src/lib/legal/markdown.ts` gains an `image` block and `helpMarkdownViolations`
  (`legalMarkdownViolations` stays image-free); `renderBlock/renderInlines` move to
  `src/components/legal/MarkdownBlocks.tsx`; `src/components/help/{HelpPage,HelpIndex}.tsx`;
  `App.tsx` matches `/help` and `/help/<slug>` above `AuthProvider`. `vercel.json` needs no
  change. CSS: `src/styles/help.css` + `src/styles/help/<slug>.css`.
- Guard: `src/lib/help/__tests__/documents.test.ts` — every page parses clean, every
  referenced PNG exists (or sits under an `EXTERNAL:` comment), every PNG is referenced.
- Entry points: intro card 4, tips, a **Help** row in Profile; `GUIDE_URL` becomes `/help`.

### Screenshot pipeline
- `playwright.config.ts`: projects `shots-phone` (375×812) and `shots-desktop` (1280×950),
  `testDir: 'e2e/shots'`, `deviceScaleFactor: 2`, `fakeNow` pinned. CI and `npm run e2e` use
  `--project=mock`, so shots specs are generators, never tests.
- `e2e/lib/helpShots.ts`: `helpShot(page, { slug, n, name, highlight? })` → 400 ms settle,
  optional outline ring, `public/help/<slug>/<nn>-<name>.<phone|desktop>.png`.
- `e2e/shots/<slug>.shots.ts` imports `test` from `../lib/fixtures`; extra data via
  `page.route` inside the spec only.
- Fonts: Inter and JetBrains Mono are not installed on the Linux box; until they are
  (`sudo apt install fonts-inter fonts-jetbrains-mono`) shots use fallback fonts.

### Intro (four cards) — `WELCOME_STEPS`
| id | title | body | action / link |
|---|---|---|---|
| welcome | Welcome to Apex | Your calendar is home. Every workout sits on a day. Tap a day to see what is planned, and tap a workout to open it. | — |
| plan | Put something on it | Start fast with Shane's ready-made weekly plan. Change or delete any of it later. Or add your own workout with the **+** button at the bottom. (iosBody: "…the **+** at the top.") | **Copy the starter plan** (`copy-template`) |
| log | Log a workout | Open a workout and press **Start Workout** to log each set as you go. In a hurry? **Mark as Complete** records it in one tap. (iosBody: **Mark Complete**) | — |
| coach | Meet your coach | The **Coach** tab answers questions about your training and can plan workouts for you. It needs a key from Anthropic first — a few minutes, billed to you, not Apex. | **Add key** (`open-profile`); link **Get an API key** → `/help/get-api-key` |

No new `ActionKind` or `ChecklistId`, so `ios/scripts/` stays untouched; regenerate and commit
`OnboardingCatalog.swift`; `STEPS_WITHOUT_COROS` → 4. `CHECKLIST_ITEMS` and `SetupNudge`
stay (state-driven, not tips). iOS fallout for the later parity session: step-count tests and
a relative `URL(string:relativeTo:)` in `WelcomeFlowView`.

### Tip catalog
The 25 tips, their trigger sites and their help links are in
`src/lib/onboarding/tips/<feature>.ts` (copy) and each lane's brief (trigger). Dropped as
redundant with on-screen copy: coach-no-key, builder-scope, cycle-preview, exercise-editor,
tracker-swap, coach-model, tile-excluded, today-button.

### Help pages (five + index)
| slug | lane | shots |
|---|---|---|
| get-api-key | O10 coach | Ext: console sign-up, billing/credits, API keys empty + **Create Key**, create-key dialog with **Workspace** set to a named workspace (unscoped keys 400), key reveal (redact all but `sk-ant-`). Mock: Profile key disclosure empty (`hasKey:false`), key saved. Sections: what a key is; steps; **Already pay for Claude?**; troubleshooting |
| connect-coros | O15 coros | Mock: Profile → COROS not connected (`configured:true`), **Sync** button, Fill it / Keep separate card, workout with metrics (needs a streams stub), connected + nightly toggle. Ext: COROS login, consent |
| calendar-feed | O14 profile | Mock: Profile → Calendar feed. Ext: iOS Calendar subscribe, Google Calendar From URL, result |
| logging-a-workout | O09 tracker | Mock: workout modal buttons, grey numbers, one set typed, unlogged bar, summary with a trophy (needs a `prs` stub), desktop tracker |
| repeating-workouts | O08 workout | Mock: RepeatPicker On + days + Ends Never, recurring workout open, exercise-editor series note, This day only / Whole series, delete scope |

## Copy rules

Grade-6 reading level; ≤ 15 words per sentence; tip body ≤ 35 words, title ≤ 5; exactly one
imperative action verb in the first sentence; buttons named by their on-screen label in bold;
never "simply" or "just". Banned → replacement: API key → "a key from Anthropic (a code)";
token → code; sync (as a verb) → connect / bring in; 1RM → estimated best single lift;
PR → personal record; OAuth / MCP / JSON / ICS / endpoint / RRULE → never.
`src/lib/onboarding/tips/__tests__/catalog.test.ts` enforces the counts; lane O16 audits the
rest.

## Fleet

### Shared state
| Resource | Treatment |
|---|---|
| `app.css`, `App.tsx`, `AuthContext.tsx`, `profile.ts`, `OnboardingHost.tsx`, `content.ts`, `tips/index.ts`, `e2e/lib/*`, `playwright.config.ts`, `STATUS.md` | Owned by one wave-1 lane each, then orchestrator-owned; wave-2 lanes are forbidden |
| `tips/<feature>.ts`, `help/<slug>.md`, `public/help/<slug>/`, `e2e/shots/<slug>.shots.ts`, `src/styles/help/<slug>.css`, `workstreams/O<nn>.md`, component dirs | Partitioned — exactly one lane each |
| Dev port | Explicit `APEX_PORT` per lane (STATUS.md); vite `strictPort` fails loudly on a clash |
| Playwright CPU | Full `agent:check` only under `.claude/skills/parallel-agents/scripts/with-lock.sh e2e_slot_{1,2,3}`; the light gate is lock-free |
| Local Supabase | Only the migration lane, via `scripts/with-stack-lock.sh` |
| Migration number | Orchestrator claims via `scripts/next-phase.sh` at PR-open |
| `gh`, PRs, merges | Orchestrator only; lanes push their branch and report |
| `ios/` | Only O02 (generated DB types) and O05 (generated catalog) may diff it — each wakes the 30–70 min macOS job |

### Waves
- **Wave 0** — O01 scaffold (this document, the catalog stubs, help stubs, CSS files, dirs).
- **Wave 1** (parallel, files disjoint) — O02 migration `db/tips-seen` (HELD), O03 tips core
  `feat/tips-core`, O04 help shell `feat/help-pages`, O05 welcome trim
  `feat/welcome-four-cards`, O06 research (read-only). Gate:
  `scripts/combine-check.sh --check <the four branches>`; PR order O02 → O05 → O03 → O04.
- **Wave 2** (nine parallel feature lanes, after wave 1 merges) — O07 calendar, O08 workout,
  O09 tracker, O10 coach, O11 builder, O12 library + meals, O13 blocks + analytics,
  O14 profile, O15 COROS. Each: copy in its `tips/<feature>.ts`, `useTip` calls at the
  first-open sites in its component dir, its help page and shots spec.
- **Wave 3** — O16: copy audit (read-only), `app-verifier` fresh-profile walk on the folded
  tree, external screenshots (orchestrator via Chrome, Shane reviews), `WELCOME.md` refresh,
  board close-out, `scripts/git-tidy.sh --yes`, prod verify.

### Gates
- Light, every commit: `tsc -b && vitest run && oxlint && playwright test --project=mock
  e2e/mock/tips-<f>.spec.ts && playwright test --project=shots-phone --project=shots-desktop
  e2e/shots/<slug>.shots.ts`.
- Full, once before reporting: `APEX_PORT=<port>
  .claude/skills/parallel-agents/scripts/with-lock.sh e2e_slot_<k> npm run agent:check`
  (`k` = lane number mod 3 + 1, `LOCK_WAIT=3600`).

### Integration
1. After each wave: `scripts/combine-check.sh --check <branches>`. A conflict is fixed by
   moving a hunk, never by stacking.
2. Orchestrator opens PRs serially, then `scripts/merge-babysit.sh --yes`. Kill switch:
   `.claude/AUTOMERGE_OFF`.
3. Prod stays safe before the migration lands (column-presence gate, localStorage mirror,
   409 on a missing column).
4. Merge at most ~20 PRs a day (Vercel's Hobby deploy cap has stopped a train before).

### Wave-2 brief skeleton
Every wave-2 lane gets this, filled in from its `workstreams/O<nn>.md`:

```
## Goal
Ship the <feature> onboarding: refine the tips in src/lib/onboarding/tips/<f>.ts (ids are
pre-declared — replace copy, do not add ids; report a missing one), call
useTip('<id>', <condition>) at the first-open sites in <component dir>, write
help/<slug>.md with real screenshots, generate them with e2e/shots/<slug>.shots.ts.
Why: first-time users must learn <feature> inside the app, in plain words, on a phone.
## Context you need
useTip/TipHost: src/hooks/useTip.ts, src/components/onboarding/TipHost.tsx.
helpShot(page,{slug,n,name,highlight}): e2e/lib/helpShots.ts →
public/help/<slug>/<nn>-<name>.<phone|desktop>.png; reference images as
![alt](/help/<slug>/<nn>-<name>.phone.png). Mock data is pinned at 2026-09-07; add rows with
page.route inside your spec only. Tips are OFF in every existing spec; use
test.use({ tips: 'on' }) in yours. Copy rules: <the block above>.
## Your environment
Lane: /home/shanehaynes/projects/apex-training/.claude/worktrees/<slug>
Branch <branch>, deps installed. Every command: cd <lane> && APEX_PORT=<port> …
Scratch: <scratchpad>/<branch-slug>/.
## Ownership
You own: <exact list>. Do not change: src/styles/app.css, global.css, tokens.css,
tips/index.ts, content.ts, e2e/lib/*, playwright.config.ts, App.tsx, other component dirs,
docs/onboarding/STATUS.md, supabase/, ios/, .github/, scripts/, package*.json.
## Shared state
Never: reset or seed the local DB, touch the primary checkout, open PRs, merge, force-push,
kill processes by name, bare git stash, call gh, edit ios/.
## External screenshots (get-api-key, connect-coros, calendar-feed only)
Do not capture external sites. Write `<!-- EXTERNAL: <url> — <state>, <viewport>,
<redact> -->` above the image line and list each under EXTERNAL SHOTS NEEDED.
## Gate — light gate each commit; full gate once under with-lock.sh e2e_slot_<k>.
## Done — commit, `git -C <lane> push -u origin <branch>`, clean tree, report only.
## If blocked — stop and report; do not widen scope.
## Report
STATUS / BRANCH SHA PUSHED / CHANGED / GATE / NOT VERIFIED / OUTSIDE MY OWNERSHIP /
DECISIONS / FOLLOW-UPS / BLOCKER
+ TIPS: <id → word count> ; SHOTS: <count, both viewports> ;
EXTERNAL SHOTS NEEDED: <url, state, viewport> | none
```

### Risks → mechanisms
| Risk | Mechanism |
|---|---|
| Tips fire inside unrelated e2e specs | fixture default `tips:'off'` → `window.__APEX_TIPS_OFF__` |
| `gen-onboarding-catalog --check` fails a lane | only O05 edits `content.ts`; no new ActionKind; regenerate + commit the `.swift` in the same commit |
| Port reuse | explicit unique `APEX_PORT`, `strictPort`, pre-wave `lsof` sweep, kill by PID on own port only |
| CPU-starved Playwright flakes | three lock slots for full gates; re-run a failed shots spec alone before reporting |
| iOS macOS job queue | only O02/O05 diff `ios/`; merged first; wave-2 reviewer greps `git diff --name-only origin/main... -- ios/` = empty |
| gh rate limit | lanes never call gh; orchestrator serial PR creation; babysitter one in flight |
| Migration unapplied in prod for weeks | column-presence gate + localStorage mirror + 409; `scripts/prod-schema-check.mjs` reports the drift |
| Stale PNGs / broken image links | `documents.test.ts` in `npm test` |
| Fold green, prod broken | `deploy-verify.sh` + `/help` curls after the merge train |
| Tidy removes a fresh lane | `git-tidy.sh` never removes dirty or no-commit worktrees; run only between waves |

## Session protocol

1. Read [STATUS.md](STATUS.md). Pick a lane that is `ready` and whose dependencies are `done`.
2. `scripts/git-new.sh <branch> "<the lane's owned files>"` from the primary checkout; the
   claim is your declaration to the other sessions.
3. Work only inside the lane's ownership list. Anything else is reported under
   OUTSIDE MY OWNERSHIP, never done.
4. Gate as the brief says. Commit, push the branch, report. The orchestrator opens the PR.
5. Before ending: flip the lane's state in STATUS.md (the orchestrator does this for
   subagent lanes), add a line to the brief's session log, append any decision to
   decisions.md.

## What Shane owes

1. `scripts/git-tidy.sh --yes` before wave 1 (36 worktrees, most merged) and, optionally,
   the fonts.
2. `shipit` on the migration PR; apply `phaseNN_tips_seen.sql` in prod — not blocking; until
   then tips are per-device.
3. Being signed in to console.anthropic.com and coros.com in Chrome for wave 3's external
   captures, and reviewing each PNG before it is committed.
4. Later: the iOS parity session, starting from this document and `tips/*.ts`.
