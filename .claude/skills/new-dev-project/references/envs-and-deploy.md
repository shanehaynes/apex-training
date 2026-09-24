# Environments, secrets and deploy

## Secrets: the host is the source of truth

The hosting provider's environment settings (Vercel project env, Supabase
project settings) hold the real values. The repo holds only their *names*.

| File | Committed? | Holds |
|---|---|---|
| `.env.example` | yes | every variable the app reads, with a comment on what it is and where its value comes from; no values |
| `.env.local` | no (ignored) | the values, pulled from the host |
| `.claude/lane-setup.sh` | yes | how a fresh worktree gets `.env.local` |

Why this shape, in parallel-agents terms: git-ignored config is not copied
into new worktrees and is deleted with them, so a worktree must be able to
*regenerate* it. A lane that copies `.env.local` from another worktree is
copying files between checkouts — the thing parallel-agents forbids — and the
copy goes stale silently when a secret rotates.

```bash
#!/usr/bin/env bash
# .claude/lane-setup.sh — run by lane.sh in every new worktree.
set -euo pipefail
npm ci --no-audit --no-fund
if command -v vercel >/dev/null && [ -f .vercel/project.json ]; then
  vercel env pull .env.local --environment=development --yes
else
  echo "lane-setup: no linked Vercel project; copy .env.example to .env.local and fill it, or run 'vercel link'" >&2
fi
```

`.vercel/project.json` is itself git-ignored; if the project uses it, the
lane-setup script is where it is recreated (`vercel link --yes --project
<name>`), so lanes never depend on a file from another checkout. Replace the
Vercel lines with the host's equivalent on another stack.

Rules to write into `CLAUDE.md`:
- Secrets never go in commits, PR bodies, logs, or briefs to subagents. A
  brief names the variable; the lane pulls the value.
- Production env settings are human-owned. A lane that needs a new variable
  adds it to `.env.example` and reports that the value must be set on the host.
- Rotating a secret = change it on the host, then re-run `lane-setup.sh` in
  each live lane.

## Environments

| Environment | Where | Who changes it |
|---|---|---|
| Local | each worktree, own port, shared local DB (locked) | the lane |
| Preview | one deploy per PR (Vercel does this by default) | CI/host, automatically |
| Production | `main` deploys | only by merging to `main`; host settings human-only |

Preview deploys count against the host's quotas (deploys/day, build minutes).
On a hobby plan a large fleet can hit the cap mid-merge — put it in the
inventory as a capacity row.

## Deploy: decide on day 0, even if the answer is "none"

Choose the target in step 0 and record it. If the project deploys at all, build
this on day 0, because it is the thing every later merge needs and nobody adds
under pressure:

- **A version endpoint** that returns the commit SHA it was built from (on
  Vercel, `VERCEL_GIT_COMMIT_SHA` at build time), e.g. `GET /api/version →
  {"sha":"…"}` or a static `version.json`.
- **A post-deploy check** in `CLAUDE.md`: after a merge, poll the version
  endpoint until it reports the merged SHA, then hit one real route. "The host
  probably deployed it" is not a check — a routing change once 404'd every API
  route in the source project, and only a post-deploy probe could see it.

If the answer is "none yet", write that as the decision, with the trigger that
would change it ("when the first friend needs to try it").
