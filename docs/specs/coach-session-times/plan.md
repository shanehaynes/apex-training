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
**Status:** in review (PR #552)

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
- [x] `edit_session_times` in `COACH_TOOLS` and `coachToolSchemas()`, with
      executor, label and unit tests
- [x] Server deps over `applyEditTimes` with the mutation-log row, and
      `timeZone` in the chat tool context
- [x] MCP coach-backed tool registered
- [x] Eval fixture sessions, the two cases, `eval:gate` attestation
- [x] `agent:check` green

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
- 2026-11-08 · The card names the date the edit lands on, not the resolved
  row's: a series' base id matches its anchor row (reviewer finding).
- 2026-11-08 · Durations are capped at a week, so no input overflows a Date.
- 2026-11-08 · `sessionTimes.ts` joins `BEHAVIOR_FILES`: it holds the regex,
  refusals and label text the model reads, so an edit there must re-attest.

## Session log
- 2026-11-08 · Spec written from the 2026-11-08 runaway-stretch report. M1
  built on `feat/coach-session-times`; reviewer findings fixed (one major:
  the anchor-date label). The first eval run of the new cases failed on the
  fixture, not the coach: unscripted `get_schedule` answered "no data" and
  the coach refused to guess an id; the control's "next Tuesday" read the
  agent-sdk backend's real clock. Both scripted, both pass. Not verified:
  a real device or browser confirm of the card.
- 2026-11-09 · The first gate run failed on a planner case this change does
  not touch; the single-sample baseline was the cause (#562 replaced it with
  a majority of three runs). Re-gated after merging main: 61 cases, no
  regressions, both new cases pass, attested.

## Learned
- An eval case for a write the coach must look up needs the reads that find
  it scripted; the prompt lists only this week.

## Next brief
**Runaway sessions stopped at Finish.** This feature repairs bad durations;
the next stops new ones. When an athlete finishes a session that has run far
past its plan (say more than 4× the planned length and over 3 hours), the
tracker asks when it really ended before it records the finish, defaulting
to the last logged set's time, with "it really ran this long" one tap away
(Article V: the athlete's number wins). Same on iOS (`TrackerModel.swift`)
and web (`TrackerView.tsx`); the server's `finish` action takes the chosen
`finishedAt` as it already does for offline queues. Spec under
`docs/specs/tracker-runaway-finish/`; one milestone per client. Check the
threshold against real data first: `list_sessions` durations versus plan.
