# Agent autonomy: fewer holds where CI or a classifier can prove safety — spec

**Owns:** `.claude/settings.json` (`permissions` only), `scripts/merge-policy.mjs`,
`scripts/merge-policy.d.mts`, `scripts/__tests__/merge-policy.test.ts`, new
`scripts/migration-classify.mjs` and `scripts/migration-apply.mjs` with their tests,
the `policy_check` and `schema_preflight` functions of `scripts/merge-babysit.sh`,
and the "Autonomous merging" sections of CLAUDE.md and CONTRIBUTING.md.
**Forbidden:** `.github/`, `scripts/ci-guards.sh`, the guard hooks, the iOS release
surface, `evals/baseline/`, and any removal from `HELD` — exceptions are carved out
by content checks inside `decide`, never by shrinking the list.
**Depends on:** M3 touches `merge-babysit.sh`, which #507 and #510 also change; M3's
PR opens after both merge.
**Status:** in progress (M1: `chore/agent-autonomy-m1`)

## Goal
Last month 22 of 100 merged PRs touched a held path and 21 of them were merged by
hand outside the babysitter. The held list mixes two kinds of rule: **authority**
(the agent must never merge an expansion of what the agent may do — the
automation's own files, `.github/`, the guard hooks) and **provability** (CI cannot
show a dependency or a migration is safe). Authority rules stay absolute. This spec
replaces three provability holds with mechanical checks: the merge loop runs
without a prompt (M1), dependency bumps of packages already present merge alone
(M2), and migrations that only add — proven by a fail-closed classifier — are
applied to production by the babysitter and then merged (M3).

The revert story, which is the condition Shane set: code reverts with `git revert`;
an additive migration does not revert with git, so M3 prints and records the
inverse SQL (drop what it created) for every migration it applies. A destructive
migration has no mechanical inverse and therefore stays held.

## Scope
In:
- M1: two exact-string allow rules for the babysitter.
- M2: a package.json content check inside `decide`.
- M3: a SQL classifier, a Management-API applier, the babysitter wiring.
Out:
- The iOS release surface, `.github/`, the automation's own files: no change.
- Any route for the agent to apply `shipit`, approve, or call `gh pr merge`.
- Destructive or rewriting DDL, data updates, functions, triggers, views,
  extensions — held as today.

## Milestones

### M1 — the merge loop runs without a prompt
- [ ] `.claude/settings.json` allows exactly `Bash(scripts/merge-babysit.sh --yes)`
  and `Bash(scripts/merge-babysit.sh --fleet --yes)`; no wildcard, so
  `--no-check` and every other flag still prompt.
- [ ] CLAUDE.md and CONTRIBUTING.md say what is allow-listed and why the rule is exact.

### M2 — dependency bumps of packages already present merge alone
`decide` gets the PR's `package.json` before and after (the babysitter reads both
with `git show` at the merge base and the head; unreadable → hold).
- [ ] A PR whose `package.json` change only changes the version of names already in
  `dependencies`/`devDependencies`/`optionalDependencies`/`peerDependencies` is not
  held for the manifest; `package-lock.json` alongside it is not held either.
- [ ] A lockfile-only change (no `package.json` diff) is not held.
- [ ] Held, each with its own reason: a new direct dependency name; a name moved
  from `devDependencies` to `dependencies`; any change to `scripts`, `overrides`,
  `resolutions`, `workspaces`, `engines`, `bin`, `type`, `main`/`exports`, or any
  other top-level key; a version spec that is not a registry semver range
  (`git+`, `file:`, `http(s):`, `npm:` alias, `link:`, `workspace:`).
- [ ] Missing before/after content holds (fail closed); the existing HELD entries
  and their tests stay, and the `agent:check`/`npm audit` floor is unchanged.
- [ ] The merge-policy header comment states the new rule and why new names are the
  line (a name is a new publisher; a bump is a publisher already trusted).

### M3 — additive migrations are applied by the babysitter, then merged
`scripts/migration-classify.mjs` (pure) takes one migration's SQL and returns
`{ additive: true, inverse: "<sql>" }` or `{ additive: false, reasons: [...] }`.
It reuses `statements()` from `prod-schema-check.mjs`. Allowed statements:
- `create table [if not exists] <name> (…)` in public — not `as`, not `like`,
  not `temp`/`unlogged`, not `partition of`; every such table must also get
  `alter table <it> enable row level security` in the same file;
- `alter table <t> add column [if not exists] …` (several per statement allowed),
  and `alter table <t> enable row level security`;
- `create [unique] index [if not exists] … on <t> …` — not `concurrently`
  (it cannot run inside the single transaction the apply uses);
- `comment on …`;
- `create policy … on <t>`, `grant … on [table] <t> to authenticated|service_role`
  — only where `<t>` is created in the same file. A policy or grant on an existing
  table widens access to data that already exists, additive or not;
- `revoke …` (only narrows);
- `notify pgrst, 'reload schema'`;
- the ledger stamp, as the last statement, matching `stampFor(file, sql)`.
Everything else — `do`, `create function`, `create view`, triggers, `update`,
`insert` (other than the stamp), `drop`, `alter column`, `rename`, `alter policy`,
`create extension`, `begin`/`commit` — is non-additive.
- [ ] Every migration on `main` classifies without throwing; a test pins the
  additive/non-additive verdict for each existing file (a snapshot of 59 verdicts).
- [ ] Adversarial tests: a policy on an existing table, `grant … to anon`, a table
  without RLS, a `create table … as select`, a function hidden in a `do` block, a
  second statement after the stamp, an edited stamp, `concurrently` — each held,
  with a reason naming the statement.
- [ ] `decide` does not hold `supabase/migrations/*` paths when every one is an
  added file (not modified or deleted) that classifies additive; the sources reach
  it the same way M2's package.json does.
- [ ] `scripts/migration-apply.mjs <ref> <file>…` applies each file, in `sort -V`
  order, through `POST https://api.supabase.com/v1/projects/<ref>/database/query`,
  one file per request wrapped in `begin; … commit;`, using
  `SUPABASE_ACCESS_TOKEN` from `~/.config/apex-training/prod.env`. Without the
  token it exits 3 and changes nothing; the babysitter then holds as today
  ("apply by hand"). The token's absence is the opt-out.
- [ ] In `schema_preflight`, with `--yes` only: when production passes against
  `main`, fails against the PR's head only on the PR's own migrations, and the
  policy passed the PR, the babysitter runs the applier, re-runs the head check,
  and merges only on exit 0. It posts the applied files and their inverse SQL as a
  PR comment before merging and appends one line per file to the merge log.
- [ ] A dry run never applies; `AUTOMERGE_OFF` stops before any apply.

## Gate
`npm run agent:check` on every commit. Plus, for M3, one real apply that nobody but
Shane can authorize: a throwaway additive migration (a comment-only table) applied
by the babysitter against production, its inverse run by hand, and
`prod-schema-check.mjs` exit 0 before and after. Shane creates the access token.

## Done means
Every box above checked, every PR merged (each is HELD by design and needs
`shipit`), `scripts/git-tidy.sh --yes` run, and the Next brief filled in.

## Decisions
- 2026-10-28 · Allow rules are exact strings: a prefix rule would also grant `--no-check`.
- 2026-10-28 · New dependency names stay held, bumps do not. A version bump can still
  ship a compromised release; that risk already exists today, since 21 of the 22 held
  PRs were merged without a line-by-line review. The line is drawn where a human adds
  information: choosing a new publisher.
- 2026-10-28 · Policies and grants count as additive only on tables the same migration
  creates. On an existing table, `using (true)` is purely additive and exposes everything.
- 2026-10-28 · DDL goes through the Management API, not a new `pg` dependency (itself
  a held change) and not `supabase db push`, whose history table production does not keep.
- 2026-10-28 · The applier runs in the babysitter on Shane's Mac, not in CI: the
  production access token stays off GitHub, and the order stays DDL first, merge second.

## Session log
- 2026-10-28 · spec written; M1 on `chore/agent-autonomy-m1`.

## Next brief
**M2 — dependency bumps merge alone.** Implement M2's boxes above in a lane cut with
`scripts/git-new.sh chore/agent-autonomy-m2 "merge-policy.mjs decide: package.json
content check; merge-babysit.sh policy_check passes manifests"`. `decide(paths,
labels, changed, sources)` gets a fourth argument `{ 'package.json': { before, after } }`;
`policy_check` in the babysitter fills it with `git show <merge-base>:package.json` and
`git show <head>:package.json` after fetching `refs/pull/N/head`, and passes
`null` for a side that is missing (a new file is a new manifest: held). Keep every
HELD entry; add the exception inside `decide`, each held reason distinct and tested.
Acceptance is the M2 list; the PR is HELD (it changes the policy) and needs `shipit`.
