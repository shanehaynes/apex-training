# Progressive onboarding — status board

Living document. **Every session updates this file before it ends**: flip the lane's state,
add one line under "Recent sessions", refresh "Next up". Detail belongs in the lane's brief.

States: `ready` · `in progress (branch)` · `in review (PR #)` · `done (PR #)` · `blocked on …`

| Lane | Title | Wave | State | Branch | Port | Notes |
|---|---|---|---|---|---|---|
| O01 | Scaffold: docs, catalog stubs, help stubs, CSS files | 0 | in review (PR #321) | `chore/onboarding-scaffold` | 5253 | orchestrator |
| O06 | Research: subscription OAuth | 1 | done (report in `research/`, 2026-09-24) | — | — | recommendation: research only; D-O06 awaits Shane |
| O02 | Migration `profiles.tips_seen` | 1 | ready | `db/tips-seen` | 5211 | HELD (migration); wakes the iOS job (generated types) |
| O03 | Tips core: useTip, TipHost, TipCard, API, AuthContext, e2e fixture | 1 | ready | `feat/tips-core` | 5212 | tolerates a missing column |
| O04 | Help shell: `/help` route, renderer with images, shots projects, helpShot | 1 | ready | `feat/help-pages` | 5213 | |
| O05 | Welcome trim: four cards, help links | 1 | ready | `feat/welcome-four-cards` | 5214 | regenerates the Swift catalog; wakes the iOS job |
| O06 | Research: subscription OAuth for a third-party web app | 1 | ready | read-only | — | report → `research/` |
| O07 | Calendar + day view tips | 2 | ready | `feat/help-calendar` | 5221 | after wave 1 |
| O08 | Workout detail tips + `repeating-workouts` page | 2 | ready | `feat/help-workout` | 5222 | |
| O09 | Tracker tips + `logging-a-workout` page | 2 | ready | `feat/help-tracker` | 5223 | |
| O10 | Coach tips + `get-api-key` page | 2 | ready | `feat/help-coach` | 5224 | external shots via O16 |
| O11 | Builder tips | 2 | ready | `feat/help-builder` | 5225 | |
| O12 | Library + meals tips | 2 | ready | `feat/help-library-meals` | 5226 | |
| O13 | Blocks + analytics tips | 2 | ready | `feat/help-blocks-analytics` | 5227 | |
| O14 | Profile tips + `calendar-feed` page | 2 | ready | `feat/help-profile` | 5228 | external shots via O16 |
| O15 | COROS tips + `connect-coros` page | 2 | ready | `feat/help-coros` | 5229 | external shots via O16 |
| O16 | Verification, external shots, WELCOME.md, close-out | 3 | ready | `feat/help-external-shots` + read-only | 5241–5244 | orchestrator + verifiers |

Full-gate lock slots: `e2e_slot_<k>`, k = lane number mod 3 + 1.

## Next up
1. Merge O01. Shane: `scripts/git-tidy.sh --yes` (36 worktrees) and optionally
   `sudo apt install fonts-inter fonts-jetbrains-mono`.
2. Wave 1: launch O02–O05 as writing lanes (one message, four worktrees) and O06 read-only.
   `scripts/combine-check.sh --check` the four branches; PRs O02 → O05 → O03 → O04.
3. Shane: `shipit` on O02; apply the migration in prod when convenient.

## Recent sessions
- 2026-09-24 · planning + scaffold · Linux. Three Explore and three Plan agents mapped the
  codebase, the UI primitives, the screenshot tooling and the copy; Shane chose the server
  column, the plain card, the four-card intro (coach included) and orchestrator-captured
  external shots. Plan file: `~/.claude/plans/we-need-to-develop-joyful-pebble.md`; this
  directory is its durable copy. Scaffold PR: O01.
