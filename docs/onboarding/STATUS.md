# Progressive onboarding — status board

Living document. **Every session updates this file before it ends**: flip the lane's state,
add one line under "Recent sessions", refresh "Next up". Detail belongs in the lane's brief.

States: `ready` · `in progress (branch)` · `in review (PR #)` · `done (PR #)` · `blocked on …`

| Lane | Title | Wave | State | Branch | Port | Notes |
|---|---|---|---|---|---|---|
| O01 | Scaffold: docs, catalog stubs, help stubs, CSS files | 0 | done (#321) | `chore/onboarding-scaffold` | — | |
| O02 | Migration `profiles.tips_seen` (phase47) | 1 | done (#322) | `db/tips-seen` | 5211 | in prod; `prod-schema-check` exit 0 on 2026-09-26 |
| O03 | Tips core: useTip, TipHost, TipCard, API, local mirror | 1 | done (#324, #327) | `feat/tips-core` | 5212 | server-side since 2026-09-26 (phase47 in prod) |
| O04 | Help shell: `/help` route, images, shots pipeline | 1 | done (#325) | `feat/help-pages` | 5213 | `/help/*` live in prod |
| O05 | Welcome trim: four cards + iOS parity for the intro | 1 | done (#323) | `feat/welcome-four-cards` | 5214 | iOS snapshot tests stale (opt-in) — parity session |
| O06 | Research: subscription OAuth | 1 | done (report in `research/`) | — | — | recommendation: research only; **D-O06 awaits Shane** |
| O07 | Calendar + day view tips | 2 | done (#328) | `feat/help-calendar` | 5221 | |
| O08 | Workout detail tips + `repeating-workouts` page | 2 | done (#329) | `feat/help-workout` | 5222 | |
| O09 | Tracker tips + `logging-a-workout` page | 2 | done (#330) | `feat/help-tracker` | 5223 | |
| O10 | Coach tips + `get-api-key` page | 2 | done (#331) | `feat/help-coach` | 5224 | 5 external shots pending (O16) |
| O11 | Builder tips | 2 | done (#332) | `feat/help-builder` | 5225 | |
| O12 | Library + meals tips | 2 | done (#333) | `feat/help-library-meals` | 5226 | |
| O13 | Blocks + analytics tips | 2 | done (#334) | `feat/help-blocks-analytics` | 5227 | |
| O14 | Profile tips + `calendar-feed` page | 2 | done (#335) | `feat/help-profile` | 5230 | 3 external shots pending, 2 of them iPhone-only (O16) |
| O15 | COROS tips + `connect-coros` page | 2 | done (#336) | `feat/help-coros` | 5229 | 2 external shots pending (O16) |
| O16a | Setup nudge covered the phone `+` menu | 3 | done (#337) | `fix/setup-nudge-phone-menu` | 5241 | found by three wave-2 lanes |
| O16b | Copy audit + fixes (copy and the UI labels it quotes) | 3 | in review (#338) | `fix/onboarding-copy-audit` | 5242 | report: `research/copy-audit-2026-09-24.md`; wakes the iOS job (generated catalog) |
| O16c | Verifier walk on the merged tree | 3 | done (no findings) | `chore/verify-onboarding-walk` | 5243 | phone + desktop fresh-profile walk, 6 help pages signed out, 68 specs |
| O16d | External screenshots (10) | 3 | **blocked on Shane** (Chrome session; 2 need an iPhone) | `feat/help-external-shots` | 5244 | list below |
| O16e | `WELCOME.md` refresh + this close-out | 3 | in review (this PR) | `chore/onboarding-close-out` | — | |

Merge path while main's up-to-date rule is off: `scripts/merge-babysit.sh --fleet --yes`.

## Next up
1. **Shane:** decide D-O06 (recommendation: research only, close it).
2. **Shane + orchestrator (O16d):** the external screenshots, through the Chrome extension with
   Shane signed in, reviewed before commit; then remove each `EXTERNAL:` comment.
   - `get-api-key`: 01 console sign-up (375); 02 Billing / Buy credits (1280, redact org,
     email, card, balance); 03 API keys empty + **Create Key** (1280); 04 Create Key dialog with
     **Workspace** set to a named workspace (1280); 05 the key reveal (redact after `sk-ant-`).
   - `connect-coros`: 02 COROS sign-in at mcpus.coros.com/oauth2/authorize (375, redact email);
     03 the consent screen naming Apex (375).
   - `calendar-feed`: 03 Google Calendar → Settings → Add calendar → From URL (1280, redact
     URL + account); 02 iOS Calendar → Add Subscription Calendar and 04 a phone calendar showing
     an Apex workout — **iPhone app, not a website**: a phone screenshot from Shane, or keep
     the text-only step.
4. Merge #338 then this PR; `scripts/git-tidy.sh --yes` (the babysitter retires merged
   worktrees; the six `claude/*` at `4113140` and no-commit ones are Shane's call).
5. **iOS parity session** (Shane): start from `MASTER.md` + `tips/*.ts`; open items —
   `BuilderSheet.swift` "This event only", the API's "est. 1RM" text shown on iOS,
   `OnboardingSnapshotTests` re-record, the HELD generator's stale "relative path 404s" comment,
   whether "Open Calendar feed, below." fits the You tab.
6. Follow-ups not taken: the analytics chip "Est. 1RM" (`spec.ts` + `AnalyticsCatalog.swift`
   regen), the monthly email's "est. 1RM" / "Biggest PR", the connector guide's drawn "Create
   token" figure and its "just", `dev/legalDocsPlugin.ts` could strip comments from `/help/`
   sources too, a typing race in `logging-a-workout.shots.ts` test 05, `--project` omitted from a
   bare `npx playwright test` regenerates every committed PNG.

## Recent sessions
- 2026-09-26 · release order step 3 · Mac. #322 merged 2026-09-25 and phase47 is in production:
  `scripts/prod-schema-check.mjs` exit 0 (33 tables, 377 columns, 2 functions). Tips are now
  remembered server-side, not per device. Next-up item 1 closed.
- 2026-09-25 · wave 3 · Linux. #337 (nudge hides while the + menu is open), the copy audit
  (read-only Opus lane; 17 copy rows, 13 label rows, 9 consistency rows) applied in #338
  including nine on-screen labels, the `app-verifier` fresh-profile walk on the merged tree
  (all seven checks pass, no findings), `WELCOME.md` rewritten to mirror `/help`. External
  screenshots wait on Shane.
- 2026-09-24/25 · wave 2 · Linux. Nine Opus lanes in parallel, three lock slots for full
  gates, explicit ports; every lane green; fold of eleven branches passed
  `combine-check --check` after one cross-lane lesson (D-O07); the fleet babysitter merged
  #326–#336 in two passes (#328/#331 needed `main` merged in after #327 landed the
  isolation fix and the live-suite tips-off). Three lanes independently found the phone
  nudge bug.
- 2026-09-24 · wave 1 · Linux. Four Opus lanes in parallel (migration, tips core, help
  shell, welcome trim) + one read-only research lane; `combine-check --check` on the fold,
  then the fleet babysitter merged #323, #325, #324 (one fixture fix on #324: the iOS
  `profile.json` contract gained `tipsSeen`). O05 grew to cover the iOS side of the intro
  so the shared catalog did not turn the `ios` job red. #322 HELD.
- 2026-09-24 · planning + scaffold · Linux. Three Explore and three Plan agents mapped the
  codebase, the UI primitives, the screenshot tooling and the copy; Shane chose the server
  column, the plain card, the four-card intro (coach included) and orchestrator-captured
  external shots. Plan file: `~/.claude/plans/we-need-to-develop-joyful-pebble.md`; this
  directory is its durable copy. Scaffold PR: #321.
