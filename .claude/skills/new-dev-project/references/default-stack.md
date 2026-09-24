# Default stack

The user's proven stack, from building Apex Training with many parallel
sessions. It is a default, not a rule: propose it in step 0 with one line of
why, and propose something else when the project's shape calls for it.

| Layer | Default | Why this one |
|---|---|---|
| Front end | React + Vite + TypeScript (strict) | Fast dev server, one config every tool reads, typecheck is part of the gate |
| API | Vercel serverless functions under `api/`, one router (Hono) behind few entry files | Deploys with the front end; one router keeps the function count (a hobby-plan limit) flat as routes grow |
| Data | Supabase (Postgres + RLS) | Real SQL and row-level security; a local stack for tests |
| Unit tests | Vitest | Shares Vite's config |
| E2E | Playwright, a mock project (no DB) and a live project (local DB) | The mock project is parallel-safe and belongs in the gate; the live one is not |
| Lint | oxlint | Fast enough to sit in the gate |
| Hosting | Vercel (previews per PR) | Preview deploys verify a branch without touching production |

## When not to use it

- **No UI, or a CLI/data tool** → Python with `uv`, `pytest`, `ruff`; gate is
  `uv run pytest && uv run ruff check && uv run ruff format --check`.
  `lane.sh` already runs `uv sync --frozen` in new lanes.
- **Heavy background work, long-running jobs, websockets at scale** →
  serverless is the wrong shape; say so and propose a long-lived service.
- **Native mobile** → the light path inside an existing repo if a backend
  already exists (as Apex's `ios/` did); otherwise its own repo with its own
  platform gate, and a note that Linux sessions cannot build it.
- **Someone else's conventions win** — an employer, a class, a collaborator.

Record whichever is chosen, and the rejected options, as a decision.

## Parallel-safety edits for the default stack

Do these right after `npm create vite@latest` — each one is a row in the
shared-state inventory.

### One port resolver: `dev/port.mjs`

Every tool that binds or targets the dev port imports this. It delegates to
the vendored `lane.sh port`, so the port a lane is told when it is created and
the port its server binds are computed by the same code.

```js
// The dev-server port for THIS checkout. vite.config.ts and
// playwright.config.ts both read it, so they can never disagree; it
// delegates to parallel-agents' lane.sh so lane creation reports the same port.
// Primary checkout → 5173; a worktree → a port hashed from its directory.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function devPort() {
  const override = process.env.APP_PORT;
  if (override) {
    const n = Number(override);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`APP_PORT must be 1024–65535, got "${override}"`);
    return n;
  }
  const lane = join(root, '.claude/skills/parallel-agents/scripts/lane.sh');
  return Number(execFileSync('bash', [lane, 'port', root], { encoding: 'utf8' }).trim());
}
```

- `vite.config.ts`: `server: { port: devPort(), strictPort: true }` and the same
  for `preview`. strictPort turns a clash into an error instead of Vite
  sliding to the next port, which nothing else would follow.
- `playwright.config.ts`: `webServer.port` and `use.baseURL` from `devPort()`;
  `reuseExistingServer: !process.env.CI` is then safe, because a server on
  this port can only be this checkout's.
- Supabase's local ports (54321–54324) sit outside `lane.sh`'s 5200–5999 range.

### Database: serialize every reset

There is one local Supabase stack per machine. Put the lock in the script so
no lane can forget it:

```json
"db:reset": "bash .claude/skills/parallel-agents/scripts/with-lock.sh db supabase db reset",
"e2e:live": "bash .claude/skills/parallel-agents/scripts/with-lock.sh db playwright test --project=live"
```

`e2e:live` is orchestrator-only and never in the gate. Generated types
(`supabase gen types`) are regenerated in the lane that changes the schema and
checked for drift in CI; never hand-merged.

### Migrations: timestamps fix the number, not the order

`supabase migration new` names files by timestamp, so two branches cannot
collide on a number — but they can still land in an order nobody chose: a
branch started Monday and merged Friday carries a Monday timestamp that sorts
*before* a migration already applied in production on Wednesday. Supabase's
`db push` refuses to insert a migration before the last applied one without
an explicit flag (verify on the CLI version in use). Treatment:

- **Re-stamp at PR open**: rename the branch's new migration files to the
  current time when the PR opens (claim late, as parallel-agents says for
  global counters).
- **CI check**: every migration file added by the PR sorts after every
  migration on `main`. This fails the second of two racing PRs while renaming
  is still free.

Add both when the first migration is written (earned tier), not on day 0.

### Gate

```json
"check": "tsc -b && vitest run && oxlint && playwright test --project=mock"
```

Everything in it is per-checkout. If the mock e2e makes the gate too slow for
lanes, split it: `check` stays the lane gate, CI runs e2e as a second job, and
`CLAUDE.md` says the lane gate does not run e2e.
