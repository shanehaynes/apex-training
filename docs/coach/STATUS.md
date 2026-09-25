# AI coach — status board

Living document. **The orchestrator updates this file after every lane report and every
merge.** Lanes do not edit it; they report. Detail belongs in the lane's brief.

States: `ready` · `in progress (session)` · `pushed (sha)` · `in review (PR #)` · `done (PR #)` · `blocked on …`

| Lane | Title | Wave | State | Branch | Notes |
|---|---|---|---|---|---|
| A01 | Read tools: coach adapter over the MCP set + session summaries, reviews, history search | A | in progress (cloud session) | `feat/coach-read-tools` | no hot files |
| A02 | Physiology panel: zones, load ratio, tonnage, HRV as pure functions + fetch | A | in progress (cloud session) | `feat/coach-physiology` | no hot files |
| A03 | Doctrine: original synthesis as `.ts` topics, index, tool schema | A | in progress (cloud session) | `feat/coach-doctrine` | Shane reviews content before merge |
| A04 | Rich confirm cards: before/after preview per tool call | A | in progress (cloud session) | `feat/coach-confirm-preview` | owns `ChatSidebar.tsx` this wave |
| A05 | Cache prefix: stable/volatile prompt split, server-side injection, 1h TTL | A | in progress (cloud session) | `feat/coach-cache-prefix` | owns `prompt.ts`, `models.ts`, `context.ts`, `chat.ts`; bumps `PROMPT_VERSION` |
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
1. Orchestrator: collect A01–A05 reports, `scripts/combine-check.sh --check "npm run agent:check"`
   on the five branches, run the eval subset + `eval:gate` for A05, open PRs in order
   A01 → A05.
2. Orchestrator: one live call to confirm whether `claude-opus-5-5` accepts a mid-conversation
   `system` message; flip `midTurnSystem` in `models.ts` in the B01 lane if it does.
3. Shane: review A03's doctrine text for fidelity to the method before it merges.

## Recent sessions
- 2026-09-25 · orchestrator · plan approved, issue #340 opened, board created, wave A launched
  as five cloud sessions.
