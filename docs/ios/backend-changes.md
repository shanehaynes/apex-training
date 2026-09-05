# Backend changes

Every change the port needs on the web/API side, in landing order. All new routes register in
`api/_lib/app.ts` (one `app.all(...)` line each) with handlers under `api/_lib/handlers/`; the
root `api/*.ts` count stays at 4 (`scripts/ci-guards.sh`). Where the web has an in-browser path
that the endpoint replaces, the web switches in the same PR so there is one implementation.

Conventions for every new endpoint:
- JWT via `requireUser()`; user id never taken from the body.
- `today: 'YYYY-MM-DD'` from the client wherever "today" matters (the server never reads the
  clock for calendar logic; the web already passes `today` into `buildSystemPrompt`).
- New rate-limit bucket **`reads`** `{ windowSeconds: 600, max: 300 }` in `api/_lib/rateLimit.ts`
  (string key to `bump_rate_limit`, no migration).
- Any `src/lib` module newly pulled into the API graph uses `.js` import specifiers — the real
  cause of the historical `api/chat.ts` cold-start crash. W0 adds a mechanical guard.

## W0 — read foundation (Linux)

### `GET /api/schedule?start=YYYY-MM-DD&end=YYYY-MM-DD[&include=definitions,templates]`
Wraps `fetchExpandedSchedule` + `fetchCompletionsInRange` in `api/_lib/mcp/data.ts`
(they already do RRULE expansion with the same `expandRecurringEvents` the calendar uses).
Cap 400 days. Bucket `reads`.

```jsonc
{
  "window": { "start": "2026-07-04", "end": "2026-12-31" },
  "bases": [ /* one resolved WorkoutEvent per BASE event, exercises JSONB resolved via definitions */ ],
  "occurrences": [ { "id": "<baseId>__2026-09-02", "baseId": "…", "date": "2026-09-02",
                     "startTime": "17:30", "endTime": "18:30", "isCompleted": true, "completedAt": "…" } ],
  "definitions": [ /* when included */ ], "templates": [ /* when included */ ]
}
```
Bases once + tiny occurrence stubs keeps the payload at the web's full-table read plus a few KB.
Resolve exercises per base, not per occurrence (the MCP tool does it per occurrence because it
returns occurrences). Web keeps its in-browser path for now.

### `POST /api/workout-sessions { action: 'quick-complete' }` without body rows
Server builds the rows via `buildQuickCompleteLogs(event)` (`src/lib/tracking/plan.ts`) when
`setLogs`/`cardioLogs` are absent; the web can keep sending rows during transition. Lets W2
toggle completion without porting `plan.ts`.

### `POST /api/query { tool, args }`
A JWT door onto the read-only MCP registry (`api/_lib/mcp/toolRegistry.ts`): `get_prs`,
`get_period_stats`, `get_exercise_history`, `search_exercises`, `get_training_blocks`,
`get_meals`, `get_workout_detail`. Same `McpToolDef.execute(supabase, userId, args)`; bucket
`reads`. ~50 lines. **POST only** with the tool name and its arguments in the JSON body —
`args` is a JSON object (nested values, numbers, booleans), which is why `Endpoint.query` takes
`[String: JSONValue]` and not a flat string map (W2 fixed a GET-shaped first version). Gives Swift library stats, history, PRs, period stats and block progress with
zero new logic; add richer dedicated handlers only where a screen needs a different shape.

### Guards and generators
- Import-graph guard: already exists as `api/__tests__/esm-imports.test.ts` (runs in `npm test`);
  no change needed. Any `src/lib` module newly reached from `api/` must switch to `.js`
  specifiers or that test fails.
- `scripts/db-types.sh`: also `supabase gen types --lang=swift >
  ios/Packages/ApexKit/Sources/ApexAuth/Generated/DatabaseTypes.swift` (D-021: the emit needs
  supabase-swift's `AnyJSON`, so it lives in `ApexAuth`, not `ApexCore`); `--check` covers it.
- `api/__tests__/integration/ios-read.integration.test.ts`: runs handlers against the local
  stack and writes `ios/Fixtures/*.json|ndjson` (`APEX_FIXTURES_WRITE=1`); by default it checks
  the committed files, which is what CI's `full` job does. W2 added `schedule-empty.json`,
  `activity-streams.json` (read through the anon client under the user's JWT, so the RLS
  SELECT policy is part of the contract) and `query-get_meals.json`.

## W3 — tracker consolidation (Linux)

All in `api/_lib/handlers/workoutSessions.ts` (bucket `tracker`), with the loader and model in a
new `api/_lib/trackerSession.ts` importing `src/lib/tracking/plan.js` and `records.js`.

- **`bootstrap { eventId, eventDate }`** → get-or-create the session (as `start`), resolve the
  event (`baseIdOf(eventId)` → row → `rowToEvent` → `resolveEventExercises`, occurrence date =
  `eventDate`), run the `sessionRepo.loadSession` queries on the admin client with
  `.eq('user_id', userId)` and `fetchAllPages` (the web's `.limit(500)` silently truncates), then
  `buildTrackerModel`. Response:
  ```jsonc
  { "session": { … }, "event": { /* resolved occurrence */ }, "groups": [ /* TrackedSectionGroup[] */ ],
    "scored": true, "prs": [ /* when already finished */ ], "scoreRecord": null }
  ```
- **`start { startedAt? }` / `finish { finishedAt? }`**: optional client timestamps bounded to
  `[server_now − 7d, server_now + 5min]`, finish ≥ start. Needed so an offline session flushed
  hours later keeps real times. No migration.
- **`finish`** returns `{ ok, totalDurationSeconds, prs: PersonalRecord[] (with description
  strings), scoreRecord, recap }`: after the autofill upsert, re-read rows, rebuild groups,
  `computeSessionPRs` with the same history loader, `computeWorkoutScorePR`, and
  `buildSessionRecap` (`src/lib/coach/summary.ts` moves into the API graph).
- **`POST /api/coach-summary { eventId, eventDate }`**: server rebuilds the recap from rows,
  streams the summary as NDJSON (lift `streamToWireEvents` from `api/chat.ts` into
  `api/_lib/wire.ts`), and persists `coach_summary` itself — deleting the client `summary`
  round-trip. Accept the legacy `{ recap }` body during transition (still one-shot JSON), and
  keep the `summary` action so a stale web bundle mid-session can land its text.
- Web: `useWorkoutSession` switches to `bootstrap`; `sessionRepo.loadSession` and the client
  `computeSessionPRs` calls are deleted. `setToRow/cardioToRow/collectUntouchedPlanned/
  makeExtraSet` stay client-side (edit-time serializers).

### W4 addendum — `bootstrap { peek: true }` (landed with W4 PR A)
`bootstrap` is a get-or-create: it stamps `started_at` before it builds the model. The native
app prefetches today's and tomorrow's workouts so one can start offline, and a prefetch must
never create a session row with a start time nobody chose — so `peek: true` skips the upsert
and returns the same `TrackerBootstrap` with `session: null` when none exists (404 for an
unowned event, as before). Fixture: `ios/Fixtures/bootstrap-peek.json`. The offline open then
queues `start { startedAt }` with the phone's time and passes the same stamp to the online
`bootstrap`, so both paths converge on one `started_at`.

## W5a — chat v2: server-side prompt assembly (Linux)

`api/chat.ts` accepts
```jsonc
{ "mode": "chat" | "builder" | "analytics", "messages": [...], "withTools": true,
  "today": "2026-09-02", "context": { "draft": { /* WorkoutDraft | ChartDraft, builder/analytics only */ } } }
```
and builds `system` via new `api/_lib/coach/context.ts` (inside chat.ts's permitted import
surface): schedule window via `fetchExpandedSchedule`, definitions, today's meals, athlete
profile fields, block summary (`blocks/promptSummary.ts` fed by `computeBlockProgress`),
4-week completion rate → `buildSystemPrompt` / `buildBuilderPrompt(describeDraft(draft))` /
`buildAnalyticsPrompt`. `describeDraft` (`src/lib/builder/draft.ts`) and `describeChartDraft`
(`src/lib/analytics/draft.ts`) move into the API graph (pure reducers, `.js` specifiers).
Legacy `{ system }` bodies keep working until the web switches (same PR).

Wire extension (additive): `{ type: 'tool_use', id, name, input, label }` — the server computes
the display label with a real `CoachToolContext`, so Swift never needs `findCoachTool`. The
web's collector strips `label` before the block goes back to the model (unknown fields 400).
Landed 2026-09-03: `api/_lib/coach/context.ts`; the analytics "other sport" titles and the
builder's template titles are derived server-side too.

Prompt caching is unaffected: tools → system → messages prefix and the three breakpoints are
unchanged; the system text is byte-identical to what the client would have built. Building it
server-side is what later allows moving the volatile schedule block out of `system` (the TODO in
chat.ts) without a client change. Cold start grows by an estimated 100–200 ms; the `.js` guard
plus `scripts/deploy-verify.sh`'s preview curl cover the module-load risk.

## W5b — `POST /api/coach-tool` (Linux)

Body `{ toolUseId, name, input, today }` → `{ resultText, ok }` or, for draft tools,
`{ resultText, draft }`.
- Mutation tools (`create_event`, `update_event`, `delete_event`, `set_event_exercises`,
  `update_exercise_definition`, `log_meal`, `update_meal`, `delete_meal`): run
  `findCoachTool(name).execute(input, deps, ctx)` from `src/lib/coach/tools.ts` with a server
  `CoachToolDeps` (`api/_lib/coach/serverDeps.ts`). This needs the create/update/delete logic of
  `events.ts`, `eventInstances.ts`, `exerciseDefinitions.ts`, `meals.ts` extracted into callable
  services (`api/_lib/services/{events,eventInstances,definitions,meals}.ts`) that both the HTTP
  handlers and the deps call — the main cost (~400 lines moved, behaviour-preserving, covered by
  the existing integration tests).
- Server stamps `triggered_by: 'ai'` and enforces `enforceAiMutationCap` itself — closing the
  documented client-attribution hole in `rateLimit.ts`. Optional hardening: chat.ts HMAC-signs
  each tool_use id; coach-tool verifies.
- Draft tools (`update_workout_draft`, `update_chart_draft`): stateless reduce — body carries
  the current draft, server runs the reducer (`applyDraftUpdate` / `applyChartDraftUpdate`) and
  returns the next draft. Bucket `reads`.
- Buckets: `writes` for mutation tools (shared with UI edits, as today).
- Web: `confirmAction`'s executor becomes a `POST /api/coach-tool`; the sidebar's `tools.ts`
  deps wiring is deleted.
- Evals: unchanged (they drive the executors with `memoryDeps.ts`); add one integration test
  that runs a recorded eval case through `serverDeps` against the local stack.

## W8 — `POST /api/analytics-compute { specs: ChartSpec[], today }` (Linux)

→ `{ tiles: TileResult[] }` (index-aligned, cap 24 specs; single-spec calls for the builder's
live preview). Wraps `computeTile` (`src/lib/analytics/engine.ts`), `needsHrZones/maxDayOffset`
(`spec.ts`), `zoneSeconds/zoneBounds` (`hrZones.ts`), and a server port of `loadAnalyticsInputs`
into `api/_lib/analyticsData.ts` using `fetchAllPages` (the web's bare `.select('*')` is capped
at PostgREST's 1000-row default — the server port changes numbers for heavy users; say so in the
PR). Active block for the `current-block` preset and HR settings load server-side. Bucket
`reads`. Promote `specProblem` into `analyticsTiles.ts` so the server validates specs and no
client does. Web may switch `useAnalyticsData` later.
Landed 2026-09-03 (`api/_lib/analyticsData.ts`, `handlers/analyticsCompute.ts`); the web still
computes in the browser.

## W10 — `POST /api/blocks?resource=cycle { spec }` → `{ blocks }` (Linux, small)
Wraps `blocks/cadence.ts` (`CycleSpecError`, overlap checks). Web switches its preview to it.
Also run `normalizeSupersets` (`schedule/supersets.ts`) in the events/templates insert + patch
services so every client gets re-lettering for free.

## W11 — profile, COROS, account (Linux + Mac)

- **Account deletion already exists**: `DELETE /api/account` (PR #93, `api/_lib/handlers/account.ts`,
  with `USER_DATA_TABLES` and a test that fails if a migration adds a user table it misses).
  iOS surfaces it in W11; no backend work. App Store guideline 5.1.1(v).
- **COROS from the app**: `provider-sync connect-start { client: 'ios' }` persisted on the
  pending `provider_connections` row (**migration: `provider_connections.client text`**, claim
  the number with `scripts/next-phase.sh` at PR time), and `providerCallback.ts` redirects that
  client to `apextraining://connected?provider=coros` (or `…/connect_error`). Universal links
  alone do not suffice: `ASWebAuthenticationSession` https callbacks need iOS 17.4 and the
  callback lands on `/`, which the AASA must not match.
- **Recovery redirect**: add `https://apextrainingcalendar.vercel.app/auth/callback` to Supabase
  Additional Redirect URLs (dashboard, Shane) and assert it in `scripts/auth-redirect-check.sh`.
- **Invite hand-off (W2, web)**: the SPA root shows "Open in the Apex app" when the hash carries
  `type=invite`, linking to `apextraining://auth#<same hash>`.

## Not in this roadmap (Backlog)
`device_tokens` migration + `/api/devices` + APNs sender (push), `coach_conversations` table
(server chat persistence).

## Summary

| Endpoint | Workstream | Wraps | Web switches | Bucket | Est. lines | Migration |
|---|---|---|---|---|---|---|
| `GET /api/schedule` | W0 | mcp/data.ts | later | reads | 150 | — |
| `quick-complete` server-built | W0 | plan.ts | optional | tracker | 40 | — |
| `POST /api/query` | W0 | mcp/toolRegistry.ts | no | reads | 50 | — |
| guards + generators + fixtures | W0 | — | — | — | 150 | — |
| `bootstrap`, timestamped `start`/`finish`, PRs + recap | W3 | plan.ts, records.ts, summary.ts | **yes** | tracker | 350 | — |
| `coach-summary` v2 (streaming) | W3 | buildSessionRecap | yes | summary | 80 | — |
| `chat` v2 + `label` | W5a | prompt.ts, draft describers, promptSummary.ts | yes | chat | 260 | — |
| `coach-tool` | W5b | tools.ts + services extraction | yes | writes/reads | 670 | — |
| `analytics-compute` | W8 | engine.ts, spec.ts, hrZones.ts | later | reads | 200 | — |
| `blocks?resource=cycle`, supersets in services | W10 | cadence.ts, supersets.ts | yes | writes | 80 | — |
| account deletion | W11 | exists: `DELETE /api/account` | — | — | 0 | — |
| COROS `client:'ios'` + scheme redirect | W11 | providers/* | no | providerSync | 40 | **yes** (`provider_connections.client`) |
