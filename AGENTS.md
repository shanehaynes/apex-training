# AGENTS.md

Context for AI coding agents working in this repo. The README covers what the app does for humans; this covers what you need to work on it safely.

## What this is

Apex Training: a single-user workout calendar + live workout tracker + AI coach. React 19 + Vite + TypeScript SPA in `src/`, Vercel serverless functions in `api/`, Supabase Postgres. Offline mode falls back to the bundled `src/data/schedule.json` + localStorage.

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

- **The dev server talks to production Supabase.** Clicking around a live browser session writes and deletes real rows. To drive the UI, use the `run-apex-training` skill (`.claude/skills/run-apex-training/`) — its `driver.mjs` stubs all write-capable requests.
- Reads use the browser anon key (SELECT-only under RLS). **All writes go through `api/`** with the service-role key. The Anthropic key never reaches the browser. Don't add client-side writes or expose keys.
- `decodeURIComponent` does not decode `+`, and Supabase encodes spaces as `+`. Known trap in name-based matching (e.g. the tracker's "prev" column).
- Recurring events: editing one occurrence creates a per-occurrence **override** — never edit the series in place. Preserve the event's duration when its start time moves. Reject times where end is not after start.
- `supabase/migrations/` apply in filename order (phase2 → phase8). New migrations continue the sequence.

## Layout

| Path | Purpose |
| --- | --- |
| `src/lib/` | Pure, React-free domain logic. **Start here for behavior changes.** `recurrence/` (RRULE parse/expand), `schedule/` (event expansion, occurrence ids, definitions), `tracking/` (tracker plan, PR detection), `coach/` (prompt, tool registry, wire format), `library/` (exercise library repo/stats), `db/types.ts` (single source of Supabase row types, shared with `api/`). |
| `src/components/` | React components by feature: `calendar/`, `tracker/`, `modal/`, `composer/`, `library/`, `sidebar/`, `layout/`. |
| `src/context/` | `CalendarContext`, `ScheduleContext` — state distribution only, no domain logic. |
| `src/hooks/` | `useChat` (NDJSON streaming), `useWorkoutSession`, `useMediaQuery`. |
| `api/` | Vercel serverless functions: event/completion/session/definition writes, coach chat proxy, ICS feed. Shared service-role client in `api/_lib/supabaseAdmin.ts`. |
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
