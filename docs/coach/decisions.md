# AI coach — decisions

Append-only. One entry per decision, with the options that were on the table. D-C numbers
keep this log apart from the iOS (`D-`) and onboarding (`D-O`) logs.

## D-C01 · The method lives in the prompt prefix as an original synthesis; retrieval is for the athlete's history
**Status:** decided · Shane · 2026-09-25
- **Options.** (a) RAG over the training books (chunk, embed, retrieve by similarity).
  (b) An original synthesis of the House/Johnston/Yaniro method, ~10–20k tokens, cached as a
  stable prefix, with a `read_doctrine` tool and citations on document blocks.
- **Decision.** (b). The method is compact and structural; chunk retrieval loses the structure
  that makes it a method, and the books cannot ship in the repo. Retrieval is reserved for the
  athlete's own history (sessions, summaries, threads, reviews), where the corpus is large and
  temporal — agentic queries over SQL and full-text search first.

## D-C02 · Self-improvement is proposal-gated; the base prompt stays fixed
**Status:** decided · Shane · 2026-09-25 (gate strictness: approve everything)
- **Options.** (a) Let the coach revise its own system prompt and documents as it learns.
  (b) Fixed, evaluated base prompt + a bounded per-user coaching contract + a memory store;
  the coach proposes edits, the athlete approves each one in a visible surface.
  (c) (b) with low-risk kinds auto-accepted.
- **Decision.** (b), every proposal approved. Unbounded self-revision drifts and breaks the
  eval gate that hashes `prompt.ts`; the confirm-card posture already used for mutations is the
  right shape for memory and contract edits too.

## D-C03 · Embeddings deferred to a measured retrieval miss
**Status:** decided · Shane · 2026-09-25 · tracked in issue #340
- **Options.** (a) pgvector + an embedding provider now. (b) Postgres FTS via PostgREST `fts`
  now; vectors when a logged question that FTS failed to answer shows up.
- **Decision.** (b). Anthropic has no embedding endpoint, so (a) means a new provider, a new
  key, a held `package.json` PR and a chunking pipeline, for a benefit unproven at this data
  size.

## D-C04 · Lanes run as separate cloud sessions
**Status:** decided · Shane · 2026-09-25
- **Options.** (a) In-container subagents with `scripts/git-new.sh` worktrees. (b) One Claude
  Code cloud session per lane, own container, own branch; the orchestrator session integrates.
  (c) Briefs only; Shane launches sessions by hand.
- **Decision.** (b). No shared disk, stash, port or local stack between lanes. A cloud clone
  still counts as the primary checkout for the guard hook, so every lane starts with
  `git-new.sh` and works in the worktree. File ownership in the brief is the claim, since
  `.claude/state/claims.tsv` does not exist across containers.

## D-C05 · Doctrine ships as `.ts` string exports
**Status:** decided · orchestrator · 2026-09-25
- **Options.** (a) `.md` files read with `fs` at runtime. (b) `.ts` modules exporting the
  text. (c) A build step compiling `.md` → `.ts`.
- **Decision.** (b). Vercel traces imports, not arbitrary files; including `.md` means an
  `includeFiles` entry in the HELD `vercel.json`. (c) is a later nicety if editing in `.ts`
  proves annoying.

## D-C06 · Volatile prompt state is injected server-side per request, never persisted
**Status:** decided · orchestrator · 2026-09-25
- **Options.** (a) Keep live schedule/meals in `system` (cache miss on every mutation).
  (b) Split the prompt: stable half in `system` with a 1h TTL breakpoint; volatile half sent
  as a mid-conversation `system` message where the model supports it, else as a leading text
  block inside the last user message — built on the server and never stored in
  `coach_messages`.
- **Decision.** (b). The fallback path alone realizes the cache win; the mid-turn system
  message is a nicety gated per model (`midTurnSystem` in `models.ts`, false for
  `claude-opus-5-5` until verified live).
