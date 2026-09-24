# CLAUDE.md template

Fill every `<…>`. Delete a section only when step 0 says it cannot apply (say
so in one line instead where a reader might wonder). Keep it short: this file
is read at the start of every session, so each line costs every session.

````markdown
# <Project name>

<One sentence: what it is and who it is for.>
Stakes: <lifespan> · <who works on it> · <data> · <reach>  — see
[docs/decisions/<date>-project-stakes.md](docs/decisions/<date>-project-stakes.md).

**Start here:** read this file, then [STATUS.md](STATUS.md). Decisions and
their reasons are in [docs/decisions/](docs/decisions/).

## Several sessions may be running right now

More than one Claude session may work in this repo at once, and none can see
another's uncommitted changes. For any subagent, workflow or fan-out, follow
the [parallel-agents skill](.claude/skills/parallel-agents/SKILL.md) (a pinned
copy — never edit it here; see its `VENDORED` file). A `PreToolUse` hook
refuses a writing subagent whose brief has no `Lane:` line.

- **Never work in the primary checkout** (the clone that owns `.git`). It stays
  on `main`, clean. Start every task, including one-liners, with:
  `bash .claude/skills/parallel-agents/scripts/lane.sh new <type>/<slug> "<files you will touch>"`
  It prints other sessions' claims — read them before you start.
- **Look before discarding.** No `reset --hard`, `clean -f`, `checkout -- .`,
  `restore`, `branch -D`, `worktree remove --force`, `push --force` without
  reading what would be lost. Stash only with `-m "<unique tag>"`, apply by
  SHA, never `pop`. <If the Bash guard is wired: "A hook enforces this.">
- **Never copy files between branches or worktrees.** Merge instead.
- **Never kill servers by name.** Kill the PID on your own port.
- After your PR merges: `lane.sh tidy`, then `lane.sh tidy --yes`.

## Shared state

<The parallel-agents inventory table for this project: Resource | Treatment |
Mechanism | Notes. Include at least: primary checkout, working tree + deps,
dev/test port, local DB, migrations, generated files, hot files (STATUS.md,
CLAUDE.md, lockfile, <router>), decision records (date-named — no counter),
merge, host quotas, held paths.>

## Gate

```bash
<npm run check>   # build + typecheck + unit tests + lint — parallel-safe; every lane runs it; CI runs it
```
Not in the gate (orchestrator only): <e.g. `npm run e2e:live` — needs the
locked local DB>. CI does not cover: <e.g. no mobile build, no prod probe>.

## Environments and secrets

Values live in <host>; `.env.example` lists names. New worktrees get
`.env.local` from `.claude/lane-setup.sh` — never copy it between checkouts.
Production settings are human-only. Deploy: <target, or "none yet — see
decision">; after a merge, confirm `<version endpoint>` reports the merged SHA.

## Merging

Squash-merge; `main` requires branches up to date, so after each merge the
next PR needs `git merge origin/main && git push` and a green CI run. Every PR
is based on `main` — never stack. Before opening several PRs at once, prove
they combine (parallel-agents' combine check, with the gate).

Held for <the user> (never merged by an agent): `.github/`, `.claude/settings.json`,
`.claude/skills/`, dependency manifests, <migrations>, <deploy config>.

## When the project grows

Add these when their trigger fires, not before (from the new-dev-project skill):

| Trigger | Add |
|---|---|
| First migration | lock around reset/seed; CI check that new migrations sort after main's |
| A second workstream | STATUS.md grows into a master doc + one brief per workstream |
| First fan-out of ≥3 writing lanes | parallel-agents full path; combine check before PRs |
| First unattended merge | merge policy with held paths + kill switch |
| Fleets of 10+ PRs routine | reconsider up-to-date rule vs fleet mode (decision) |
| A rule broken twice | make it a script or a hook |
````
