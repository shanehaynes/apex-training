# AI coach — status board

Living document. **The orchestrator updates this file after every lane report and every
merge.** Lanes do not edit it; they report. Detail belongs in the lane's brief.

States: `ready` · `in progress (session)` · `pushed (sha)` · `in review (PR #)` · `done (PR #)` · `blocked on …`

| Lane | Title | Wave | State | Branch | Notes |
|---|---|---|---|---|---|
| A01 | Read tools: coach adapter over the MCP set + session summaries, reviews, history search | A | done (#341) | `feat/coach-read-tools` | no hot files |
| A02 | Physiology panel: zones, load ratio, tonnage, HRV as pure functions + fetch | A | done (#342) | `feat/coach-physiology` | no hot files |
| A03 | Doctrine: original synthesis as `.ts` topics, index, tool schema | A | done (#343) — content edits welcome on `main` before B01 wires it in | `feat/coach-doctrine` | 78,890 chars; DECISIONS lines first |
| A04 | Rich confirm cards: before/after preview per tool call | A | done (#344) | `feat/coach-confirm-preview` | owns `ChatSidebar.tsx` this wave |
| A05 | Cache prefix: stable/volatile prompt split, server-side injection, 1h TTL | A | done (#345) — merged with the attestation still stale, see Next up | `feat/coach-cache-prefix` | `PROMPT_VERSION` → 2026.09.25-1; Opus 5.5 `midTurnSystem` off until verified |
| B01 | Sight loop: read tools + doctrine + physiology wired into chat; server-side read rounds; chips | B | done (#348, `f833db0`) | `feat/coach-sight-loop` | `PROMPT_VERSION` → 2026.09.26-1; merged past the red gate like #345 |
| B02 | Board + embeddings issue | B | done (this branch, issue #340) | `chore/coach-board` | orchestrator |
| C01 | Evals: harness realignment, `sight` and `doctrine` cases, doctrine dimension | C | in progress (launched 2026-09-27 from `f833db0`; session id in Recent sessions) | `feat/coach-evals-sight` | cloud session; no suite run (no token) |
| C02 | Memory: `coach_memory` migration, memory tool backend, proposal cards | C | in progress (launched 2026-09-27 from `f833db0`; session id in Recent sessions) | `feat/coach-memory` | HELD (migration); phase number claimed at PR open |
| C03 | Calendar annotations: table, handler, chips, block strip | C | in progress (launched 2026-09-27 from `f833db0`; session id in Recent sessions) | `feat/coach-annotations` | HELD (migration); phase number claimed at PR open |
| D01 | Reflection + coaching contract (nightly Batch API, proposal-gated) | D | ready (after C) | `feat/coach-reflection` | HELD (migration) |
| D02 | Notebook page: memory, proposals, contract history, doctrine index | D | ready (after C) | `feat/coach-notebook` | |
| D03 | Weekly review document + "next week" proposal batch | D | ready (after C) | `feat/coach-weekly-review` | |
| E01 | Block planner mode | E | ready (after D) | `feat/coach-block-planner` | alone in its wave: owns every hot file |
| E02 | Ask-coach from a session or set | E | ready (after D) | `feat/coach-ask-from-context` | |

## Next up
1. **Wave B is on `main`** (#348 → `f833db0`). Wave C launched as three cloud sessions from that
   `main`; the orchestrator checks in every ~60 min, reviews each report, opens PRs, drives CI.
2. **Attestation debt (Shane):** still `2026.09.22-1` vs prompt `2026.09.26-1`; C02 bumps to
   `2026.09.27-1` and C01 changes the eval surface. Run `npm run eval:gate` once after wave C is
   on `main` (with C01's harness the run measures the coach that ships); instructions in the
   2026-09-27 chat. Until then `coach-gate` stays red on coach-path PRs and is overridden at
   merge, as on #345 and #348.
3. **Migrations (orchestrator at PR open):** C02 → `phase48`, C03 → `phase49` (next free is 48).
   `database.types.ts` is hand-written by the lanes; CI's `full` job checks drift — if it flags,
   Shane regenerates on his stack (`npm run db:reset-local && npm run db:types`).
4. **Shane:** review the doctrine text on `main` (`src/lib/coach/doctrine/`).
5. Open follow-up from #348 review: carry signed thinking blocks over the wire for the
   client-side write continuation (whole write path; predates B01).

## Recent sessions
- 2026-09-25 · orchestrator · plan approved, issue #340 opened, board created, wave A launched
  as five cloud sessions.
- 2026-09-25 · Shane · merged #341–#344 (and #346, Resend email); main at `6520b00`.
- 2026-09-25 · orchestrator · all five lanes reported; fold green on tsc/vitest/lint/guards
  (local mock e2e blocked by a Playwright browser mismatch, CI covers it); PRs #341–#345
  opened; two `full`-job failures (integration tests no lane can run) fixed and pushed.
  Lesson for the briefs: name the integration suite under NOT VERIFIED explicitly.
- 2026-09-26 · Shane · merged #345 (`43a6794`); wave A complete. Attestation not refreshed.
- 2026-09-26 · orchestrator · B01 launched as cloud session `session_01B7L15TtZEXTvhXTBPYYDhD`
  from `main` at `43a6794`; stale #345 check-in trigger deleted; B01 check-in armed.
- 2026-09-26 · orchestrator · B01 reported (four commits, +1656/−104); reviewed; local gate
  green (build, vitest 1873, oxlint, guards); #348 opened and subscribed.
- 2026-09-26 · orchestrator · #348 review: Codex P2s fixed and pushed (`0b5045d`); P1 (thinking
  blocks dropped on the client-side tool continuation) answered as pre-existing and out of scope,
  left open for Shane; follow-up recorded in the PR body.
- 2026-09-27 · Shane · merged #348 (`f833db0`); wave B complete.
- 2026-09-27 · orchestrator · wave C launched from `f833db0` as three cloud sessions: C01
  `session_01VhPvGA93vfvXgZTKPQNeBB`, C02 `session_01PbDeBCdLLRzAo1FtEyj6uu`, C03
  `session_01FtGHeRTXwEZL3bcPf48Wcw`; briefs in `workstreams/C0{1,2,3}-*.md`.
