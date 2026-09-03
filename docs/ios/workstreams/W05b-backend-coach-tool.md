# W5b — Backend: `/api/coach-tool` (server-side tool execution)

**Machine:** Linux · **Depends on:** W5a · **Unblocks:** W6 (actions), W7, W9
**Status:** blocked on W5a

## Goal
Confirmed coach actions execute on the server with the same executors the evals test, so no
client carries `tools.ts`.

## Scope
In:
- Extract services from `api/_lib/handlers/events.ts`, `eventInstances.ts`,
  `exerciseDefinitions.ts`, `api/_lib/meals.ts` into `api/_lib/services/*` (behaviour-preserving;
  handlers become thin).
- `api/_lib/coach/serverDeps.ts` implementing `CoachToolDeps` over the services.
- `POST /api/coach-tool { toolUseId, name, input, today }` → `{ resultText, ok }` for mutation
  tools; `{ resultText, draft }` for `update_workout_draft` / `update_chart_draft` (stateless
  reduce over the body's draft).
- Server stamps `triggered_by: 'ai'`; `enforceAiMutationCap` moves here. Optional HMAC on
  tool_use ids.
- Web `confirmAction` executor → `/api/coach-tool`; delete the sidebar deps wiring.
- Integration test running one recorded eval case through `serverDeps` on the local stack.
Out: conversation persistence (client, D-013).

## Acceptance
- All existing handler integration tests green after extraction (no behaviour change).
- `/api/coach-tool` rejects unknown tools, enforces the AI cap, isolates users.
- Web coach confirm flow green in Playwright (mock intercepts updated).
- Local gate green.

## Session log
- (none yet)
