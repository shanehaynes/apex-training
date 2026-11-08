# Coach corrects a session's recorded times — validation

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it), and the
`coach-gate` CI job (`eval:verify`) against a fresh `eval:gate` attestation.

## Requirement proofs

| Req | Proof | Kind | Status |
|---|---|---|---|
| R1 | `src/lib/coach/__tests__/tools.test.ts` "edit_session_times": executor calls `editSessionTimes` with the resolved times; `api/__tests__/coach-tool.test.ts` "edit_session_times": the handler's deps update `workout_sessions` and `workout_completions` through `applyEditTimes` | unit, integration | not proven |
| R2 | `tools.test.ts`: `finished_at` keeps the recorded start; `duration_minutes` ends start + N min; `started_at` + `duration_minutes` ends from the new start | unit | not proven |
| R3 | `tools.test.ts`: naive timestamp, both, neither, zero and negative duration, finish before start, no session → refusal text and no `editSessionTimes` call | unit | not proven |
| R4 | `coach-tool.test.ts`: a still-running session's refusal text is the tool result | integration | not proven |
| R5 | `tools.test.ts` label cases: resolved title, times in a named zone with abbreviation, duration, "keeps recorded start" | unit | not proven |
| R6 | `coach-tool.test.ts`: an `event_mutations_log` insert with `triggered_by 'ai'`, `operation 'update'` and the before/after diff | integration | not proven |
| R7 | `tools.test.ts`: result text names both instants and both durations | unit | not proven |
| R8 | `tools.test.ts` executor passes the id and date through; `coach-tool.test.ts` deps resolve a base id to `base__date` | unit, integration | not proven |
| R9 | `api/__tests__/mcp*.test.ts`: `edit_session_times` is listed for a write token without `event_title`, refused for a read-only token | integration | not proven |
| R10 | `tools.test.ts` (or schema test): `update_event`'s description names `edit_session_times` | unit | not proven |
| R11 | `evals/cases/integrity.ts` `session-times-runaway-fix` and `session-times-plan-control`, both passing in the attested `eval:gate` run | eval | not proven |

## Beyond the gate
- `eval:gate` on the subscription (this session), with transcripts committed.
- The production fix of the three sessions named in the report is Shane's,
  through the coach, once this ships: it is his data and each edit is his
  confirmation.

## Done means
Every milestone box in `plan.md` checked, every proof above proven, the PR
merged, `scripts/git-tidy.sh --yes` run, the Next brief filled in, and the
replan opened (`docs/workflow-essentials.md`, "Replanning").
