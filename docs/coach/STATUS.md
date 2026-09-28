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
| C01 | Evals: harness realignment, `sight` and `doctrine` cases, doctrine dimension | C | done (#353, `3de0233`; reconciling commit for C02's memory tool landed with #355) | `feat/coach-evals-sight` | |
| C02 | Memory: `coach_memory` migration, memory tool backend, proposal cards | C | done (#354, `cd3961a`) — phase48 to apply in production | `feat/coach-memory` | `PROMPT_VERSION` → 2026.09.27-1 |
| C03 | Calendar annotations: table, handler, chips, block strip, day/week views | C | done (#355, `a172cf7`) — phase49 to apply in production | `feat/coach-annotations` | C03b follow-up session folded in |
| D01 | Reflection + coaching contract + `leave_note` (nightly, proposal-gated) | D | in review (#358, head `8c46c55`) — **HELD** (phase50 + `vercel.json` cron); CI green but `coach-gate` (by design); four Codex findings fixed; merges first | `feat/coach-reflection` | HELD (phase50 + `vercel.json` cron); `PROMPT_VERSION` → 2026.09.28-1; merges first |
| D02 | Notebook page: memory, proposals, contract, doctrine | D | in review (#359, head `0a99907`) — CI green but `coach-gate` (by design); two Codex findings fixed; merges second | `feat/coach-notebook` | codes against D01's interface contract; merges second |
| D03 | Weekly review document + "next week" proposals | D | in review (#360, head `768f003`) — CI fully green; three Codex findings fixed; merges third | `feat/coach-weekly-review` | no table, no cron; merges third |
| E01 | Block planner mode | E | ready (after D) | `feat/coach-block-planner` | alone in its wave: owns every hot file |
| E02 | Ask-coach from a session or set | E | ready (after D) | `feat/coach-ask-from-context` | |

## Next up
1. **Wave C is on `main`** (#353, #354, #355). **Shane:** apply phase48 (`coach_memory`) and
   phase49 (`coach_annotations`) to production; run `npm run eval:gate` (the attestation has
   been stale since #345 — it now measures the coach with its read tools and memory); review
   the doctrine text.
2. **Wave D in review**: #358 (D01, HELD: phase50 + one `vercel.json` cron line) → #359 (D02)
   → #360 (D03), in that merge order. The fold of all three on `main` is green (build, vitest
   2185, oxlint, guards); every pair merges clean, so no integration commit is needed between
   merges beyond the usual `git merge origin/main`. **Shane: `shipit`** on #358, then apply
   phase50 to production (after phase48/49).
3. Evals follow-up (after D01): fixture-backed memory in the harness (`fixture.memory`), and
   the two new write tools in the mirror (D01 does the mirror itself).
4. **Shane:** #348 follow-up on thinking blocks across the write path.

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
- 2026-09-27 · Shane · merged #354 (`cd3961a`) then #353 (`3de0233`), the reverse of the planned
  order, so the reconciling commit for the evals mirror was on neither and `main`'s `check`
  job went red on `reads.test.ts`; it rides #355 instead. Both squash commits carry a
  `Co-authored-by: Claude` trailer from the lane commits' author identity.
- 2026-09-27 · orchestrator · C03b pushed `d2bb011` (day-view note chips with dismiss, week-view
  markers, tests, e2e) after merging `main` into `feat/coach-annotations`; reconciling commit
  added on top; #355 is the last wave-C PR.
- 2026-09-28 · Shane · merged #355 (`a172cf7`); wave C complete.
- 2026-09-28 · orchestrator · wave D briefs written from a read-only survey of `main` (anchors
  named per file so D02 and D03 append without touching each other; D01 alone owns the hot
  files); launched as three cloud sessions from `a172cf7`: D01 `session_01G2umkcnqAanzaePcuSW7jN`,
  D02 `session_01N4CgbU771b7Sek4ym8otgP`, D03 `session_017TRimd2HhRgoBbfxCDxTAK` (the session
  tooling's safety classifier refused the first attempts for about half an hour).
- 2026-09-28 · orchestrator · wave D reported (three lanes, ~40 min each, all committed as
  Shane); phase50 claimed; fold green with no reconciling patch; PRs #358 #359 #360 opened
  and subscribed. D01 chose `messages.create` per athlete over the Batch API (recorded in
  the PR); D03 stores nothing server-side in v1.
- 2026-09-28 · orchestrator · review round one on wave D: nine Codex findings (two P1 on the
  cron's backlog and on past-dated review proposals, one P1 on occurrence updates, six P2s)
  verified and delegated back to the lane sessions, which fixed them within the hour
  (`8c46c55`, `0a99907`, `768f003`); CI's `full` on #358 caught two things the brief should
  have named — the generator's alphabetical table order and the iOS `profile.json` fixture —
  both fixed by the orchestrator. Fold of the three fixed heads green (vitest 2203). Threads
  resolved. Waiting on Shane's `shipit` for #358.
