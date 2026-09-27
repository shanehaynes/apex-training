# C01 · Evals: realign the harness with the sight loop, add `sight` and `doctrine` cases

## Goal
The eval harness (`evals/`) still models the pre-B01 coach: eight write tools, one
client-driven tool round per turn, the prompt built by the compat wrapper. Since #345 and #348
the production coach sends the read tools and `read_doctrine` too, runs read-only rounds
server-side (up to five per turn), has the doctrine index and a "read before you prescribe"
rule in its stable prompt, and a physiology panel in its live half. A gate run today measures a
coach whose prompt tells it to call tools the harness never offers. Make the harness measure the
coach that ships, then add the cases that exercise what it can now do.

Why: `coach-gate` is red on `main` (attestation pins `2026.09.22-1`; prompt is `2026.09.26-1`).
Shane refreshes the attestation with one `eval:gate` run after this lane lands, so the run has
to be meaningful. You do not run the suite; no key or token exists in your session.

## Context you need
- Harness: `evals/src/harness.ts` (`runCase`, `buildSystem`, `executeTool`, the turn loop),
  `evals/src/types.ts` (`EvalCase`, `TurnRequest`, `Backend`), `evals/src/backends/api.ts`
  (the direct-API loop: stream with tools → confirm every tool_use → one tool_result message →
  re-stream with tools off) and `evals/src/backends/agentSdk.ts` (`schemasFor`, tools wrapped
  for the Agent SDK). `evals/src/memoryDeps.ts` is the in-memory `CoachToolDeps`.
- Production, on `main`: `api/chat.ts` (`chatToolSchemas()` = `coachToolSchemas()` +
  `readToolSchemas()` + `readDoctrineToolSchema`; `MAX_SERVER_ROUNDS = 5`; `runServerSideTool`;
  the loop from `for (;;)`), `src/lib/coach/tools.ts` (`isServerSideTool`,
  `SERVER_SIDE_READ_TOOL_NAMES`, `READ_DOCTRINE_TOOL`), `api/_lib/coach/readTools.ts`
  (`executeReadTool(supabase, userId, name, input)` — needs a Supabase client, which the harness
  does not have), `src/lib/coach/doctrine/index.ts` (`readDoctrine`, `DOCTRINE_TOPICS`,
  `readDoctrineToolSchema`), `src/lib/coach/prompt.ts` (`buildStablePrompt`,
  `buildVolatileContext(..., physiology)`, `buildSystemPrompt(..., physiology)`),
  `src/lib/physiology/index.ts` (`computePhysiology`, `describePhysiology`, input types).
- The read tools' schemas come from `api/_lib/coach/readTools.ts`, whose graph is the MCP tool
  implementations. `evals/` already imports from `api/` (see `evals/src/models.ts`), so
  importing `readToolSchemas` there is fine; `executeReadTool` is not usable without a DB.
- Case files: `evals/cases/*.ts`, registered in `evals/cases/index.ts` (`ALL_CASES`, duplicate id
  check). Checkers in `evals/src/checkers/`, judge in `evals/src/judge/`. Dimensions today:
  constraints, progression, refusal, integrity (+ builder, analytics). `evals/README.md`
  documents the gate; read its "Gate" and "Backends" sections.
- `evals/baseline/` is HELD — never touch it. Adding cases is fine: a new case has no baseline
  entry and must pass on its own (`evals/gate.ts`, "new case").

## Ownership
You own `evals/**` except `evals/baseline/`. Nothing else. If the harness needs an export the
production modules do not provide (e.g. a pure "execute this read against fixture data"
function), write it inside `evals/` — do not edit `src/` or `api/`.

## Steps
1. **Tool list.** In both backends, chat mode offers the production list: `coachToolSchemas()`,
   then `readToolSchemas()`, then `readDoctrineToolSchema`, in that order. Builder/analytics
   unchanged.
2. **Fixture-backed reads.** `EvalCase.fixture` gains `reads?: Record<string, unknown | ((input: Record<string, unknown>) => unknown)>`
   keyed by read-tool name: the value (or the function's return) is what the tool "returns",
   JSON-stringified as `executeReadTool` would. A read tool the fixture does not script returns
   a short, honest empty result (`{"note":"no data for this athlete"}` style — choose one shape
   and document it) and records an anomaly `unscriptedRead:<name>`. `read_doctrine` is answered
   from the real `readDoctrine(topic)` — as a `document` block with `citations: {enabled: true}`
   on the API backend where the message shape allows it, plain text on the Agent SDK backend if
   its tool result type cannot carry a document (say which under DECISIONS).
3. **Server rounds.** In the API backend, a response whose tool_use blocks are all server-side
   (`isServerSideTool`) is answered in the same turn — assistant content echoed in full,
   one tool_result user message, re-call with tools ON — up to `MAX_SERVER_ROUNDS` (import it
   from `api/chat.ts`; if that import drags in Vercel types the harness cannot load, mirror the
   constant and pin it with a test). A mixed response executes the reads, then the confirm path
   runs for the writes exactly as today with the read results folded into the same tool_result
   message. Record every read in `toolCalls` with `kind: 'read'` (extend `RecordedToolCall`
   compatibly — existing checkers keep working). On the Agent SDK backend the SDK runs the loop:
   register the read tools as SDK tools whose handler is the fixture executor.
4. **Prompt.** `buildSystem` passes a physiology string: `''` by default, or
   `describePhysiology(computePhysiology(fixture.physiology, today))` when the fixture supplies
   `physiology?: PhysiologyInputs`. Add a fixture builder in `evals/src/fixtures.ts` for a small
   inputs object.
5. **Cases.** New `evals/cases/sight.ts` (`SIGHT_CASES`): integrity cases that require a read
   (`requireToolCall`-style expectation, extended to read names) — "why is my Z2 volume down this
   month?" must call `get_period_stats` or `get_exercise_history`; "how's my deadlift trending?"
   must call `get_exercise_history`; a constraints case proving reads never mutate (fixture
   events unchanged after the turn). New `evals/cases/doctrine.ts` (`DOCTRINE_CASES`) and a
   `doctrine` dimension in the checkers: deterministic where possible — a base-phase fixture
   (`block.phase === 'base'`) asking for "harder intervals" must not schedule VO2/anaerobic work
   (banned patterns on the created events), no muscular-endurance block before a strength base,
   a taper week's planned minutes below the prior week; and one judge-scored case on whether the
   answer cites doctrine when asked "why". Register both in `ALL_CASES`. Keep the total suite
   runtime sane: aim for 6–10 new cases.
6. **Report/diff.** `evals/src/report.ts` and `evals/diff.ts` show the new dimension and count
   reads per case.
7. **Tests.** `evals/__tests__/` (or wherever the existing harness tests live): a scripted
   CallModel that asks for a read, gets the fixture result, then answers — asserting the
   transcript shape (assistant tool_use → user tool_result → assistant text), the round bound, the
   mixed-round fold, the unscripted-read anomaly, and that `read_doctrine` returns the real
   topic text. Existing tests keep passing.
8. `evals/README.md`: a short "Reads and doctrine" section; note that editing `evals/src/` or
   `evals/cases/` invalidates the attestation by design and that Shane's next `eval:gate` run
   covers this lane, #345 and #348 together.

## NOT VERIFIED to carry forward
No suite run (no token). The orchestrator states this in the PR; Shane runs `eval:gate`.
