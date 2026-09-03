# W5b — Backend: `/api/coach-tool` (server-side tool execution)

**Machine:** Linux · **Depends on:** W5a · **Unblocks:** W6 (actions), W7, W9
**Status:** in review (PR pending)

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
- 2026-09-03 · Linux · Services extracted behaviour-for-behaviour into `api/_lib/services/{events,
  eventInstances,definitions,meals,completions}.ts` (+ `result.ts`); the five HTTP handlers are thin
  doors (auth → throttle → AI cap → service). `api/_lib/coach/serverDeps.ts` implements
  `CoachToolDeps` over them, mirroring what ScheduleContext/MealsContext did for the coach (ai- ids,
  retro-log completion + plan-filled session via the shared `applyQuickComplete`, merged occurrence
  overrides, synchronous definition resolution like the eval fixture). `POST /api/coach-tool`
  (`handlers/coachTool.ts`): mutation tools run the real executors with `writes` + the AI cap
  (`aiMutationCapReached` split out of `enforceAiMutationCap`); `update_workout_draft` /
  `update_chart_draft` are a stateless reduce (`reads`). Web: `ChatSidebar` confirm posts to
  `/api/coach-tool` and refetches completions; the builder/analytics panels keep their local
  reducers (same functions). Tests: `coach-tool.test.ts`, `server-deps.test.ts`; integration runs
  the recorded eval `create_event` input from `evals/results/transcripts/…/postop-knee-load-cap.json`
  end to end (row + `triggered_by='ai'` log, cross-user isolation); fixture `coach-tool.json`.
  Not done: the optional HMAC on tool_use ids.
