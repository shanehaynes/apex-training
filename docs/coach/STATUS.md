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
| A05 | Cache prefix: stable/volatile prompt split, server-side injection, 1h TTL | A | in review (#345) — two local-stack specs fixed (`c6eb313`, `d0fb664`), CI re-running; **coach-gate needs Shane's `eval:gate`** | `feat/coach-cache-prefix` | bumps `PROMPT_VERSION` → 2026.09.25-1; Opus 5.5 `midTurnSystem` off until verified |
| B01 | Sight loop: read tools + doctrine + physiology wired into chat; server-side read rounds; chips | B | ready (after wave A) | `feat/coach-sight-loop` | owns every hot file |
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
1. #341–#344 are on `main` (17:22 UTC). #345 is the last wave-A PR; `main` merged into it (`02625bc`) so it is current.
2. **Shane:** run `npm run eval:gate` on `feat/coach-cache-prefix` (#345) and commit the
   attestation; no orchestrator session holds the subscription token. Then #345 merges last
   (it is the only wave-A PR on the hot files).
3. **Shane:** review #343's doctrine text for fidelity; the lane's DECISIONS list names the
   lines where it chose one school over another.
4. Orchestrator: once wave A is on `main`, one live call to confirm whether
   `claude-opus-5-5` accepts a mid-conversation `system` message; flip `midTurnSystem` in
   the B01 lane if it does. Then launch B01 from fresh `main`.

## Recent sessions
- 2026-09-25 · orchestrator · plan approved, issue #340 opened, board created, wave A launched
  as five cloud sessions.
- 2026-09-25 · Shane · merged #341–#344 (and #346, Resend email); main at `6520b00`.
- 2026-09-25 · orchestrator · all five lanes reported; fold green on tsc/vitest/lint/guards
  (local mock e2e blocked by a Playwright browser mismatch, CI covers it); PRs #341–#345
  opened; two `full`-job failures (integration tests no lane can run) fixed and pushed.
  Lesson for the briefs: name the integration suite under NOT VERIFIED explicitly.
