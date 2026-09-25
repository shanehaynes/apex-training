# Common brief sections (pasted verbatim into every wave-A lane prompt)

## Your environment
- You are a fresh Claude Code cloud session with a clone of `shanehaynes/apex-training` at
  `main`. Read `CLAUDE.md` and `CONTRIBUTING.md` first; they are short and their hooks are
  mechanical.
- The clone you start in counts as the **primary checkout** (it owns `.git`), and a guard hook
  blocks building and committing there. So your first command is, from the clone root:
  `scripts/git-new.sh <branch> "<the files you own>"` — it creates
  `.claude/worktrees/<branch-with-dashes>/`, checks out your branch from `origin/main`, and
  runs `npm ci` there. Then **every** command runs in that worktree:
  `cd <abs worktree path> && …` or `git -C <abs worktree path> …`.
- Lane: the absolute path `git-new.sh` prints. Put that path in your report.
- Dev port, if you ever start the app: `npm run -s port` in the worktree. Kill only the PID on
  that port; never `pkill -f vite`.

## Repo facts that bite
- Files reachable from `api/**` at runtime use `.js` on every relative import specifier (Node
  ESM); `api/__tests__/esm-imports.test.ts` walks the graph and fails on a bare one. `api/chat.ts`
  may only import `api/_lib` and dependency-free `src/lib/coach` modules — nothing that pulls in
  React or supabase-js.
- `src/styles/app.css` is off limits. New CSS goes in a new per-feature file (see how
  `src/components/onboarding/tips.css` is imported) or inline like `ChatSidebar.tsx` already does.
- Generated types live in `src/lib/db/database.types.ts`; hand-written row types in
  `src/lib/db/types.ts`. Do not edit the generated file.
- Commits land as Shane alone: no co-author trailers, no attribution lines (settings enforce
  it). Messages say what and why.
- No Anthropic key exists in your session. Do not attempt live model calls; the orchestrator
  runs the evals.

## Shared state — never
- Never open a PR, merge, or push to any branch but your own.
- Never touch `supabase/migrations/`, `package.json`, `package-lock.json`, `vercel.json`,
  `.github/`, `evals/baseline/`, `scripts/`, `.claude/settings.json`.
- Never run `npm run db:reset-local`, `npm run e2e:live`, or anything that resets the local
  stack.
- Never `git reset --hard`, `git clean -f`, bare `git stash`, `git push --force`.
- Never edit files another lane owns (listed under Ownership). If you need a change there,
  describe it under OUTSIDE MY OWNERSHIP in your report and stop short of making it.

## Gate
Before you report done, in your worktree: `npm run agent:check` (tsc -b, vitest, oxlint, the
mock Playwright e2e, and the CI guards). Chromium is pre-installed; do not run
`playwright install`. If the e2e step fails for an environment reason unrelated to your change,
run the rest (`npm run build && npm test && npm run lint && npm run ci:guards`) and say so under
NOT VERIFIED.

## Done means
1. Changes committed on your branch, in the worktree.
2. Pushed: `git -C <worktree> push -u origin <branch>` (retry on network errors with backoff).
3. `git -C <worktree> status` is clean.
4. Your final message is the report below and nothing else.

## Report (final message)
```
STATUS: done | partial | blocked
LANE: <abs worktree path>
BRANCH: <branch>   SHA: <full sha of pushed head>   PUSHED: yes | no
CHANGED: <files, grouped; one line each with the why if not obvious>
GATE:
- npm run agent:check → pass | fail (<one-line reason>)
NOT VERIFIED: <what the gate does not cover that this change could break>
OUTSIDE MY OWNERSHIP: <changes needed in files you do not own, with a precise description>
DECISIONS: <judgment calls made, alternatives rejected>
FOLLOW-UPS: <second problems noticed and deliberately not fixed here>
BLOCKER: <only if blocked: exact command, exact error, what you need>
```

## If you are blocked
Stop and report. A permission refusal, a hook block, a failing check you cannot fix within your
ownership, or an ambiguity that changes the design — each is information for the
orchestrator. Do not route around it and do not widen your scope to get green.
