# Progressive onboarding — status board

Living document. **Every session updates this file before it ends**: flip the lane's state,
add one line under "Recent sessions", refresh "Next up". Detail belongs in the lane's brief.

States: `ready` · `in progress (branch)` · `in review (PR #)` · `done (PR #)` · `blocked on …`

| Lane | Title | Wave | State | Branch | Port | Notes |
|---|---|---|---|---|---|---|
| O01 | Scaffold: docs, catalog stubs, help stubs, CSS files | 0 | done (#321) | `chore/onboarding-scaffold` | — | |
| O02 | Migration `profiles.tips_seen` (phase47) | 1 | in review (#322) — **HELD for `shipit`** | `db/tips-seen` | 5211 | then apply in prod + `prod-schema-check` |
| O03 | Tips core: useTip, TipHost, TipCard, API, local mirror | 1 | done (#324) | `feat/tips-core` | 5212 | works per-device until #322 is in prod |
| O04 | Help shell: `/help` route, images, shots pipeline | 1 | done (#325) | `feat/help-pages` | 5213 | `/help/*` live in prod |
| O05 | Welcome trim: four cards + iOS parity for the intro | 1 | done (#323) | `feat/welcome-four-cards` | 5214 | iOS snapshot tests stale (opt-in) — parity session |
| O06 | Research: subscription OAuth | 1 | done (report in `research/`) | — | — | recommendation: research only; D-O06 awaits Shane |
| O07 | Calendar + day view tips | 2 | in progress (`feat/help-calendar`) | `feat/help-calendar` | 5221 | |
| O08 | Workout detail tips + `repeating-workouts` page | 2 | in progress (`feat/help-workout`) | `feat/help-workout` | 5222 | |
| O09 | Tracker tips + `logging-a-workout` page | 2 | in progress (`feat/help-tracker`) | `feat/help-tracker` | 5223 | |
| O10 | Coach tips + `get-api-key` page | 2 | in progress (`feat/help-coach`) | `feat/help-coach` | 5224 | external shots via O16 |
| O11 | Builder tips | 2 | in progress (`feat/help-builder`) | `feat/help-builder` | 5225 | |
| O12 | Library + meals tips | 2 | in progress (`feat/help-library-meals`) | `feat/help-library-meals` | 5226 | |
| O13 | Blocks + analytics tips | 2 | in progress (`feat/help-blocks-analytics`) | `feat/help-blocks-analytics` | 5227 | |
| O14 | Profile tips + `calendar-feed` page | 2 | in progress (`feat/help-profile`) | `feat/help-profile` | 5230 | 5228 is Chrome's push port — avoid; external shots via O16 |
| O15 | COROS tips + `connect-coros` page | 2 | in progress (`feat/help-coros`) | `feat/help-coros` | 5229 | external shots via O16 |
| O16 | Verification, external shots, WELCOME.md, close-out | 3 | ready | `feat/help-external-shots` + read-only | 5241–5244 | orchestrator + verifiers |

Full-gate lock slots: `e2e_slot_<k>`, k = lane number mod 3 + 1. Merge path while main's
up-to-date rule is off: `scripts/merge-babysit.sh --fleet --yes` (proves the union, then merges).

## Next up
1. Shane: `shipit` on #322, apply `phase47_tips_seen.sql` in prod, re-run
   `scripts/prod-schema-check.mjs`. Until then tips are remembered per device only.
2. Wave 2: as each lane reports, verify SHA + clean tree; `scripts/combine-check.sh --check`
   across the nine branches; open PRs; babysit.
3. Wave 3 (O16): copy audit, `app-verifier` fresh-profile walk on the fold, external
   screenshots through Chrome with Shane signed in, `WELCOME.md` refresh, tidy, prod verify.
4. Shane: `scripts/git-tidy.sh --yes` between waves (the babysitter retires merged
   worktrees, but the six `claude/*` ones at `4113140` and the no-commit ones are yours).

## Recent sessions
- 2026-09-24 · wave 1 · Linux. Four Opus lanes in parallel (migration, tips core, help
  shell, welcome trim) + one read-only research lane; `combine-check --check` on the fold,
  then the fleet babysitter merged #323, #325, #324 (one fixture fix on #324: the iOS
  `profile.json` contract gained `tipsSeen`). O05 grew to cover the iOS side of the intro
  (test pins, one page per step, markdown bodies, relative links) so the shared catalog did
  not turn the `ios` job red. #322 HELD. Wave 2's nine lanes launched the same evening.
- 2026-09-24 · planning + scaffold · Linux. Three Explore and three Plan agents mapped the
  codebase, the UI primitives, the screenshot tooling and the copy; Shane chose the server
  column, the plain card, the four-card intro (coach included) and orchestrator-captured
  external shots. Plan file: `~/.claude/plans/we-need-to-develop-joyful-pebble.md`; this
  directory is its durable copy. Scaffold PR: #321.
