# Coach corrects a session's recorded times — validation

## Gate
`npm run agent:check` on every commit (the Stop hook enforces it), and the
`coach-gate` CI job (`eval:verify`) against a fresh `eval:gate` attestation.

## Requirement proofs

| Req | Proof | Kind | Status |
|---|---|---|---|
| R1 | `api/__tests__/coachSessionTimes.test.ts` "rewrites the session and the completion minutes through applyEditTimes (R1)"; `src/lib/coach/__tests__/sessionTimes.test.ts` "keeps the recorded start, hands the resolved instants to editSessionTimes…" | integration, unit | proven (PR #552) |
| R2 | `sessionTimes.test.ts` "resolveSessionTimes (R2)": `finished_at` and `duration_minutes` keep the recorded start; a duration ends from a given `started_at` | unit | proven (PR #552) |
| R3 | `sessionTimes.test.ts` "parseSessionTimesInput (R2, R3)" (no zone, Feb 30, both/neither, duration bounds, finish at or before start), "refuses … a duration that rounds to no time at all", executor "changes nothing for input it refuses", "says so when there is no tracked session"; `coachSessionTimes.test.ts` "answers a workout with no tracked session without writing (R3)" | unit, integration | proven (PR #552) |
| R4 | `coachSessionTimes.test.ts` "passes applyEditTimes's refusals through and writes nothing (R4)": running, untracked, synced, start too early, finish in the future | integration | proven (PR #552) |
| R5 | `sessionTimes.test.ts` "the card label (R5)": zone named, other-day finish, start-kept forms, unknown zone → UTC, never throws, minutes round as the record does, a series' base id names the occurrence's date; `api/__tests__/coach-context.test.ts` "the card label context carries the athlete's zone, UTC when unset or unknown" | unit | proven (PR #552) |
| R6 | `coachSessionTimes.test.ts` "logs the edit as an ai update with the before and after times (R6)" | integration | proven (PR #552) |
| R7 | `sessionTimes.test.ts` executor result text (both instants, both durations, the stored-review caveat) | unit | proven (PR #552) |
| R8 | `coachSessionTimes.test.ts` "reads the recorded session for this user only, and prefers the exact id…", "finds a recurring occurrence's session from its base id and the date…"; `sessionTimes.test.ts` "edits the session row the deps found…" | integration, unit | proven (PR #552) |
| R9 | `coachSessionTimes.test.ts` "is a write tool with the card-only title cut…"; `api/__tests__/mcp.test.ts` "tools/list for a read-only token hides every write tool" and "refuses a write tool for a read-only token" (generic over `MCP_WRITE_TOOLS`); `mcpWriteTools.test.ts` destructive list | integration | proven (PR #552) |
| R10 | `sessionTimes.test.ts` "update_event points at edit_session_times (R10)" | unit | proven (PR #552) |
| R11 | `evals/cases/integrity.ts` `session-times-runaway-fix` and `session-times-plan-control`, both passing in the attested `eval:gate` run (`evals/results/2026-11-09T15-59-34-105Z__gate__claude-sonnet-5.json`, against the majority baseline from #562) | eval | proven (PR #552) |

## Beyond the gate
- `eval:gate` on the subscription (this session), with transcripts committed.
- The production fix of the three sessions named in the report is Shane's,
  through the coach, once this ships: it is his data and each edit is his
  confirmation.

## Done means
Every milestone box in `plan.md` checked, every proof above proven, the PR
merged, `scripts/git-tidy.sh --yes` run, the Next brief filled in, and the
replan opened (`docs/workflow-essentials.md`, "Replanning").
