# AI coach — master document

**Start here.** This is the master document for the coach upgrade: giving the in-app coach
sight (the athlete's history and physiology), a training doctrine it can cite, a memory it
proposes and the athlete approves, and surfaces beyond the chat window. It holds the big
picture; the board and the briefs hold the detail. A Claude session picking up coach work
follows the [session protocol](#session-protocol) before anything else.

| Document | What it holds |
|---|---|
| [STATUS.md](STATUS.md) | Living board: lane states, branches, next up, recent sessions |
| [decisions.md](decisions.md) | Every decision with the options considered (D-C numbers) |
| [workstreams/](workstreams/) | One self-contained brief per lane (A01–A05 so far) |
| [../../evals/README.md](../../evals/README.md) | How coach quality is measured; every lane here keeps it green |

## Where the coach stands today

Per turn the coach sees this week's schedule, today's meals, a 4-week completion rate, the
active block's attainment numbers and two free-text profile fields (`coach_goal`,
`coach_context`). It has eight write-only tools, each behind a one-line confirm card, and one
tool round per user message. It cannot read set logs, PRs, HR zones, training load, HRV, the
post-workout summaries it wrote (`workout_sessions.coach_summary`) or past threads. It holds
no training methodology. Messages render as plain text.

The read-only MCP server (`api/_lib/mcp/tools/*`) already exposes most of the history to
outside clients; the in-app coach cannot call it. That asymmetry is the first thing this
initiative removes.

## Vision

A coach, not a chatbot: it reads what the athlete did before it speaks, reasons from a
stated method, remembers what it has learned about this athlete, shows its work, and asks
before it changes anything. Numbers come from code; judgment comes from the model; proposals
are confirmed by the athlete.

## Principles

1. **Sight before knowledge.** Read tools and the physiology panel land before any doctrine.
   A coach that cannot see the athlete's Z2 volume cannot apply a method to it.
2. **Doctrine in the prefix, retrieval for the athlete.** The House/Johnston/Yaniro method is
   compact and structural; it lives in the cached system prefix as an original synthesis with
   citations. Retrieval (agentic queries over SQL and full-text search) is for the athlete's
   own growing history. No book text ships in the repo. (D-C01)
3. **Self-improvement is a reviewed diff.** Fixed, evaluated base prompt + a bounded per-user
   coaching contract + a memory store. The coach proposes; the athlete approves. Nothing
   rewrites the prompt silently. (D-C02)
4. **Numbers from code, judgment from the model.** Every figure in a prompt block is
   pre-computed by a pure function the app also uses; the model cites and never recomputes.
5. **The eval gate is the contract.** Every behaviour-visible change bumps `PROMPT_VERSION`
   and ships with a fresh attestation; new capabilities get new eval dimensions.
6. **The repo's rules apply unchanged**: worktree per lane, HELD paths, `agent:check`, phase
   numbers claimed at PR time ([CLAUDE.md](../../CLAUDE.md)). The parallel-agents skill is the
   fleet protocol; file ownership in the brief is the claim.

## Architecture in layers

| Layer | What | Wave |
|---|---|---|
| 0 Sight | Read tools (the MCP set + session summaries, reviews, history search) executed in a bounded server-side loop; physiology panel (zones, load, tonnage, HRV); stable/volatile prompt split so the prefix caches | A, B |
| 1 Doctrine | `src/lib/coach/doctrine/*` as `.ts` string exports; index in the prefix, `read_doctrine` tool, citations on document blocks; a `doctrine` eval dimension | A, C |
| 2 Memory | `coach_memory` table behind the Anthropic memory tool; writes are confirm cards; confirmed rows render as `<athlete_memory>`; `search_history` over FTS | C |
| 3 Reflection | `profiles.coach_contract` (bounded, proposal-gated); nightly Batch-API reflection writing unconfirmed proposals | D |
| 4 Surfaces | Rich confirm cards; calendar margin notes; the notebook; weekly review as a document; block planner mode; ask-coach from context | A, C, D, E |

## Decisions in one glance

| Topic | Decision | Ref |
|---|---|---|
| Methodology | Original synthesis in the cached prefix with citations, not chunk retrieval | D-C01 |
| Self-improvement | Base prompt fixed; contract + memory proposal-gated, approve everything | D-C02 |
| Embeddings | Deferred to a measured retrieval miss; issue #340 | D-C03 |
| Lane runtime | One cloud session per lane, integrated from the orchestrator session | D-C04 |
| Doctrine format | `.ts` string exports (Vercel traces imports, not `.md`) | D-C05 |
| Cache prefix | Volatile state injected server-side per request, never persisted in the thread | D-C06 |

## Session protocol

1. Read this file, then [STATUS.md](STATUS.md). Take the lane the board names, or the brief
   you were handed; do not widen it.
2. Start with `scripts/git-new.sh <branch> "<files you own>"` and work only in that worktree.
   The guard hook blocks commits in the primary checkout, including a fresh cloud clone.
3. Own exactly the files your brief names. A change needed elsewhere goes in the report under
   OUTSIDE MY OWNERSHIP, never in your diff.
4. Gate with `npm run agent:check`. No lane makes a live Anthropic call; the orchestrator runs
   the evals and refreshes the attestation.
5. Commit, push your branch, leave the tree clean, and end with the report schema in your
   brief. The orchestrator opens the PR.
6. Update [STATUS.md](STATUS.md) only if you are the orchestrator; lanes report, they do not
   edit the board.
