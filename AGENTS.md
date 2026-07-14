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
| `npm run dev` | Vite at http://localhost:5173. Does **not** serve `api/*` — writes and AI features 404 and degrade gracefully. Use `vercel dev` for the full stack. |
| `npm test` | Vitest, runs in ~1s. |
| `npx tsc -b` | Typecheck. |
| `npm run lint` | oxlint. Pre-existing warnings exist — compare against main; don't chase zero. |
| `npm run build` | `tsc -b && vite build` → `dist/`. |

## Safety and gotchas

- **The dev server talks to production Supabase.** Clicking around a live browser session writes and deletes real rows. To drive the UI, use the `run-apex-training` skill (`.claude/skills/run-apex-training/`) — its `driver.mjs` stubs all write-capable requests (and, since phase 9, fabricates the auth session).
- **Multi-tenancy (phase 9/10):** every data table carries `user_id`. Browser reads use the signed-in session's JWT and RLS (`auth.uid() = user_id`) does the filtering. **All writes go through `api/`** with the service-role key, which bypasses RLS — so every handler MUST call `requireUser` (`api/_lib/auth.ts`) and stamp/filter by the verified uid. Never trust a `user_id` arriving in a request body; per-user unique keys (e.g. `(user_id, event_id)`) are the backstop. The Anthropic key never reaches the browser. Don't add client-side writes or expose keys.
- `exercise_definitions` is keyed `(user_id, id)` — ids are client-side slugs and are only unique per user. Any query on it must scope by `user_id`.
- `decodeURIComponent` does not decode `+`, and Supabase encodes spaces as `+`. Known trap in name-based matching (e.g. the tracker's "prev" column).
- Recurring events: editing one occurrence creates a per-occurrence **override** — never edit the series in place. Preserve the event's duration when its start time moves. Reject times where end is not after start.
- `supabase/migrations/` apply in filename order (phase2 → phase10). New migrations continue the sequence. phase9 (multi-user) requires Shane's auth user to exist first; phase10 (RLS lockdown) only after the authenticated deploy is live — see the header comments in each.

## Layout

| Path | Purpose |
| --- | --- |
| `src/lib/` | Pure, React-free domain logic. **Start here for behavior changes.** `recurrence/` (RRULE parse/expand), `schedule/` (event expansion, occurrence ids, definitions), `tracking/` (tracker plan, PR detection), `coach/` (prompt, tool registry, wire format), `library/` (exercise library repo/stats), `db/types.ts` (single source of Supabase row types, shared with `api/`). |
| `src/components/` | React components by feature: `calendar/`, `tracker/`, `modal/`, `composer/`, `library/`, `sidebar/`, `layout/`. |
| `src/context/` | `AuthContext` (session, profile, sign-in/out, password flows), `CalendarContext`, `ScheduleContext` — state distribution only, no domain logic. |
| `src/hooks/` | `useChat` (NDJSON streaming), `useWorkoutSession`, `useMediaQuery`. |
| `api/` | Vercel serverless functions: event/completion/session/definition writes, coach chat proxy (runs on the caller's own Anthropic key from the server-only `user_api_keys` table — no env key), ICS feed. Shared service-role client in `api/_lib/supabaseAdmin.ts`, JWT check in `api/_lib/auth.ts`, key helpers in `api/_lib/anthropicKey.ts`. |
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

Pure logic in `src/lib/` gets unit tests in its colocated `__tests__/`; API handlers are tested in `api/__tests__/`. Before committing: `npm test` and `npx tsc -b`.
