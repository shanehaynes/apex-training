# Improvement doc 4 — Clean Code review log

**Date:** 2026-10-14 · **Status:** backlog, nothing fixed · **Commit reviewed:** `7c0fcae2` (main)
**Scope:** web + API + iOS + tooling, production source only
**Source:** a file-by-file read of every in-scope file against Robert C. Martin's *Clean Code*
(names, functions, comments, formatting, objects vs data, error handling, boundaries, classes, and
the ch. 17 smell catalogue — G5 duplication, G9 dead code, G23 switch-vs-polymorphism, G25 magic
numbers, G30 do one thing, etc.).

509 findings across 13 lane logs. Every finding is a checkbox with a priority, the Clean Code rule,
a `path:line` anchor at `7c0fcae2`, and a concrete fix. Line numbers drift as `main` moves — re-find
the symbol before acting.

| Lane log | Scope | Total | P1 | P2 | P3 |
|---|---|---:|---:|---:|---:|
| [web-components-a](web-components-a.md) | `src/components` analytics → library | 40 | 7 | 23 | 10 |
| [web-components-b](web-components-b.md) | `src/components` modal → tracker, `App.tsx` | 36 | 8 | 21 | 7 |
| [web-hooks-context](web-hooks-context.md) | `src/hooks`, `src/context`, `src/utils`, `src/types`, `dev/` | 40 | 9 | 25 | 6 |
| [web-lib-coach-review](web-lib-coach-review.md) | `src/lib/coach`, `review`, `db`, root `src/lib/*.ts` | 38 | 7 | 23 | 8 |
| [web-lib-domain](web-lib-domain.md) | rest of `src/lib` (analytics, tracking, blocks, schedule…) | 40 | 10 | 22 | 8 |
| [api-handlers](api-handlers.md) | `api/*.ts`, `api/_lib/handlers` | 39 | 11 | 27 | 1 |
| [api-mcp-providers](api-mcp-providers.md) | `api/_lib/mcp`, `providers`, `coach`, `oauth` | 39 | 8 | 25 | 6 |
| [api-services-core](api-services-core.md) | `api/_lib/services`, `review`, `reflection`, root `api/_lib/*.ts` | 40 | 12 | 25 | 3 |
| [ios-core](ios-core.md) | `ApexCore` | 40 | 7 | 23 | 10 |
| [ios-features-a](ios-features-a.md) | `ApexFeatures` Analytics, Blocks, Builder, Coach, Integrations, Library | 40 | 9 | 28 | 3 |
| [ios-features-b](ios-features-b.md) | `ApexFeatures` Meals, Onboarding, Profile, Schedule, Tracker | 40 | 10 | 27 | 3 |
| [ios-kit-app](ios-kit-app.md) | `ApexAuth`, `ApexUI`, `ApexPersistence`, `ApexHealth`, `ApexActivity`, `ios/Apex` | 37 | 7 | 24 | 6 |
| [tooling](tooling.md) | `scripts/`, `evals/src`, `e2e/lib`, `ios/scripts` | 40 | 10 | 25 | 5 |
| **Total** | | **509** | **115** | **318** | **76** |

**Priority.** P1 hurts comprehension or change-safety across a module (mixed-concern units, real
duplication, misleading names, swallowed errors). P2 is local clarity. P3 is minor. Each lane was
capped at 40 findings, so a lane at 40 cut lower-value items — absence from the log is not a clean
bill of health.

## Triage first: findings that look like defects, not just style

Clean Code violations that have already produced wrong behaviour. Each was re-read against the
source when this log was assembled. These want a `fix/` lane, not a refactor backlog.

1. **Cache deletes ignore the account.** `GRDBCacheStore.delete` and `purge(fetchedBefore:)`
   (`ApexPersistence/CacheStore+GRDB.swift:106`, `:115`) filter on `kind`/`key` only; the type's own
   doc promises per-owner scoping. No wrong behaviour today — the only callers use event-UUID keys
   or sweep stale rows — but the next caller inherits a broken contract. → [ios-kit-app](ios-kit-app.md)
2. **The setup nudge floats over two overlays.** `OnboardingHost.tsx:23` hand-lists overlay flags and
   misses `weeklyReviewOpen` and `analyticsOpen`. → [web-components-b](web-components-b.md) **Fixed in #454.**
3. **Conversation caps disagree.** `coachConversations.ts:36` says it matches `chat.ts` "exactly" but
   stores 80 messages; `chat.ts:463` accepts 160. → [api-handlers](api-handlers.md) **Fixed in #454.**
4. **A failed block load spins forever.** `BlockDetail.tsx:61` `.catch(() => {})` leaves "Loading…".
   → [web-components-a](web-components-a.md) **Fixed in #454.**
5. **The iOS write queue discards store failures.** `WriteQueue.swift` uses `try?` on fourteen store
   calls (e.g. `:187`–`:258`); a failed `update` means an op never reaches its retry limit, and at
   `:222` a store that keeps failing hands the same op back, tight-looping the drain.
   → [ios-core](ios-core.md)
6. **A failed query reads as "no history".** `library/repo.ts:23` ignores the Supabase error;
   `tracking/sessionRepo.ts:86` turns any load failure into an offline session.
   → [web-lib-domain](web-lib-domain.md) **Library half fixed in #454; the tracker fallback is
   deliberate (gym-offline logging, already toasted) and now documented — changing it is Shane's call.**
7. **`WorkoutModal` reads a stale snapshot** for colour, duration, location and five more fields
   (`event.type` at `WorkoutModal.tsx:160`) while the lines below read `live`, so edits to those
   fields do not show while the modal is open. → [web-components-b](web-components-b.md) **Fixed in #454.**
8. **Re-declared coach-contract types.** `notebook.ts:32` re-declares `CONTRACT_MAX`,
   `CoachReflection` and `ReflectionResolution` from `contract.ts`, and the copies have drifted; a
   second, unused "pending" rule (`reflectionAwaitsAthlete`) sits beside the live one. → [web-lib-coach-review](web-lib-coach-review.md)

## Cross-cutting themes

The 509 findings cluster. Fixing a theme once retires dozens of line items.

- **Duplicated contracts that have already drifted (G5).** The expensive kind of duplication: two
  copies of one rule that now disagree. Beyond the triage list: the drop-everything SQL in
  `db-reset-local.sh` vs `db-restore-drill.sh`; five `.env.local` readers that parse differently;
  `email.ts` vs `recap.ts` review facts; three iOS offline messages from three error mappers;
  tonnage and best-1RM computed in two places each. (Duplicated but still agreeing: the two
  `addIsoDays`, `calendar/copy.ts:71` local-zone and `template/clone.ts:48` deliberately UTC.)
- **Boilerplate copied per call site (G5).** The handler preamble (admin client → `requireUser` →
  `enforceRateLimit`) in 38 files; `DATE_RE`/`UUID_RE`/query-param helpers re-declared per handler;
  the realtime subscription in four context providers and the mutation skeleton twelve times; five
  mutation-log writers; three web coach panels; the modal shell in five files; the iOS debounced
  preview and draft-coach wiring.
- **Units that do too much (G30, SRP).** `workoutSessions.ts` (512-line handler, 10-action
  if-chain), `useWorkoutSession.ts` (~670 lines), `review/weekly.ts` (927), `trackerSession.ts` (636),
  `ScheduleModel.swift` (848), `AppModel.ensureQueue` (137), `analytics/engine.ts` `extractPoints`
  (~220), `providers/sync.ts` `writeActivityRecords` (177 lines, 8 params), `WriteQueue.drain` (~100).
- **Swallowed errors (ch. 7).** `.catch(() => {})`, unchecked Supabase `error`, Swift `try?` on
  writes, `Promise<boolean>` that can only be `true`. The pattern recurs in every lane.
- **Leaky or misnamed abstractions (ch. 8, N1).** "Provider-generic" sync hard-codes COROS;
  `AuthService` exposes the raw Supabase client its doc says stays wrapped; HTTP handlers loose at
  the `api/_lib` root (`trainingBlocks.ts`, `meals.ts`, `mealFavorites.ts`) outside `handlers/`;
  module-wide iOS helpers (`Failure`, `IsoDate`) living in `Profile/YouServices.swift`.
- **Stringly-typed keys and positional argument lists (F1, G25).** `|`-joined dirty keys parsed back
  with `split('|')`; coach live-context builders taking 8–10 positional args in inconsistent orders.

## How to work this log

- Take a theme, not a line item: one PR per theme per surface, cutting a lane with
  `scripts/git-new.sh` as usual. Tick the boxes it retires and append ` — #<PR>`.
- Findings in [tooling](tooling.md) marked **(held path)** touch merge/guard automation and need
  Shane's `shipit`.
- Coach prompt or tool changes go past the `eval-analyst` agent before they ship.
- iOS findings that mirror web logic should be fixed on both sides in one milestone, or parity drifts.

## Method and what was not checked

Thirteen read-only reviewers, one per disjoint lane, each told to open every in-scope file and read
it top to bottom, verify each finding by re-reading the cited lines, and list what it skipped (each
lane log ends with "Not checked"). Reviewers were told not to flag the repo's deliberate "why"
comments, the Swift port's intentional mirroring of the TS, or anything oxlint/tsc already enforce.
Fifteen findings were independently re-checked against source while assembling this log (triage
items 1–7, the re-declared `CONTRACT_MAX`, and the COROS, `addIsoDays`, `ScheduleModel` size,
`Failure` location, dirty-key, `BlocksContext` and `trainingBlocks.ts` copy claims); all held. A `reviewer` pass then bounds-checked all 509
anchors (all resolve) and read 46 findings against source: 42 confirmed, 4 overstated, none false
or mis-anchored; the four were corrected in place. The rest are reviewer claims — re-read
before acting.

**Out of scope:** tests (`__tests__`, `*.test.*`, `*.spec.*`, `ios/*Tests`), generated files
(`database.types.ts`, the Swift `Generated/` catalogs and tokens), fixtures, snapshots, SQL
migrations, CSS outside `src/components` modal→tracker, eval case data, and doctrine prose. Clean
Code ch. 9 (unit tests) would be a second pass.
