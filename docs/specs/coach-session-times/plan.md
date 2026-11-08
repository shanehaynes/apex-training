# Coach corrects a session's recorded times — plan

How `requirements.md` gets built. One milestone, one PR.

**Owns:** `src/lib/coach/{tools,schemas,prompt}.ts` (the tool, its schema, the
`PROMPT_VERSION` bump), `api/_lib/coach/{toolDeps,context}.ts`,
`api/_lib/mcp/writeTools.ts`, `evals/src/{types,memoryDeps,harness,reads}.ts`,
`evals/cases/integrity.ts`, `evals/gate/` and `evals/results/` (the
attestation), their tests, `CONNECTORS.md`, this folder.
**Forbidden:** gate-protected paths, `api/_lib/trackerSession.ts`'s
`applyEditTimes` contract (reused, not changed), `MISSION.md`.
**Depends on:** none. `feat/coach-sonnet-haiku-5-5` also touches
`src/lib/coach/`; whichever merges second re-runs `eval:gate`.
**Status:** in progress (feat/coach-session-times)

## Approach
The athlete's own edit-times path (`applyEditTimes`, R4.1–R4.5 of the core
loop) already validates and writes everything this needs. The coach gets a
twelfth confirm-card tool whose executor in `src/lib/coach/tools.ts` (the code
the evals drive) parses and checks the input, reads the recorded session
through a new optional dep, resolves the start and finish, and calls a second
dep that the server binds to `applyEditTimes` plus an `event_mutations_log`
row. Both deps are optional like memory, so a deps object without a database
answers that the edit is unavailable. The eval harness gets fixture sessions
and in-memory versions of both deps.

The label formats instants with `Intl.DateTimeFormat` in
`CoachToolContext.timeZone` (new, optional): the server sets it from
`profiles.timezone`; the web leaves it unset, so the browser's zone applies.

No migration, no new endpoint, no new dependency, no `TECHSTACK.md` row.

## Milestones

### M1 — the tool, both doors, evals
Delivers: R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11
- [ ] `edit_session_times` in `COACH_TOOLS` and `coachToolSchemas()`, with
      executor, label and unit tests
- [ ] Server deps over `applyEditTimes` with the mutation-log row, and
      `timeZone` in the chat tool context
- [ ] MCP coach-backed tool registered
- [ ] Eval fixture sessions, the two cases, `eval:gate` attestation
- [ ] `agent:check` green

## Decisions
- 2026-11-08 · Name `edit_session_times`, matching the tracker's `edit-times`
  action, not `update_session`: the tool changes times only.
- 2026-11-08 · Timestamps must carry an offset or `Z`. A bare wall-clock time
  is ambiguous on a server in UTC; rejecting it costs the model one retry,
  guessing costs a wrong record.
- 2026-11-08 · `duration_minutes` exists because the in-app coach sees times
  in UTC and does not know the athlete's offset; a duration needs neither.
- 2026-11-08 · No card preview: the context carries no session rows, and
  fetching one per label would put a query in the stream's send path.
- 2026-11-08 · The mutation-log row uses the base event id, like every other
  coach update; `event_date` names the occurrence.

## Session log
- 2026-11-08 · Spec written from the 2026-11-08 runaway-stretch report.

## Learned

## Next brief
