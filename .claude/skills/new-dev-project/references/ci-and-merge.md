# CI and merge settings

## The CI workflow

One workflow, one required job, running the same gate command lanes run.
Adapt the setup steps to the stack; keep the shape.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
  workflow_dispatch:
permissions:
  contents: read            # nothing here needs write access
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
jobs:
  check:                    # ← the required status check; do not rename casually
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm run check  # the same command every lane runs
```

Use the latest major versions of the actions when you write the file; the ones
above are placeholders.

**Guarding the vendored parallel-agents in CI.** CI has no installed skills,
so it cannot compare against the source — but it can catch the failure that
matters, a hand-edit of the vendored copy. A legitimate change to that
directory always comes from re-vendoring, which rewrites `VENDORED`; an edit
that touches the directory without touching the stamp is a hand-edit. Add this
step to the `check` job (plain git, nothing to copy into the repo):

```yaml
      - name: Vendored parallel-agents is only changed by re-vendoring
        if: github.event_name == 'pull_request'
        run: |
          git fetch --no-tags --depth=1 origin "$GITHUB_BASE_REF"
          changed=$(git diff --name-only FETCH_HEAD HEAD -- .claude/skills/parallel-agents/)
          if [ -n "$changed" ] && ! printf '%s\n' "$changed" | grep -qx '.claude/skills/parallel-agents/VENDORED'; then
            echo "::error::.claude/skills/parallel-agents/ was edited by hand. Change the skill at its source and re-vendor."
            printf '%s\n' "$changed"; exit 1
          fi
```

(`actions/checkout` needs `fetch-depth: 0` or the explicit fetch above for the
diff to have a base.)

Add a job only for something the gate cannot prove (a second platform, e2e
needing services, a nightly from-scratch run). Every job not required is a
job whose failure can be merged past — say which in `CLAUDE.md`.

## Merge settings — the checklist for the user

These live in GitHub's repository settings. Apply them with the tools you
have (`gh api` with the user's go-ahead, when `gh` is authenticated); if you
cannot, give the user this list verbatim and put "merge settings pending" in
`STATUS.md`.

**Settings → General → Pull Requests**
- [ ] Allow squash merging — **on**; merge commits and rebase merging — **off**
- [ ] Default squash message: pull request title and description
- [ ] Always suggest updating pull request branches — **on**
- [ ] Automatically delete head branches — **on**

**Settings → Rules → Rulesets → New branch ruleset** (target: `main`)
- [ ] Restrict deletions; block force pushes
- [ ] Require a pull request before merging (0 approvals is fine for a solo repo; the PR is the gate, not the review)
- [ ] Require status checks to pass: `check`; **require branches to be up to date before merging — on**
- [ ] Bypass list: empty (the user can still merge; nothing skips CI)

## Why these defaults, and when to change them

- **Squash-only**: one commit per PR on `main`, so every main commit passed
  the gate as a unit and reverts are one commit. Cost: merged branches are
  never ancestors of `main`, so "merged?" must be detected by content —
  parallel-agents' `lane.sh tidy` already does.
- **Up to date required** ("strict"): every merge is proven against the
  current `main`. Cost: N PRs merge as N serial rounds of update → CI → merge.
  At a solo developer's PR volume that is minutes; parallel-agents'
  integration reference explains the cost at fleet scale.
- **Auto-delete head branches**: keeps the remote clean and gives `lane.sh
  tidy` its "upstream gone" evidence.
- **Merge queue**: not available to personal-account repositories. If the repo
  moves to an organization, a queue replaces the serial loop — and the
  workflow then needs a `merge_group` trigger or queued PRs wait forever.

**Revisit when fleets of 10+ PRs become routine**: turn the up-to-date rule
off only if the fold check (parallel-agents' combine check with the gate) runs
before every batch merge — that check is what replaces the guarantee. Record
the change as a decision.
