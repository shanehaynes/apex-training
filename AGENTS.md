# AGENTS.md

Context for AI coding agents working in this repo. The README covers what the app does for humans; this covers what you need to work on it safely.

## What this is

Apex Training: a multi-user (~5 accounts, invite-only) workout calendar + live workout tracker + AI coach. React 19 + Vite + TypeScript SPA in `src/`, Vercel serverless functions in `api/`, Supabase Postgres + Supabase Auth. Offline mode (no `.env.local`) falls back to the bundled `src/data/schedule.json` + localStorage and bypasses the auth gate entirely.

**Core invariant:** deterministic data (PRs, completion, schedule expansion) is computed client-side in pure, React-free modules under `src/lib/`. The AI coach narrates pre-computed facts — it never derives them. Keep it that way.

Specs live at the repo root: `PRD.md`, `RECURRENCE_ENGINE_SPEC.md`, `WORKOUT_TRACKING_SPEC.md`, `EXERCISE_LIBRARY_SPEC.md`. Read the relevant one before changing that domain.

## Commands

Node 20+, npm (`package-lock.json`).

| Command | Notes |
| --- | --- |
| `npm run dev` | Vite at http://localhost:5173, offline/prod-env profile. Does **not** serve `api/*` when the backend isn't local — writes and AI features 404 and degrade gracefully. |
| `npm run dev:agent` | Vite in **agent profile**: loads the committed `.env.agent` (local Supabase stack) and serves `api/*` in-process via `dev/vercelApiPlugin.ts`. Full stack, safe writes. Needs `supabase start` + `scripts/db-reset-local.sh` once. |
| `npm test` | Vitest unit tests, ~1s. Integration tests under `api/__tests__/integration/` self-skip unless `APEX_LOCAL_SUPABASE=1`. |
| `npm run e2e` / `npm run e2e:live` | Playwright `mock` project (writes stubbed, no backend) / `live` project (real local stack, no stubs). |
| `npm run agent:check` | `tsc -b` + vitest + mock e2e. Zero infrastructure — run before committing. |
| `npm run agent:check:full` | agent:check + DB reset/seed + integration tests + live e2e. Needs Docker + `supabase start`. |
| `npm run db:reset-local` | Reset + reseed the LOCAL Supabase database (schema, all migrations in order, fixture users/data). |
| `npx tsc -b` | Typecheck. |
| `npm run lint` | oxlint. Pre-existing warnings exist — compare against main; don't chase zero. |
| `npm run build` | `tsc -b && vite build` → `dist/`. |

## Agent harness

Purpose-built tooling for driving and inspecting the running app — see the `run-apex-training` skill for the full workflow.

- **State bridge:** in dev builds, `window.__apex.state(key?)` returns JSON snapshots of live app state (`schedule`, `calendar`, `auth`, `workoutSession`). Registered via `src/dev/agentBridge.ts`; compiled out of production bundles. Read state instead of screenshotting.
- **Drive CLI:** `node scripts/drive.mjs state schedule` (or chained: `click .btn-library shot library state calendar`). Runs with the mock interception layer — cannot write real data.
- **Fake clock:** `window.__APEX_FAKE_NOW__` / `VITE_FAKE_NOW` / `APEX_FAKE_NOW` (drive CLI) freeze date-semantic logic (`src/lib/clock.ts`) so calendar renders are reproducible. Write timestamps are deliberately never faked.
- **Local stack:** `supabase start` (Docker/Colima) + `scripts/db-reset-local.sh` gives real auth/RLS/writes against seeded fixture users `agent@apex.local` / `agent2@apex.local` (password `apex-agent-password`; agent2 has no data — it exists to prove isolation).

## Safety and gotchas

- **Two profiles, one absolute rule: a live browser session must never touch production Supabase.**
  - *Agent profile* (`npm run dev:agent` + local stack): drive freely — writes land in local Docker Postgres. The vite API plugin hard-refuses to mount when `VITE_SUPABASE_URL` isn't localhost, with no override.
  - *Prod creds in `.env.local`*: never drive the UI without interception. The Playwright `mock` project and `scripts/drive.mjs` stub all write-capable requests (`e2e/lib/intercept.mjs`) and fabricate the auth session — that is the only sanctioned way.
  - The dev API shim (`dev/vercelApiPlugin.ts`) is not the Vercel runtime — verify prod-only concerns (headers, body parsing beyond JSON, crons) on preview deploys.
- **Multi-tenancy (phase 9/10):** every data table carries `user_id`. Browser reads use the signed-in session's JWT and RLS (`auth.uid() = user_id`) does the filtering. **All writes go through `api/`** with the service-role key, which bypasses RLS — so every handler MUST call `requireUser` (`api/_lib/auth.ts`) and stamp/filter by the verified uid. Never trust a `user_id` arriving in a request body; per-user unique keys (e.g. `(user_id, event_id)`) are the backstop. The Anthropic key never reaches the browser. Don't add client-side writes or expose keys.
- `exercise_definitions` is keyed `(user_id, id)` — ids are client-side slugs and are only unique per user. Any query on it must scope by `user_id`.
- `decodeURIComponent` does not decode `+`, and Supabase encodes spaces as `+`. Known trap in name-based matching (e.g. the tracker's "prev" column).
- Recurring events: editing one occurrence creates a per-occurrence **override** — never edit the series in place. Preserve the event's duration when its start time moves. Reject times where end is not after start.
- `supabase/migrations/`: the historical `phaseN_*.sql` files apply in **phase order, not filename order** (phase10 sorts before phase2 lexicographically) — `scripts/db-reset-local.sh` encodes the correct sequence. **New migrations use Supabase CLI timestamp naming** (`YYYYMMDDHHMMSS_name.sql`); they apply after the phases. phase9 (multi-user) requires Shane's auth user to exist first; phase10 (RLS lockdown) only after the authenticated deploy is live — see the header comments in each.

## Layout

| Path | Purpose |
| --- | --- |
| `src/lib/` | Pure, React-free domain logic. **Start here for behavior changes.** `recurrence/` (RRULE parse/expand), `schedule/` (event expansion, occurrence ids, definitions), `tracking/` (tracker plan, PR detection), `coach/` (prompt, tool registry, wire format), `library/` (exercise library repo/stats), `review/` (4-week-month calendar math, review stats/recap/email rendering), `db/types.ts` (single source of Supabase row types, shared with `api/`). |
| `src/components/` | React components by feature: `calendar/`, `tracker/`, `modal/`, `composer/`, `library/`, `sidebar/`, `layout/`. |
| `src/context/` | `AuthContext` (session, profile, sign-in/out, password flows), `CalendarContext`, `ScheduleContext` — state distribution only, no domain logic. |
| `src/hooks/` | `useChat` (NDJSON streaming), `useWorkoutSession`, `useMediaQuery`. |
| `api/` | Vercel serverless functions: event/completion/session/definition writes, coach chat proxy (runs on the caller's own Anthropic key from the server-only `user_api_keys` table — no env key), ICS feed. Shared service-role client in `api/_lib/supabaseAdmin.ts`, JWT check in `api/_lib/auth.ts`, key helpers in `api/_lib/anthropicKey.ts`. `review-cron.ts` (daily Vercel cron, CRON_SECRET bearer — no user JWT) emails monthly/yearly reviews via Gmail SMTP (`api/_lib/mailer.ts`), idempotent over the `reviews` table. |
| `supabase/` | `schema.sql`, ordered `migrations/`, Python seed/extract scripts. |
| `src/data/schedule.json` | Bundled offline seed schedule (~1.3 MB). |

## Conventions

- TypeScript everywhere, ES modules. Function components + hooks; React Context only — no Redux/Zustand.
- Styling: Tailwind v4 utilities plus design tokens in `src/styles/tokens.css`. `framer-motion` for animation, `lucide-react` icons, `recharts` for charts.
- Naming: PascalCase component files, camelCase lib modules, tests colocated in `__tests__/*.test.ts`.
- DB rows are snake_case; domain types are camelCase. Convert only through explicit `rowTo*` / `*ToRow` mappers (see `src/lib/schedule/definitions.ts`).
- Exercises carry a `definitionId` linking to the exercise library. When it resolves, definition fields win; otherwise the exercise's embedded snapshot is the fallback (this is what keeps offline mode rendering). Don't strip the snapshots.
- Coach schedule mutations go through the tool registry in `src/lib/coach/tools.ts` and are confirmation-gated in the UI. New coach capabilities follow that pattern.

## Testing

Four layers — put the test at the lowest layer that can catch the bug:

1. **Pure logic** (`src/lib/`): colocated vitest unit tests in `__tests__/`.
2. **Handler contract** (`api/__tests__/*.test.ts`): vitest with mocked auth/admin — request/response shapes, error paths.
3. **Handler vs. real DB** (`api/__tests__/integration/`): real local-stack JWTs through `requireUser`, RLS, cross-user isolation. Gated on `APEX_LOCAL_SUPABASE=1`.
4. **UI flows** (`e2e/mock/`, `e2e/live/`): Playwright specs asserting on `window.__apex` state, not just pixels.

Before committing: `npm run agent:check` (or at minimum `npm test` + `npx tsc -b`). CI (`.github/workflows/ci.yml`) runs all four layers.
