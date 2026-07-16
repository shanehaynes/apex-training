---
name: run-apex-training
description: Build, run, and drive the Apex Training web app. Use when asked to start the app, run the dev server, take a screenshot of the calendar or workout tracker UI, verify a UI change in the running app, or run its tests.
---

Apex Training is a Vite + React workout-calendar app backed by Supabase, with
Vercel functions under `api/`. The agent harness (Playwright + a dev-only
state bridge + an optional local Supabase stack) is how you run and drive it.
All paths are relative to the repo root.

## Two profiles — the one rule

**A live browser session must never touch production Supabase.**

- **Mock profile** (default, zero infrastructure): every `/api/*` request and
  every non-GET supabase call is stubbed by `e2e/lib/intercept.mjs`, and the
  auth session is fabricated. Safe against any `.env.local`. This is the only
  sanctioned way to drive the app when real credentials are configured.
- **Agent profile** (full stack, safe): `npm run dev:agent` + the LOCAL
  Supabase stack. Real sign-in, real RLS, real writes — all into local Docker
  Postgres. The vite API plugin (`dev/vercelApiPlugin.ts`) refuses to mount
  against any non-localhost backend, no override.

## Quick reference

```bash
# Mock profile — no backend needed
npm run e2e                                  # all mock Playwright specs
node scripts/drive.mjs state schedule        # read live app state as JSON
node scripts/drive.mjs click .btn-library shot library state calendar

# Agent profile — full stack
colima start && supabase start               # once per boot (Docker via Colima)
npm run db:reset-local                       # reset + reseed the local DB
npm run dev:agent                            # dev server with api/* served
npm run e2e:live                             # live Playwright specs

# Checks
npm run agent:check                          # tsc + vitest + mock e2e (no infra)
npm run agent:check:full                     # + DB reset + integration + live e2e
```

Playwright is a project dev dependency; if browsers are missing:
`npx playwright install chromium`.

## Reading app state (preferred over screenshots)

Dev builds expose `window.__apex.state(key?)` — JSON snapshots registered in
`src/dev/agentBridge.ts` (compiled out of production):

| key | contents |
|---|---|
| `schedule` | expanded events (id/title/date/times/completed), counts, loading flags, definition ids |
| `calendar` | currentDate, view, selected/tracking event ids, open overlays |
| `auth` | status, user id/email, display name, Anthropic-key status |
| `workoutSession` | active tracker session, per-set groups, elapsed, summary/PRs |

Use it from the drive CLI (`state <key|all>`), from specs (`apexState(page, key)`
in `e2e/lib/fixtures.ts`), or in any browser console.

## Deterministic clock

Date-semantic logic reads `src/lib/clock.ts`. Freeze it for reproducible
calendar output:

- Specs: `test.use({ fakeNow: '2026-09-07T08:00:00' })` (mock fixture option)
- Drive CLI: `APEX_FAKE_NOW=2026-09-07T08:00:00 node scripts/drive.mjs ...`
- Live specs anchor to `2026-08-03` — inside the seeded fixture window
  (Jul–Sep 2026). Write timestamps are never faked.

## Playwright layout

- `playwright.config.ts` — `mock` project (starts `npm run dev`) and `live`
  project (starts `npm run dev:agent`; only defined when
  `APEX_LOCAL_SUPABASE=1`). Both auto-start the web server, or reuse one
  already on :5173.
- `e2e/lib/` — `intercept.mjs` (stub layer), `session.mjs` (fabricated auth),
  `fixtures.ts` (test fixtures: interception, session seed, `fakeNow`,
  auto-failing on console errors).
- `e2e/mock/` — smoke, today, clock, tracker, reschedule, day-modal, library,
  edit-exercises, auth. Library/edit-exercises/auth self-skip in offline mode
  (no Supabase env → empty library, no auth gate); the live project covers
  those paths for real.
- `e2e/live/` — full-stack flows against the local stack; seeded users
  `agent@apex.local` (has data) and `agent2@apex.local` (empty — isolation
  proof), password `apex-agent-password`.
- Screenshots land in `e2e/screenshots/` (gitignored). Specs fail on any
  page console error.

For a flow the specs don't cover: explore with `scripts/drive.mjs`, then add
a spec next to its siblings. Never point a raw, un-intercepted browser at a
dev server unless it's the agent profile.

## Local Supabase stack

Docker runs via Colima on this machine (`colima start`, 4 GB). Then:

- `supabase start` / `supabase stop` — the stack (API :54321, Postgres :54322,
  Studio :54323). `supabase/config.toml` has analytics disabled (Colima
  socket issue) and `auto_expose_new_tables = true` (parity with the prod
  project's legacy grants).
- `npm run db:reset-local` — drops app tables, reapplies `schema.sql` + the
  phase migrations **in phase order** (lexicographic breaks: phase10 < phase2),
  creates the fixture users between phase8 and phase9 (phase9 aborts without
  the shanehaynes.sah@gmail.com auth user), applies any timestamped
  migrations, backfills profiles, seeds fixtures (recurring events + Jul–Sep
  2026 one-offs + the exercise library, all onto agent@apex.local).
- `.env.agent` (committed) holds the CLI's public local-dev default keys —
  not secrets. Prod credentials never go there; every harness script
  (`scripts/lib/localEnv.mjs`) refuses non-localhost URLs.

## Test

```bash
npm test        # vitest unit suites, ~1s (integration self-skips without the stack)
npx tsc -b      # typecheck
npm run lint    # oxlint — pre-existing warnings; diff against main, don't chase zero
```

## Gotchas

- **`/api/*` under plain `npm run dev`** is only served when the backend is
  local; otherwise it 404s and the app degrades gracefully (mock specs stub it).
- **Stubbed responses need CORS headers.** Route fulfillments answer
  cross-origin supabase fetches directly, so the browser enforces CORS against
  the stub: `Access-Control-Allow-Origin: *` on every response AND a 204 for
  `OPTIONS` preflights (already handled in `e2e/lib/intercept.mjs`).
- **`decodeURIComponent` doesn't decode `+`.** Supabase query strings encode
  spaces as `+`; replace `+` with a space before decoding or name matching
  silently fails (symptom: the tracker's prev column never renders).
- **`.maybeSingle()` profile reads** ask PostgREST for a bare object via the
  Accept header — stubs must answer in kind or supabase-js hands the app an
  array.
- **Vite forwards browser console to the terminal** — `[vite] (client)`
  lines in dev-server logs are page-side messages, not server errors.
- **`EADDRINUSE` / stale UI on relaunch** — a previous `vite` is still
  running: `pkill -f vite` first (Playwright reuses a running :5173 server).
