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
| B01 | Sight loop: read tools + doctrine + physiology wired into chat; server-side read rounds; chips | B | in review (#348, head `e69faa5`) — local gate green; **coach-gate red until Shane's `eval:gate`**; `full` job watched | `feat/coach-sight-loop` | `PROMPT_VERSION` → 2026.09.26-1; `rounds` logged, not stored |
| B02 | Board + embeddings issue | B | done (this branch, issue #340) | `chore/coach-board` | orchestrator |
| C01 | Evals: harness realignment, `sight` and `doctrine` cases, doctrine dimension | C | ready (after B01) | `feat/coach-evals-sight` | `eval-analyst` |
| C02 | Memory: `coach_memory` migration, memory tool backend, proposal cards | C | ready (after B01) | `feat/coach-memory` | HELD (migration) |
| C03 | Calendar annotations: table, handler, chips, block strip | C | ready (after B01) | `feat/coach-annotations` | HELD (migration) |
| D01 | Reflection + coaching contract (nightly Batch API, proposal-gated) | D | ready (after C) | `feat/coach-reflection` | HELD (migration) |
| D02 | Notebook page: memory, proposals, contract history, doctrine index | D | ready (after C) | `feat/coach-notebook` | |
| D03 | Weekly review document + "next week" proposal batch | D | ready (after C) | `feat/coach-weekly-review` | |
| E01 | Block planner mode | E | ready (after D) | `feat/coach-block-planner` | alone in its wave: owns every hot file |
| E02 | Ask-coach from a session or set | E | ready (after D) | `feat/coach-ask-from-context` | |

## Next up
1. **Wave A is on `main`** (#341–#345, main at `43a6794`). **B01 is #348**, reviewed by the
   orchestrator against the brief (all 18 files inside its ownership); the orchestrator
   drives its CI. Shane merges once `full` and `e2e-mock` are green and the attestation is
   refreshed (or merges past `coach-gate` again and runs the gate on `main`).
2. **Attestation debt (Shane):** #345 merged without `eval:gate`, so
   `evals/gate/attestation.json` still pins `2026.09.22-1` against prompt `2026.09.25-1`
   and `coach-gate` is red on every coach-path PR. B01 bumps the version once more, so a
   single `npm run eval:gate` after B01 lands covers both — run it on `main` (or on the
   B01 branch before merge) and commit the attestation. No orchestrator session holds the
   subscription token.
3. **Shane:** review the doctrine text on `main` (`src/lib/coach/doctrine/`); the A03
   DECISIONS list names the lines where it chose one school over another.
4. Optional, needs a key: one live call to confirm whether `claude-opus-5-5` accepts a
   mid-conversation `system` message; if yes, flip `midTurnSystem` in `models.ts`.
5. After B01 merges: launch wave C (C01 evals via `eval-analyst`, C02 memory, C03
   annotations) from fresh `main`; claim two consecutive migration numbers at PR open.

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
