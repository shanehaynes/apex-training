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
| C01 | Evals: harness realignment, `sight` and `doctrine` cases, doctrine dimension | C | in review (#353, head `d7652c5`) — merges first; Codex P1 (round tracking) fixed | `feat/coach-evals-sight` | reconciling commit for C02's memory tool queued |
| C02 | Memory: `coach_memory` migration, memory tool backend, proposal cards | C | in review (#354, head `447dcd6`) — **HELD** (phase48); four Codex P2s fixed; iOS types added; merges second | `feat/coach-memory` | `PROMPT_VERSION` → 2026.09.27-1 |
| C03 | Calendar annotations: table, handler, chips, block strip | C | in review (#355, head `dafc92c`) — **HELD** (phase49); iOS types added; follow-up session C03b (`session_016WDHPxoH9Hu8jsrgJ4619u`) rendering notes in day/week views + event dismiss; merges third | `feat/coach-annotations` | README/api.ts conflict with C02 resolved at merge time |
| D01 | Reflection + coaching contract (nightly Batch API, proposal-gated) | D | ready (after C) | `feat/coach-reflection` | HELD (migration) |
| D02 | Notebook page: memory, proposals, contract history, doctrine index | D | ready (after C) | `feat/coach-notebook` | |
| D03 | Weekly review document + "next week" proposal batch | D | ready (after C) | `feat/coach-weekly-review` | |
| E01 | Block planner mode | E | ready (after D) | `feat/coach-block-planner` | alone in its wave: owns every hot file |
| E02 | Ask-coach from a session or set | E | ready (after D) | `feat/coach-ask-from-context` | |

## Next up
1. **Wave C in review**: #353 (C01) → #354 (C02, HELD) → #355 (C03, HELD), in that merge order.
   The fold of all three on `main` is green (build, vitest 2019, oxlint, guards). Two
   integration steps the orchestrator does between merges: after #353 merges, merge `main`
   into #354 and push the reconciling commit (`evals/src/reads.ts` names `memory` as the one
   tool the harness omits); after #354 merges, merge `main` into #355 and resolve the
   README/api.ts append conflict.
2. **Shane: `shipit`** on #354 and #355 (migrations phase48, phase49). Then apply both to
   production and regenerate types if CI's `full` job flags drift.
3. **Attestation debt (Shane):** run `npm run eval:gate` once after wave C is on `main`
   (instructions in the 2026-09-27 chat). It now measures the coach with its read tools.
4. Wave D launches after wave C merges: D01 reflection + contract, D02 notebook, D03 weekly
   review. Add to D01's brief: `leave_note` tool over `/api/coach-annotations`; to the evals
   follow-ups: fixture-backed memory (`fixture.memory`).
5. **Shane:** review the doctrine text on `main`; open #348 follow-up on thinking blocks.

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
- 2026-09-27 · orchestrator · wave C reported (three lanes, ~40 min each); phase48/49 claimed;
  fold green after one reconciling patch (evals mirror vs C02's memory tool); PRs #353 #354
  #355 opened and subscribed.
- 2026-09-27 · orchestrator · review round one on wave C: Codex P1 on #353 and four P2s on #354
  verified and fixed; iOS generated types added to #354/#355 from CI's generator output; the
  two #355 UI findings (no annotations on day/week views, no event-note dismiss) delegated to
  follow-up session C03b. Lesson for briefs: name `src/lib/api.ts`, `README.md` and the iOS
  generated types explicitly; UI lanes must cover every calendar view, mobile forces DayView.
