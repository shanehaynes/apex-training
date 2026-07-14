---
name: run-apex-training
description: Build, run, and drive the Apex Training web app. Use when asked to start the app, run the dev server, take a screenshot of the calendar or workout tracker UI, verify a UI change in the running app, or run its tests.
---

Apex Training is a Vite + React workout-calendar app backed by Supabase
(config in `.env.local`) with Vercel functions under `api/`. Drive it
headless via `.claude/skills/run-apex-training/driver.mjs` — a
puppeteer-core script that launches system Chrome against the dev
server with all write-capable requests stubbed, so nothing you click
mutates the real Supabase project.

All paths are relative to the repo root.

## Prerequisites

- `/usr/bin/google-chrome` (present on this machine; no chromium-cli or
  Playwright installed).
- Node + npm (project deps via `npm install`).
- `puppeteer-core` is NOT a project dependency — install it without
  touching `package.json`:

```bash
npm i --no-save puppeteer-core
```

## Run (agent path)

Start the dev server in the background and poll the port (don't sleep —
first paint is fast but not instant):

```bash
npm run dev > /tmp/apex-vite.log 2>&1 &
timeout 30 bash -c 'until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done'
```

Then drive it:

```bash
node .claude/skills/run-apex-training/driver.mjs smoke     # calendar + event modal
node .claude/skills/run-apex-training/driver.mjs tracker   # full workout-tracker flow
node .claude/skills/run-apex-training/driver.mjs today     # Today-button disabled state
```

| mode | what it does |
|---|---|
| `smoke` | Loads the calendar, screenshots it, opens the first event's modal, screenshots that. |
| `tracker` | `smoke`, then clicks Start Workout, screenshots the tracker (desktop), taps a "prev" value to autofill a set input, screenshots again, then re-screenshots at a 390px mobile viewport. |
| `today` | Asserts the top-nav Today button is disabled on the current period, enabled after paging forward, and that clicking it returns to (and re-disables on) the current period. Screenshots each state. |
| `library` | Opens the exercise library from the top nav; screenshots the list, the first exercise's detail (stubbed history renders the PR card + trend chart), and the definition editor; then asserts the exercise-name deep link from the workout modal lands on the detail page. |
| `edit-exercises` | Opens the first event's modal, enters exercise edit mode, adds an exercise from the picker (search "plank"), edits its sets, saves (PATCH stubbed), and asserts the added exercise renders in the read view via the optimistic update. Screenshots each step. |
| `day-modal` | Clicks a day number to open the day-overview modal, asserts its header/Add button, checks an event row swaps in the workout modal, then walks the add-event composer: type grid → Strength form → picker pre-filtered to strength → save (stubbed POST closes the composer; in seed mode asserts the failure toast instead). |
| `auth` | Signed-out login screen (asserts the password-manager `autocomplete` attributes), forgot-password mode, then seeds a fabricated session and reloads: asserts the TopNav avatar, template-offer banner, and profile overlay (5 avatar options, ICS feed URL). |

Since phase 9 (multi-user), the app is gated behind Supabase Auth. In every
mode except `auth`, the driver seeds a fabricated session into localStorage
before page load so the gate opens; `/auth/v1/*` and `profiles` reads are
stubbed, and passthrough REST reads get the anon key swapped back in place
of the fake JWT (after the phase10 RLS lockdown those reads return zero rows
and the app falls back to the bundled seed schedule).

The driver launches `/usr/bin/google-chrome` by default; on macOS set
`CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.

Screenshots land in `.claude/skills/run-apex-training/screenshots/`
(gitignored). The driver prints each path, reports page console errors,
and exits non-zero if any occurred. **Look at the screenshots** — the
tracker ones should show set rows with `# / TARGET / PREV / …` header
labels and fabricated prev values (`0:45`, `1:00`).

Stop the server when done:

```bash
pkill -f vite   # exits non-zero even on success; ignore the code
```

For a flow the driver doesn't cover, extend `driver.mjs` (keep the
request-interception block — see Gotchas) rather than pointing a raw
browser at the dev server.

## Run (human path)

```bash
npm run dev   # → http://localhost:5173, Ctrl-C to stop
```

Useless headless, and every click writes to the real Supabase project.

## Test

```bash
npm test        # vitest — all suites pass, ~1s
npx tsc -b      # typecheck
npm run lint    # oxlint — has pre-existing warnings; diff against main, don't chase zero
```

## Gotchas

- **The dev server talks to production Supabase.** `.env.local` holds
  real credentials; starting/finishing/cancelling a workout in a live
  browser writes (and cancel *deletes*) real rows. The driver stubs
  `/api/*` and all non-GET supabase.co requests for exactly this
  reason. Never drive the app with interception disabled.
- **`/api/*` doesn't exist under `vite dev`.** Vercel functions aren't
  served, so tracker fetches to `/api/workout-sessions` 404 without the
  driver's stubs.
- **Stubbed responses need CORS headers.** puppeteer's `req.respond`
  answers cross-origin supabase fetches directly, so the browser
  enforces CORS against your stub: include
  `Access-Control-Allow-Origin: *` on every response AND answer
  `OPTIONS` preflights with 204, or every fetch fails.
- **`decodeURIComponent` doesn't decode `+`.** Supabase query strings
  encode spaces as `+` (`exercise_name=in.(Glute+Squeeze+Holds,...)`);
  replace `+` with a space before decoding or name matching silently
  fails (symptom: the tracker's prev column never renders).

## Troubleshooting

- **Console spam: "blocked by CORS policy: Response to preflight
  request doesn't pass access control check"** — a new intercepted
  endpoint is missing the CORS headers / OPTIONS handling above.
- **`EADDRINUSE` / stale UI on relaunch** — a previous `vite` is still
  running: `pkill -f vite` first.
- **Driver reports `no prev button found`** — the first calendar event
  has no set-tracked (non-cardio) exercises, or the exercise-name
  parsing broke (see the `+` gotcha).
