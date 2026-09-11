# Apex Training

**A training calendar, workout tracker, and AI coach — one app for planning the week, logging the work, and getting a straight answer about how it went.**

[![CI](https://github.com/shanehaynes/apex-training/actions/workflows/ci.yml/badge.svg)](https://github.com/shanehaynes/apex-training/actions/workflows/ci.yml)

React 19 · TypeScript (strict) · Vercel serverless · Supabase Postgres under row-level security · Claude · a native SwiftUI client

Apex Training is a production, multi-user web app with a native iOS port in flight. It plans recurring training on a calendar, tracks sessions set by set, computes personal records and period statistics deterministically, and puts a Claude-powered coach next to that data — one that can propose changes to your week but can never make one without your confirmation. It syncs a COROS watch, publishes an ICS feed, emails a review when a training month closes, and exposes a read-only [MCP](https://modelcontextprotocol.io) server behind a full OAuth 2.1 authorization server so Claude or ChatGPT can answer questions about your training from wherever you already are.

![Calendar month view with coach sidebar](docs/screenshots/calendar.png)

---

## Contents

- [At a glance](#at-a-glance)
- [The idea that shapes the codebase](#the-idea-that-shapes-the-codebase)
- [Engineering highlights](#engineering-highlights)
- [Architecture](#architecture)
- [What it does](#what-it-does)
- [Testing and CI](#testing-and-ci)
- [Operations](#operations)
- [How this repository is built](#how-this-repository-is-built)
- [Getting started](#getting-started)
- [Documentation map](#documentation-map)

---

## At a glance

| | |
|---|---|
| **Frontend** | React 19, TypeScript (strict), Vite 8, Tailwind 4, Recharts, Framer Motion, react-grid-layout |
| **Backend** | Vercel serverless functions on Node 24 — **33 routes behind 4 deployed functions**, routed by Hono |
| **Data** | Supabase Postgres: **29 tables**, per-user RLS on every one, **38 ordered migrations**, generated types checked in CI |
| **AI** | Claude via each user's own key, NDJSON streaming, 10 write tools behind confirmation cards, 8 read-only MCP tools |
| **Native** | SwiftUI iOS app — **~27,000 lines of Swift**, GRDB offline cache + write queue, shipping to TestFlight |
| **Tests** | **1,174 unit tests** · **67 Playwright e2e cases** · **443 Swift tests** · 6 CI jobs |
| **Size** | ~56,000 lines of TypeScript across app and API, ~2,500 lines of SQL |

Live deployment: [apextrainingcalendar.vercel.app](https://apextrainingcalendar.vercel.app) — invite-only, a handful of real accounts, and the author's own daily training log.
Using the app rather than working on it? [WELCOME.md](WELCOME.md) is the user guide.

---

## The idea that shapes the codebase

**Deterministic data is computed in code; the AI narrates, it never derives.**

Every number the app shows — an estimated 1RM, a completion rate, a training block's attainment, a chart's aggregation, a review email's totals — is produced by a pure, unit-tested module under [`src/lib/`](src/lib/). The coach is handed those facts already computed and instructed not to invent others. It writes prose and proposes mutations; it does not do arithmetic that the user will rely on.

Three consequences follow, and they explain most of the structure of this repo:

1. **A model regression cannot corrupt a number.** The blast radius of a bad prompt is bad prose.
2. **The domain logic is React-free and testable.** Recurrence expansion, tracker model synthesis, PR detection, occurrence identity, period statistics, the analytics engine, the chat wire protocol — all of it is plain TypeScript with a `__tests__` directory beside it, which is why there are 1,174 unit tests rather than a thin shell of component snapshots.
3. **A second client is cheap.** The iOS app reimplements none of it (see [the port](#native-ios-port-parity-without-a-second-implementation)).

The corollary on the write side: **nothing the coach proposes takes effect on its own.** Every mutation it suggests arrives as a Confirm/Cancel card whose labels are resolved against live application state — not against the model's prose — and nothing executes until the user says so.

---

## Engineering highlights

The parts of this codebase that were actually hard, and what was decided.

### One recurrence engine, three consumers

Recurring workouts are stored as an [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545) `RRULE` subset and expanded by a single engine — [`src/lib/recurrence/`](src/lib/recurrence/) — with parse, validate, serialize, and expand as separate pure modules, plus per-occurrence exceptions and stable synthetic occurrence ids so a single instance of a series can be skipped, edited, or completed without touching its siblings.

It exists because the logic previously existed *twice*, independently, and had drifted: the browser expanded only `frequency === 'daily'` (silently dropping every weekly series) while the ICS feed carried its own second copy with a different set of bugs. The replacement was specified first — [RECURRENCE_ENGINE_SPEC.md](RECURRENCE_ENGINE_SPEC.md) documents the verified current-state findings, the judgment calls with their reasoning, and the open questions — and the one engine now serves the browser, the ICS calendar feed (`RRULE` + `EXDATE`, floating local times), and the `/api/schedule` endpoint the iOS client reads.

### Security model: an anon key that can only read your own rows

- **Every table is under per-user RLS.** A signed-in browser reads only its own rows; an unauthenticated one gets zero rows from every table.
- **The browser never writes directly.** All writes go through the API layer, which holds the service-role key and verifies the caller's JWT ([`api/_lib/auth.ts`](api/_lib/auth.ts)). Cross-user isolation is not asserted in a comment — it is exercised in CI by integration tests that run against a real Postgres with real JWTs ([`api/__tests__/integration/`](api/__tests__/)).
- **No Anthropic key ever reaches the browser, and none is a server env var.** Each user saves their own key in-app; it is stored server-side encrypted with AES-256-GCM ([`api/_lib/keyCrypto.ts`](api/_lib/keyCrypto.ts)) and the browser only ever sees its last four characters. Usage bills to the user's own account.
- **Per-user rate limiting** with fixed-window counters in Postgres that *fail open* — a runaway request loop is the threat model, not precise throttling, and a broken limiter must not take the app down ([phase18](supabase/migrations/phase18_rate_limits.sql)).
- **Security headers** (HSTS, `nosniff`, `X-Frame-Options: DENY`, referrer and permissions policy) are set at the edge in [vercel.json](vercel.json); a clickwrap terms gate sits in front of the authenticated API, with data export and account deletion deliberately exempt from it, because the right to leave cannot be held hostage to accepting terms.

### An OAuth 2.1 authorization server, so assistants can connect

Apex is a remote MCP server ([`api/_lib/handlers/mcp.ts`](api/_lib/handlers/mcp.ts)) — stateless Streamable HTTP, one POST per JSON-RPC message — exposing **eight read-only tools** over the user's training data: schedule, workout detail, exercise history and search, PRs, period stats, training blocks, meals.

Connecting it to claude.ai or ChatGPT meant implementing the authorization side of the MCP spec properly, not stapling on an API key:

| Piece | Detail |
|---|---|
| Protected-resource metadata | [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728), advertised in the `WWW-Authenticate` challenge on 401 |
| Authorization-server metadata | [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414), served from `/.well-known/` via edge rewrites |
| Dynamic client registration | [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) — assistants register themselves |
| Grants | `authorization_code` + `refresh_token`, PKCE `S256` required, public clients (`token_endpoint_auth_methods: ["none"]`) |
| Header-based clients | Personal access tokens minted in-app, listed and revocable per client |

**The entire connector surface is read-only by construction.** Anything that writes stays in the in-app coach behind a confirmation card. An assistant cannot change your training; it can only read it. Per-client setup lives in [CONNECTORS.md](CONNECTORS.md).

### The coach loop

The chat path is the most failure-prone surface in the app, so its invariants are written down and tested:

- **The model id lives in exactly one place** — `COACH_MODEL` in [`src/lib/coach/model.ts`](src/lib/coach/model.ts) — imported by the chat function, the summary handler, the review generator, the UI badge, and the eval suite's production arm. A model bump is a one-line change.
- **Prompt caching** sets three `ephemeral` breakpoints (last tool schema, system block, final message block) so each turn re-reads tools, system prompt, and the conversation prefix at cache-read pricing.
- **Aborts propagate upstream.** The response's `close` event trips an `AbortController` passed to `client.messages.stream()`, so pressing Stop or closing the tab cancels the Anthropic generation instead of letting it bill to completion.
- **Confirmation cards resolve ids against live state,** not the model's prose; an id that resolves to nothing is surfaced as such rather than rendered as a plausible label. Confirm is latched synchronously by a ref, so a double-click cannot run an executor twice.
- **Prompt assembly and tool execution live on the server** ([`/api/coach-tool`](api/_lib/handlers/coachTool.ts)), so no client carries the executors and the web and iOS clients cannot drift apart.

### Measuring the coach, not vibing it

[`evals/`](evals/README.md) is the instrument that answers *does the coach give good advice, and how would we know if it stopped?* — **38 adversarial cases**, structured per-dimension verdicts rather than a single score, versioned as JSON and diffable across runs and models.

The design decision worth reading is the **quality decomposition**: each dimension is checked by the *cheapest instrument that can check it*, because reaching for an LLM judge on everything is the failure mode.

| Dimension | Instrument |
|---|---|
| Constraint / contraindication adherence | Deterministic set intersection against a movement-pattern taxonomy |
| Progression coherence | Arithmetic over the folded schedule — volume ramps, deloads, taper direction |
| Integrity (ids, library discipline, error recovery, prompt-injection resistance) | Deterministic — recorded tool calls either match or they don't |
| Refusal / pushback correctness | LLM judge — the only genuinely fuzzy one, and its reliability is *measured* against human labels ([`npm run eval:agreement`](evals/agreement.ts)) rather than assumed |

The harness imports the production prompt builder, tool schemas, and executors directly, and mirrors the client's confirm-and-flush loop exactly — so the thing measured is the coach as shipped. Each result file records the model, judge model, git commit, and a hash of the coach behavior surface, so a prompt or schema edit between two runs is visible in the diff. It runs nightly in CI, not per-PR: it spends real tokens.

### Analytics as a serializable spec the coach can edit

The analytics dashboard is user-composed tiles on a draggable, resizable grid. A tile is not code — it is a **versioned `ChartSpec` stored as JSONB** ([`src/lib/analytics/spec.ts`](src/lib/analytics/spec.ts)): measure, aggregation, time bucket, date range (rolling, fixed, or preset including *current training block*), series with inlined filters, units, and a day-level join against the training calendar ("protein on strength days", "resting HR the day after a hard session").

That one decision buys three things: the engine ([`engine.ts`](src/lib/analytics/engine.ts)) is pure and fully testable; the renderer only draws; and **the coach can build a chart for you** by editing the draft spec through a reducer tool, with deep validation living in the spec module rather than scattered across the handler and the UI. A server-side port of the same engine ([`/api/analytics-compute`](api/_lib/handlers/analyticsCompute.ts)) serves native clients, paging every table properly — PostgREST's 1000-row default had been silently truncating a heavy user's set logs in the browser.

### Watch sync that refuses to overwrite your plan

Connecting a COROS account is an OAuth sign-in on COROS's own site; Apex never sees the password. Activities are pulled through COROS's MCP server and the FIT file is decoded to heart-rate, elevation, and GPS streams.

Three decisions define the feature:

- **Matches wait for a human.** An activity that matches a planned workout is never auto-filled. The nightly job imports unmatched activities on its own and badges the Sync button with the count of matches awaiting a decision: *Fill it* completes the planned session with measured data, *Keep separate* imports it alongside. Planned targets are never overwritten — actuals live beside them and count toward PRs like hand-logged work.
- **Duplicates are impossible.** An import ledger makes sync idempotent; pressing Sync twice reports that everything is up to date.
- **GPS never leaves the device's trust boundary.** The route outline, elevation profile, and HR chart are drawn locally from the decoded FIT data — there is no map-tile request, so no third party receives the user's coordinates.

The plumbing (connections, dedup, matching, nightly cron) is provider-generic; Garmin and Apple Health ride the same rails. Apex is an MCP *client* here as well as an MCP server, and both ends are hand-rolled rather than pulling in the SDK — every dependency added to the catch-all function taxes cold starts on all 33 routes behind it, and a stateless client only needs JSON-RPC out, JSON or single-shot SSE back.

### Performance work where RLS actually costs

Row-level security is convenient and, written naively, quadratic in attention: a bare `auth.uid() = user_id` predicate is re-evaluated for *every candidate row*. [phase31](supabase/migrations/phase31_concurrency.sql) wraps it in a subquery so the planner hoists it into an InitPlan evaluated once per query — the difference is visible on the 10k-row scans in `workout_set_logs` — adds indexes on the predicates the tracker and library actually filter on, and replaces two full-table drains with a Postgres aggregate.

The migration comment names the thing it is *not*: this is not connection pooling. Every read and write is an HTTPS request to PostgREST, so there is no app-side connection to pool. The cost that scales with users is rows on the wire, which is what the migration attacks.

### Degrading instead of breaking

- **No Supabase configured?** The app still runs, off a bundled schedule with localStorage persistence.
- **Plain `vite` dev has no serverless functions,** so writes and AI features log and toast rather than crash — the dev loop never requires the full stack.
- **On iOS, a basement gym with no signal is the design case:** a GRDB read cache plus a tracker write queue, so a session is logged offline and reconciled later.

### Native iOS port: parity without a second implementation

The [`ios/`](ios/) directory holds a SwiftUI app (iOS 17 floor, Swift 6, XcodeGen-generated project, shipping to TestFlight) organized around one rule:

> **Swift never reimplements anything that has a `__tests__` directory under `src/lib/`.**

The server owns recurrence, PR detection, statistics, alias resolution, analytics compute, prompt assembly, and tool execution — reached through read endpoints added for the port (`/api/schedule`, `/api/query`, `/api/analytics-compute`, `/api/coach-tool`, `/api/workout-draft`). Swift owns UI state and nothing else. Two more decisions keep that honest in CI: **design tokens are generated** from the web's own source files and drift fails the build, and **`ApexCore` is SDK-free** so a Linux CI job can prove the shared core with `swift test` on every push — no Mac required for the logic that matters.

The port is planned in the open: [docs/ios/MASTER.md](docs/ios/MASTER.md) holds the vision and roadmap, [decisions.md](docs/ios/decisions.md) records every decision *with the options that were rejected and why*, and [STATUS.md](docs/ios/STATUS.md) is a living board across fourteen workstreams.

---

## Architecture

```
Browser (React 19 SPA)                           iOS (SwiftUI + GRDB cache)
   │                                               │
   ├── reads ─────────► Supabase PostgREST ◄───────┤   anon key + JWT,
   │                    (RLS: your rows only)      │   SELECT-only
   │                                               │
   └── writes + AI ───► Vercel functions ◄─────────┘
                             │  service-role key, verifies the caller JWT
                             ├── Hono router → 29 handlers
                             ├── Anthropic  (per-user key, NDJSON stream)
                             ├── COROS MCP  (activity sync, FIT decode)
                             └── Gmail SMTP (period reviews)
```

```
src/
  components/        presentational React — calendar, tracker, builder, analytics,
                     library, blocks, meals, coach, sync, onboarding, profile, legal
  context/           state distribution only (Auth, Schedule, Calendar, Blocks, Meals, Analytics)
  hooks/             useChat (NDJSON streaming), useWorkoutSession, useProviderSync, …
  lib/               pure, unit-tested domain logic — the core of the codebase
    recurrence/        RRULE parse / validate / serialize / expand
    schedule/          event expansion, row mapping, occurrence ids
    tracking/          tracker model, PR detection, session data access
    coach/             system prompt, tool registry, wire protocol, action queue, model id
    analytics/         ChartSpec, aggregation engine, buckets, HR zones, day joins
    blocks/            training blocks: periods, targets vs. actuals, cycle generation
    builder/           workout drafts, templates, supersets, scoring
    nutrition/         meal parsing and macro rollups
    review/            period stats + recap copy for review emails
    library/           exercise library, alias resolution
    db/                row types shared with api/ (single source of truth)
api/                 4 deployed serverless functions
  [...path].ts         catch-all → Hono router (_lib/app.ts) → _lib/handlers/*
  chat.ts              standalone: streaming coach chat
  review-cron.ts       standalone: daily review-email cron
  calendar-feed.ts     standalone: per-user ICS feed
  _lib/
    handlers/          29 route handlers
    services/          write services shared by web, iOS, and the coach's executors
    providers/coros/   OAuth, MCP client, FIT decode, sport mapping
    mcp/               MCP protocol, tool registry, token auth
    oauth/             OAuth 2.1 authorization server
supabase/            schema.sql + 38 ordered phaseN migrations
evals/               adversarial eval suite for the coach
ios/                 SwiftUI app — ApexCore (SDK-free), ApexKit, features, widgets
e2e/                 Playwright: mock (stubbed writes) and live (real stack) projects
scripts/             ops, backup/restore drills, CI guards, repo automation
```

**Why only four serverless functions.** Vercel's Hobby plan caps a deployment at twelve, so per-endpoint files do not scale. Everything except chat (streaming, heavy imports), the cron target, and the public-token ICS feed routes through one catch-all into a Hono router. The constraint is enforced mechanically: `npm run ci:guards` fails the build if a fifth root-level `api/*.ts` appears, in a script that both CI *and* the local pre-push gate run — so a branch cannot pass locally and go red in CI.

<details>
<summary><b>API surface — 33 routes</b></summary>

| Endpoint | Purpose |
|---|---|
| `/api/events`, `/api/event-instances` | Event CRUD with an append-only mutation log; per-occurrence skips and overrides |
| `/api/completions` | Completion toggles + history log |
| `/api/workout-sessions` | Tracker lifecycle: start / save / finish / cancel / summary |
| `/api/workout-templates`, `/api/workout-draft` | Named workouts, scoring types (for-time, AMRAP), builder drafts |
| `/api/blocks`, `/api/objectives` | Training blocks (Monday-aligned, non-overlapping) and objectives |
| `/api/meals`, `/api/meal-favorites` | Meal logging and saved favorites |
| `/api/exercise-definitions` | Exercise library writes (reads come from PostgREST directly) |
| `/api/analytics-tiles`, `/api/analytics-compute` | Saved tile specs; server-side tile computation for native clients |
| `/api/schedule`, `/api/query` | Native read surface: expanded schedule window; JWT door onto the MCP read tools |
| `/api/chat`, `/api/coach-summary`, `/api/coach-tool` | Streaming chat; post-workout summary; confirmed tool execution |
| `/api/profile`, `/api/account`, `/api/terms-acceptance` | Profile and coach fields; data export and deletion; clickwrap |
| `/api/mcp`, `/api/mcp-tokens` | Remote MCP server and personal access tokens |
| `/api/oauth-metadata,-register,-authorize,-approve,-token` | OAuth 2.1 authorization server + discovery |
| `/api/provider-sync`, `/api/provider-callback`, `/api/provider-cron` | COROS connection, OAuth redirect target, nightly sync |
| `/api/calendar-feed` | Per-user tokened ICS feed with RRULEs and EXDATEs |
| `/api/review-cron` | Daily period-review email job |
| `/api/template-copy`, `/api/mutations-log`, `/api/version` | Starter-plan seeding; mutation history; deployed commit SHA |

</details>

<details>
<summary><b>Data model — 29 tables</b></summary>

Events and scheduling (`workout_events`, `recurring_exceptions`, `workout_completions`), tracking (`workout_sessions`, `workout_set_logs`, `workout_cardio_logs`, `workout_templates`), library (`exercise_definitions`), planning (`training_blocks`, `objectives`), nutrition (`meals`, `meal_favorites`), analytics (`analytics_tiles`), integrations (`provider_connections`, `provider_activity_imports`, `activity_streams`, `mcp_tokens`, `oauth_clients`, `oauth_codes`), accounts (`profiles`, `user_api_keys`, `terms_acceptances`, `reviews`, `api_request_counts`), and four append-only mutation logs.

Migrations are `supabase/migrations/phaseN_*.sql`, applied in `sort -V` order. The number is a **repo-global counter**: two branches can both add `phase41_*.sql`, merge cleanly, and leave an apply order nobody chose — so `scripts/next-phase.sh` issues the number and a test fails the second PR to claim one. **Next free number: phase41.**

The generated types in `src/lib/db/database.types.ts` are regenerated from a local stack built by every migration from scratch, and CI fails on drift — the committed types must match a database that is actually reachable from an empty schema.

</details>

---

## What it does

### Calendar and planning

Month, week, and day views with realtime sync across devices. Workouts repeat on a rule; a single occurrence can be skipped or edited without touching the series. New accounts are offered a starter plan — a one-time copy of a template account's recurring workouts, to edit or delete.

![Workout detail modal](docs/screenshots/event-modal.png)

### Tracking, and personal records that are computed

Per-set logging against planned targets, debounced autosave, tap-to-fill from your previous session, and sets you never touched recorded honestly as zeros rather than quietly dropped. Finishing shows a summary with any personal records: estimated 1RM (Epley), duration, reps, distance, elevation — detected client-side from raw history, with a first-ever logging of a movement correctly never counting as a PR. Scored workouts (for-time, AMRAP) get workout-level PRs that group across every scheduled instance of the named workout and survive event deletion.

![Workout tracker](docs/screenshots/tracker-desktop.png)

### The coach

A chat rail that can see today's workouts, the week's schedule, recent completion rates, the exercise library, the active training block, and today's meals. It writes a daily briefing on request, summarizes a session after you finish it, and can create and edit workouts, set a session's exercises, build analytics tiles, and log meals — each as a Confirm/Cancel card. Everything it did is logged under Profile → Coach activity.

### Training blocks, library, meals

Blocks are dated, Monday-aligned, non-overlapping stretches of training with weekly targets, which is what lets the coach say "92% of planned aerobic volume" instead of "seven hours"; a cycle generator lays down a periodized cycle (3 on, 1 easy, by default) with a dated preview before it commits. The exercise library is alias-aware, so "cable row" and whatever else you called it resolve to one movement and history never fragments. Meals carry macros with derived calories, favorites, and daily rollups the coach can see.

### Everything else

[Watch sync](#watch-sync-that-refuses-to-overwrite-your-plan), an ICS calendar feed for Apple or Google Calendar, assistant connectivity over MCP, and review emails when a training period closes — where a "month" is four ISO weeks, thirteen per year, with month 13 absorbing week 53 in 53-week ISO years, and the yearly review going out in the first weeks of the new ISO year. Statistics are computed deterministically; users with a key saved also get a short coach's note, and everyone else gets the numbers.

---

## Testing and CI

```bash
npm run agent:check     # the pre-push gate: tsc -b + vitest + oxlint + playwright(mock) + guards
npm test                # vitest only
npm run e2e             # playwright, mock project
npm run build           # tsc -b + vite build — what CI runs
npm run eval            # coach eval suite (spends real API tokens)
```

`tsc -b` builds **five strict projects** — app, node, api, e2e, and `evals/` — all referenced from the root [tsconfig.json](tsconfig.json), so the eval harness is typechecked like production code.

**Six CI jobs**, five of them on every push, pull request, and merge-queue branch:

| Job | What it proves |
|---|---|
| `check` | Build, 1,174 unit tests, lint, serverless-function count guard, design-token drift, `ApexCore` import purity, `npm audit --omit=dev` |
| `e2e-mock` | Full UI flows against stubbed writes (Playwright) |
| `full` | A **real local Supabase stack**: every migration applied from scratch, generated-types drift check, handler integration tests with real JWTs and RLS cross-user isolation, then live e2e |
| `apexcore-linux` | The iOS shared core builds and tests on Linux — the gate that keeps it free of Apple-only imports |
| `ios` | XcodeGen + `xcodebuild test` on a simulator, unit and UI tests, `.xcresult` uploaded |
| `evals` | The coach eval suite — nightly and on demand only, because it spends tokens |

Four testing decisions worth knowing:

- **Skips are enforced.** [`e2e/lib/skipReporter.ts`](e2e/lib/skipReporter.ts) fails CI on any skip not listed in `EXPECTED_CI_SKIPS`, so a test that quietly stops running is a build failure rather than a green check.
- **The mock clock is pinned** to a fixed date, because the bundled seed schedule covers a fixed range; the live project has no pin, since its rows are seeded off the real clock.
- **The nightly run re-proves `main` from scratch**, rebuilding the database from every migration — which also catches anything that only breaks on a clean build.
- **The merge queue is a first-class citizen** in the workflow's triggers; without the `merge_group` event a required check never starts and every queued PR times out waiting for it.

---

## Operations

Deploys as a Vite app on Vercel ([vercel.json](vercel.json)) with two crons: period reviews at 14:00 UTC and provider sync at 03:30 UTC. [`scripts/deploy-verify.sh`](scripts/deploy-verify.sh) checks that the deployed build is the commit you think it is, via an unauthenticated `/api/version`. [`scripts/supervisor-report.sh`](scripts/supervisor-report.sh) prints everything needing attention — main's status, local stack drift, the last nightly backup, stale worktrees, open PRs — in one read-only sweep.

**Backups, with restore drills.** Production runs on Supabase's free tier, which keeps no backups, so the repo makes its own. Nightly, [`scripts/db-backup.sh`](scripts/db-backup.sh) dumps the schema and every `auth` and `public` row, encrypts the bundle to an [age](https://github.com/FiloSottile/age) public key committed in the repo, and uploads it as a 90-day artifact. Then — the part that matters — [`scripts/db-restore-drill.sh`](scripts/db-restore-drill.sh) restores that same dump into a throwaway stack on the runner and *checks* it: users and events exist, every row count matches the dump, the signup trigger is back, and the schema matches the committed types. **A backup that cannot be restored turns the run red.** The repo is public, so the encryption is what keeps password hashes and training data private.

<details>
<summary><b>Backup setup, restoring a bundle, and disaster recovery</b></summary>

**One-time setup**

1. `age-keygen -o apex-backup.key`. Put the whole file in your password manager and paste the `# public key:` value into [`scripts/backup/age-recipient.txt`](scripts/backup/age-recipient.txt). Losing the private key makes every bundle unreadable — a second key line is cheap insurance.
2. Supabase dashboard → **Connect** → **Session pooler**, with the password percent-encoded. Not the direct `db.<ref>` host (IPv6-only, unreachable from GitHub's runners) and not port 6543 (transaction mode, which breaks `pg_dump`).
3. Repo → Settings → Secrets → `SUPABASE_DB_URL`. Without it the workflow skips with a notice rather than failing.
4. `gh workflow run backup.yml`, then watch it go green.

**Restoring locally — a real drill.** It replaces seeded fixtures with production data, so `npm run db:reset-local` afterwards is not optional:

```bash
id=$(gh run list --workflow backup.yml --status success --limit 1 --json databaseId --jq '.[0].databaseId')
gh run download "$id" -p 'db-backup-*' -D /tmp/apex-backup
age -d -i ~/path/apex-backup.key /tmp/apex-backup/db-backup-*/*.age | tar -xz -C /tmp/apex-backup
npm run db:restore-drill -- /tmp/apex-backup
npm run db:reset-local
```

**Disaster recovery into a fresh project.** Decrypt and extract as above, take the new project's session-pooler URL, and load with `psql "$URL" -v ON_ERROR_STOP=1 -1 -f schema.sql -f data.sql`. Then recreate the signup trigger by hand: `on_auth_user_created` lives on `auth.users`, which no schema dump carries, and its DDL is the last statement of [`phase9_multi_user.sql`](supabase/migrations/phase9_multi_user.sql). Set Site URL and Redirect URLs per [DEPLOY_MULTI_USER.md](DEPLOY_MULTI_USER.md), put the new keys into Vercel, and keep `API_KEY_ENCRYPTION_SECRET` unchanged or every stored Anthropic key is unreadable.

**When the nightly run is red:** an `auth.users` column error during load means production's auth schema is newer than the CLI's — rerun later. A types-check failure means production is behind `main`'s migrations. Connection refused usually means the free-tier project paused after a week without traffic. Retention is 90 days rolling and GitHub disables a scheduled workflow after 60 days without commits, so download one bundle to offline storage each quarter.

</details>

<details>
<summary><b>Two deployment footguns this repo documents because it hit them</b></summary>

**Hand out the assigned domain, never a deployment URL.** Vercel Deployment Protection covers every path on a deployment URL — including `/.well-known/*`, `/api/mcp`, and `/api/calendar-feed` — so a visitor there meets Vercel's SSO page before the app's own login. Previews share production's env vars and therefore its database, which is why that protection is worth keeping on.

**Supabase's Site URL is the least obvious place you hand out a URL.** Every invite, password-reset, and confirmation email GoTrue sends is built from it, and any `redirect_to` the app asks for is silently replaced by it unless the origin is on the allow-list. Point it at a deployment URL and invited users meet the SSO page instead of the app. Nothing in a commit or in CI can see those two dashboard fields, so [`scripts/auth-redirect-check.sh`](scripts/auth-redirect-check.sh) reads them back over HTTP as part of the supervisor sweep.

</details>

---

## How this repository is built

Apex Training is written largely by Claude Code sessions working in parallel, under a control system designed for that. The interesting artifact is not the generated code — it is the boundary drawn around what an autonomous agent may do alone, and the machinery that makes the boundary hold. The full rules are in [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md); the shape of it:

- **Isolation by construction.** Every task starts with `scripts/git-new.sh`, which branches from a freshly fetched `origin/main` into its own worktree with its own `node_modules` and its own dev-server port. The primary checkout stays on `main`, clean.
- **Declared intent.** Each worktree records a claim; a new session is shown every other session's claims before it writes a line, so overlap is caught when it is cheapest to avoid.
- **Shared resources take a lock rather than trusting good manners.** One Postgres serves the whole machine, so anything that resets tables takes a machine-wide lock and a second session queues rather than corrupting the first.
- **Guard hooks make three rules mechanical** rather than advisory ([`scripts/hooks/bash-guard.mjs`](scripts/hooks/bash-guard.mjs)): no `pkill` on a shared dev server, no `git reset --hard` or `git clean -f` without reviewing `git status` first (the working tree may hold another session's only copy of its work), and no building or committing in the primary checkout. They fail *open* — a broken guard must not brick every session.
- **A merge policy the agent cannot widen.** [`scripts/merge-policy.mjs`](scripts/merge-policy.mjs) lets an unattended babysitter merge green, up-to-date PRs, but **holds** migrations, `.github/`, `vercel.json`, dependency manifests, and — importantly — every file that defines the automation's own authority, including the policy itself and the hooks. A human grants a per-PR exception with a `shipit` label, which the hooks forbid the agent from applying to its own PR. Unlike the guards, this one fails *closed*: no verdict, no merge. Kill switch: `touch .claude/AUTOMERGE_OFF`.

That last rule is the whole idea in one line: **the agent must never be able to merge an expansion of what the agent may do.**

---

## Getting started

Node 24 (see [.nvmrc](.nvmrc)) and a [Supabase](https://supabase.com) project. No Anthropic key is needed to run the app — the coach uses each user's own, saved in-app.

```bash
npm install
cp .env.example .env.local     # fill in the values
npm run dev                    # Vite dev server — UI + Supabase reads
```

Plain `vite` does not run the serverless functions, so writes and AI features degrade gracefully rather than crashing. Use [`vercel dev`](https://vercel.com/docs/cli/dev) to exercise the full stack, or `npm run db:reset-local` for a local Supabase stack seeded with fixtures.

**Database:** run [`supabase/schema.sql`](supabase/schema.sql) once on a fresh project, then [`supabase/migrations/`](supabase/migrations/) in **numeric** phase order (`sort -V`, not filename sort, which puts phase10 before phase2). After any migration: `npm run db:reset-local && npm run db:types`, and commit the regenerated types.

<details>
<summary><b>Environment variables</b></summary>

| Variable | Scope | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | client + server | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | client | anon/public key — SELECT-only under RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | used by `api/` for writes; never prefixed with `VITE_` |
| `VITE_PUBLIC_ORIGIN` | client + server | the canonical origin this deployment publishes as. Every URL that leaves the app is built from it — OAuth issuer and endpoints, the MCP endpoint, the ICS feed, password-reset redirects. Unset, those follow the request's `Host`, so a user on a deployment URL copies that protected host into Claude or their calendar app. Set it in production; leave it unset for local dev, e2e, and previews |
| `API_KEY_ENCRYPTION_SECRET` | server only | encrypts stored per-user Anthropic keys at rest (AES-256-GCM). Any long random string — `openssl rand -base64 32`. Unset, keys are stored in plaintext with a loud server-log warning on every save; set it later and existing rows are re-encrypted on first read. Rotating it invalidates saved keys |
| `CRON_SECRET` | server only | bearer token guarding the cron endpoints |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | server only | Gmail SMTP for review emails ([app password](https://myaccount.google.com/apppasswords); 2-Step Verification must be on) |
| `SEED_SOURCE_USER_ID` | server only | the account whose recurring workouts seed new users; falls back to the `profiles` row with `is_template_source = true` |
| `COROS_CLIENT_ID` / `COROS_REDIRECT_URI` | server only | watch sync; register with `node scripts/coros-spike.mjs register <callback-url>` |

There is deliberately **no `ANTHROPIC_API_KEY`**. The coach runs on each user's own key, saved under Profile → AI Coach, verified against Anthropic on save, and stored server-side encrypted.

</details>

---

## Documentation map

| Document | What it holds |
|---|---|
| [WELCOME.md](WELCOME.md) | The user guide — every feature, one short section each |
| [PRD.md](PRD.md) | Product requirements: data model, design system, feature specs, roadmap |
| [RECURRENCE_ENGINE_SPEC.md](RECURRENCE_ENGINE_SPEC.md) | The recurrence rewrite — current-state findings, judgment calls, open questions |
| [WORKOUT_TRACKING_SPEC.md](WORKOUT_TRACKING_SPEC.md) | Tracker model, set logging, PR detection |
| [EXERCISE_LIBRARY_SPEC.md](EXERCISE_LIBRARY_SPEC.md) | Library, alias resolution, definitions |
| [CONNECTORS.md](CONNECTORS.md) | Connecting Claude, ChatGPT, and other MCP clients |
| [DEPLOY_MULTI_USER.md](DEPLOY_MULTI_USER.md) | Multi-user deployment, auth URLs, invites |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow rules, parallel-session hazards, autonomous merging |
| [evals/README.md](evals/README.md) | The coach eval suite: quality decomposition, harness, judge validation |
| [docs/ios/MASTER.md](docs/ios/MASTER.md) | The iOS port: vision, decisions, architecture, workstreams, status |

---

## Feedback

This is a personal project, built for one athlete's actual training. If something here is useful to you — or broken — [issues](https://github.com/shanehaynes/apex-training/issues) are welcome.
