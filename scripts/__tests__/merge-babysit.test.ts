import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprint, migrationsAt, parseDatabaseTypes, stampFor } from '../prod-schema-check.mjs';

// The babysitter end to end, in a dry run: a throwaway clone with its own bare
// origin, a gh stub that answers from a fixture through the script's own --jq
// expressions, and a scripted PostgREST standing in for production. What is
// pinned is the decision a merge rests on — HOLD or WOULD MERGE — not the
// parts that feed it.

const repo = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const PR = 7;
const FIXTURE = 'phase999_babysit_fixture.sql';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

// A gh that knows four calls: branch protection (the fixture's, else strict
// with nothing required), the PR list (fixture.prs, else the one fixture.pr),
// a PR's metadata by number, and anything else (comment/merge) as a recorded
// no-op. Each answer goes through jq with the --jq the script passed, as gh does.
const GH_STUB = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const fixture = JSON.parse(readFileSync(process.env.GH_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.GH_FIXTURE + '.calls', JSON.stringify(args) + '\\n');
const jq = args[args.indexOf('--jq') + 1];
let data;
if (args[0] === 'api' && args[1].endsWith('/required_status_checks')) data = fixture.protection ?? { strict: true, contexts: [] };
else if (args[0] === 'pr' && args[1] === 'list') data = fixture.prs ?? [fixture.pr];
else if (args[0] === 'pr' && args[1] === 'view') data = (fixture.prs ?? [fixture.pr]).find((p) => String(p.number) === args[2]);
else process.exit(0);
if (!args.includes('--jq')) { process.stdout.write(JSON.stringify(data)); process.exit(0); }
const out = spawnSync('jq', ['-r', jq], { input: JSON.stringify(data), encoding: 'utf8' });
process.stdout.write(out.stdout);
process.stderr.write(out.stderr);
process.exit(out.status ?? 1);
`;

describe('merge-babysit.sh: a migration PR merges only onto a production that already has it', { timeout: 120_000 }, () => {
  let tmp: string;
  let work: string;
  let headSha: string;
  let server: Server;
  let ledger: { name: string; fingerprint: string }[] = [];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8', env: gitEnv }).trim();

  beforeAll(async () => {
    // Without jq the stub cannot answer, and the script backs off for minutes before failing.
    execFileSync('jq', ['--version']);
    tmp =mkdtempSync(join(tmpdir(), 'apex-babysit-'));
    work = join(tmp, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);

    const copy = (path: string) => {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      copyFileSync(join(repo, path), join(work, path));
    };
    for (const path of ['scripts/merge-babysit.sh', 'scripts/merge-policy.mjs', 'scripts/prod-schema-check.mjs', 'src/lib/db/database.types.ts']) copy(path);
    for (const file of readdirSync(join(repo, 'supabase/migrations'))) copy(`supabase/migrations/${file}`);
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'main');
    git('remote', 'add', 'origin', join(tmp, 'origin.git'));
    git('push', '-q', 'origin', 'main');

    // The PR: one new migration, stamped as every migration must be.
    git('checkout', '-q', '-b', 'db/fixture');
    const sql = 'create table if not exists public.babysit_fixture (id int);\n';
    writeFileSync(join(work, 'supabase/migrations', FIXTURE), `${sql}\n${stampFor(FIXTURE, sql)}\n`);
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add a migration');
    headSha = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', `HEAD:refs/pull/${PR}/head`);
    git('checkout', '-q', 'main');

    // Production: every object main's types name, and whatever `ledger` holds.
    const functions = parseDatabaseTypes(readFileSync(join(repo, 'src/lib/db/database.types.ts'), 'utf8')).functions;
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      if (u.pathname === '/rest/v1/') {
        res.end(JSON.stringify({ paths: Object.fromEntries(functions.map((f: string) => [`/rpc/${f}`, {}])) }));
      } else if (u.pathname === '/rest/v1/migration_ledger' && u.searchParams.has('offset')) {
        res.setHeader('content-range', `0-${ledger.length - 1}/${ledger.length}`);
        res.end(JSON.stringify(ledger));
      } else {
        res.end('[]');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  });

  const onMain = () =>
    migrationsAt('origin/main', work).map(({ file, sql }: { file: string; sql: string }) => ({
      name: file.replace(/\.sql$/, ''),
      fingerprint: fingerprint(sql),
    }));
  const pullHead = () => {
    const { file, sql } = migrationsAt(headSha, work).find((m: { file: string }) => m.file === FIXTURE);
    return { name: file.replace(/\.sql$/, ''), fingerprint: fingerprint(sql) };
  };

  /** stdout of a run (a non-zero exit too — a --yes run ends at the missing deploy-verify.sh), and every gh call it made. */
  const babysit = async (labels: string[], { args = [] as string[], number = PR, headRefOid = headSha } = {}) => {
    const fixture = join(tmp, `gh-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(fixture, JSON.stringify({
      pr: {
        number,
        title: 'Add a migration',
        baseRefName: 'main',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        headRefName: 'db/fixture',
        headRefOid,
        changedFiles: 1,
        files: [{ path: `supabase/migrations/${FIXTURE}` }],
        labels: labels.map((name) => ({ name })),
      },
    }));
    const gh = join(tmp, 'gh');
    writeFileSync(gh, GH_STUB);
    chmodSync(gh, 0o755);
    const { port } = server.address() as AddressInfo;
    let out: string;
    try {
      out = (await run('bash', [join(work, 'scripts/merge-babysit.sh'), ...args], {
        cwd: work,
        env: {
          ...gitEnv,
          GH: gh,
          GH_FIXTURE: fixture,
          VITE_SUPABASE_URL: `http://127.0.0.1:${port}`,
          SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
        },
      })).stdout;
    } catch (err) {
      out = (err as { stdout: string }).stdout;
    }
    ghCalls = readFileSync(`${fixture}.calls`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    return out;
  };
  let ghCalls: string[][] = [];

  it("HOLDs a shipit migration PR while production's ledger lacks the PR's own migration", async () => {
    ledger = onMain();
    const out = await babysit(['shipit']);
    expect(out).toMatch(new RegExp(`HOLD  #${PR} — touches supabase/migrations/`));
    expect(out).toContain(`✗ migration ${FIXTURE} is not in production's migration_ledger`);
    expect(out).toContain(`apply ${FIXTURE} to production before merging`);
    expect(out).not.toMatch(/WOULD MERGE/);
  });

  it('says the same while the PR still waits for shipit, so the label does not go on blind', async () => {
    ledger = onMain();
    const out = await babysit([]);
    expect(out).toMatch(new RegExp(`HOLD  #${PR} — .*held for a human`));
    expect(out).toContain('shipit alone will not merge it');
    expect(out).toContain(`apply ${FIXTURE} to production before merging`);
  });

  it("would merge once production's ledger has it as written", async () => {
    ledger = [...onMain(), pullHead()];
    const out = await babysit(['shipit']);
    expect(out).toContain(`CHECK #${PR} touches supabase/migrations/ — production passes the schema check against origin/main and against the PR's head`);
    expect(out).toMatch(new RegExp(`WOULD MERGE #${PR}`));
    expect(out).not.toMatch(/HOLD/);
  });

  it('merges, under --yes, only the head that was checked', async () => {
    ledger = [...onMain(), pullHead()];
    const out = await babysit(['shipit'], { args: ['--yes', '--max-minutes=0'] });
    expect(out).toContain(`MERGE #${PR}`);
    expect(ghCalls).toContainEqual(['pr', 'merge', String(PR), '--squash', '--match-head-commit', headSha]);
  });

  it('waits, without merging or giving up on the PR, when the head GitHub reports is not the one fetched', async () => {
    ledger = [...onMain(), pullHead()];
    const out = await babysit(['shipit'], { headRefOid: '1'.repeat(40) });
    expect(out).toMatch(new RegExp(`WAIT  #${PR} — its head moved while production was checked against it`));
    expect(out).toContain("the PR's head moved while it was being checked");
    expect(out).not.toMatch(/WOULD MERGE|HOLD/);
    // A push mid-check is transient: the PR stays in the run for the next pass.
    expect(out).not.toMatch(/needs a human\/worktree/);
  });

  it('HOLDs, fail closed, when the head cannot be fetched at all', async () => {
    ledger = [...onMain(), pullHead()];
    const out = await babysit(['shipit'], { number: PR + 1 });
    expect(out).toMatch(new RegExp(`HOLD  #${PR + 1} `));
    expect(out).toContain("could not fetch the PR's head");
    expect(out).not.toMatch(/WOULD MERGE/);
  });

  it('HOLDs when production ran different SQL under the same name', async () => {
    ledger = [...onMain(), { ...pullHead(), fingerprint: '0'.repeat(16) }];
    const out = await babysit(['shipit']);
    expect(out).toContain(`✗ migration ${FIXTURE} was applied as different SQL`);
    expect(out).toContain(`apply ${FIXTURE} to production before merging`);
    expect(out).not.toMatch(/WOULD MERGE/);
  });
});

describe('merge-babysit.sh --fleet: each PR is proven and merged at the head that was folded', { timeout: 120_000 }, () => {
  // The union proof takes minutes. With branch names, combine-check refetched
  // and proved whatever the branches held by then, and an unpinned merge took
  // whatever head GitHub had after that: a push during the proof could land
  // code the proof never saw, once its required checks passed.
  const A = 21;
  const B = 22;
  let tmp: string;
  let work: string;
  let shaA: string;
  let shaB: string;
  let shaC: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8', env: gitEnv }).trim();
  const commit = (path: string, message: string) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), `export const x = ${JSON.stringify(message)};\n`);
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const branch = (name: string, path: string) => {
    git('checkout', '-q', '-b', name, 'main');
    const sha = commit(path, name);
    git('push', '-q', 'origin', name);
    git('checkout', '-q', 'main');
    return sha;
  };

  beforeAll(() => {
    execFileSync('jq', ['--version']);
    tmp = mkdtempSync(join(tmpdir(), 'apex-babysit-fleet-'));
    work = join(tmp, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    for (const path of ['scripts/merge-babysit.sh', 'scripts/merge-policy.mjs']) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      copyFileSync(join(repo, path), join(work, path));
    }
    // The real combine-check, where the babysitter does not call it.
    mkdirSync(join(work, 'bin'));
    copyFileSync(join(repo, 'scripts/combine-check.sh'), join(work, 'bin/combine-check.sh'));
    // The one the babysitter calls records its arguments (--check would run
    // agent:check). With PUSH_DURING_PROOF=<n>:<sha>, GitHub reports that head
    // for PR <n> from then on, as if it were pushed while the proof ran.
    writeFileSync(join(work, 'scripts/combine-check.sh'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$COMBINE_ARGS"
[ -z "\${PUSH_DURING_PROOF:-}" ] || node -e '
  const fs = require("node:fs");
  const [n, sha] = process.env.PUSH_DURING_PROOF.split(":");
  const f = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));
  f.prs.find((p) => String(p.number) === n).headRefOid = sha;
  fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(f));
'
`);
    chmodSync(join(work, 'scripts/combine-check.sh'), 0o755);
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'main');
    git('remote', 'add', 'origin', join(tmp, 'origin.git'));
    git('push', '-q', 'origin', 'main');
    shaA = branch('fix/fleet-a', 'src/fleet-a.ts');
    shaB = branch('fix/fleet-b', 'src/fleet-b.ts');
    shaC = branch('fix/fleet-c', 'src/fleet-c.ts');
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A green, policy-clean PR whose head GitHub reports as `headRefOid`. */
  const pr = (number: number, headRefName: string, headRefOid: string) => ({
    number,
    title: `Fleet fixture (#${number})`,
    baseRefName: 'main',
    isDraft: false,
    mergeStateStatus: 'CLEAN',
    headRefName,
    headRefOid,
    changedFiles: 1,
    files: [{ path: `src/${headRefName.slice(4)}.ts` }],
    labels: [],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'check', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-28T16:00:00Z', completedAt: '2026-10-28T16:12:00Z' },
    ],
  });

  /** stdout of a --fleet --yes run over these PRs (newest first, as gh lists them), its gh calls, and what combine-check was given. */
  const fleet = async (prs: object[], args: string[] = [], env: Record<string, string> = {}) => {
    const fixture = join(tmp, `gh-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(fixture, JSON.stringify({ protection: { strict: false, contexts: ['check'] }, prs }));
    const gh = join(tmp, 'gh');
    writeFileSync(gh, GH_STUB);
    chmodSync(gh, 0o755);
    const combineArgs = `${fixture}.combine`;
    let out: string;
    try {
      out = (await run('bash', [join(work, 'scripts/merge-babysit.sh'), '--fleet', '--yes', '--max-minutes=0', ...args], {
        cwd: work,
        env: { ...gitEnv, GH: gh, GH_FIXTURE: fixture, COMBINE_ARGS: combineArgs, ...env },
      })).stdout;
    } catch (err) {
      out = (err as { stdout: string }).stdout;
    }
    const calls = readFileSync(`${fixture}.calls`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    let combine: string[] | null = null;
    try {
      combine = readFileSync(combineArgs, 'utf8').trim().split('\n');
    } catch {
      // not called
    }
    return { out, calls, combine };
  };

  it('merges a non-migration PR pinned to the head it folded', async () => {
    const { out, calls } = await fleet([pr(A, 'fix/fleet-a', shaA)], ['--no-check']);
    expect(out).toContain(`FLEET #${A}`);
    expect(out).toContain(`MERGE #${A}`);
    expect(calls).toContainEqual(['pr', 'merge', String(A), '--squash', '--match-head-commit', shaA]);
    expect(calls.filter((c) => c[1] === 'merge')).toHaveLength(1);
  });

  it('hands the proof the folded SHAs in merge order, then pins each merge to its own', async () => {
    const { out, calls, combine } = await fleet([pr(B, 'fix/fleet-b', shaB), pr(A, 'fix/fleet-a', shaA)]);
    expect(combine).toEqual(['--check', '--sequential', shaA, shaB]);
    expect(out).toContain(`at the heads folded: #${A}@${shaA.slice(0, 7)} #${B}@${shaB.slice(0, 7)}`);
    expect(calls.filter((c) => c[1] === 'merge')).toEqual([
      ['pr', 'merge', String(A), '--squash', '--match-head-commit', shaA],
      ['pr', 'merge', String(B), '--squash', '--match-head-commit', shaB],
    ]);
  });

  it('merges none of the fleet when one head is pushed during the proof, and keeps that PR in the run', async () => {
    // The last PR moves, so a merge-as-you-go would already have landed the first.
    const moved = '2'.repeat(40);
    const { out, calls } = await fleet([pr(B, 'fix/fleet-b', shaB), pr(A, 'fix/fleet-a', shaA)], [], { PUSH_DURING_PROOF: `${B}:${moved}` });
    expect(out).toContain(`FLEET #${B}`);
    expect(out).toContain(`WAIT  #${B} — its head moved after it was proven (${shaB.slice(0, 12)}, now ${moved.slice(0, 12)})`);
    expect(out).toContain(`── fleet: #${B} moved during the proof — nothing merged; folding again next pass`);
    // Nothing merged, no "Auto-merged" comment on a PR that did not merge, and nothing skipped for the run.
    expect(calls.some((c) => c[1] === 'merge' || c[1] === 'comment')).toBe(false);
    expect(out).not.toMatch(/SKIP/);
  });

  it("waits, before reading anything about it, on a PR whose head GitHub reports is not the one fetched", async () => {
    // GitHub's PR view trails a push: its checks and files would be another commit's.
    const stale = '4'.repeat(40);
    const { out, calls, combine } = await fleet([pr(B, 'fix/fleet-b', shaB), pr(A, 'fix/fleet-a', stale)]);
    expect(out).toContain(`WAIT  #${A} — GitHub reports head ${stale.slice(0, 12)} but the fetch has ${shaA.slice(0, 12)} (a push in flight); next pass.`);
    expect(out).not.toContain(`FLEET #${A}`);
    expect(calls.some((c) => c[0] === 'pr' && c[2] === String(A))).toBe(false);
    // The rest of the fleet goes ahead without it.
    expect(combine).toEqual(['--check', '--sequential', shaB]);
    expect(calls.filter((c) => c[1] === 'merge')).toEqual([['pr', 'merge', String(B), '--squash', '--match-head-commit', shaB]]);
  });

  it("skips a fork's PR, even one whose head branch shares a name with a branch here", async () => {
    const fork = { ...pr(A, 'main', '6'.repeat(40)), isCrossRepository: true };
    const { out, calls } = await fleet([fork]);
    expect(out).toContain(`SKIP  #${A} comes from a fork — fleet folds only this repo's branches.`);
    expect(out).toMatch(new RegExp(`needs a human/worktree: PR\\(s\\) #${A}`));
    expect(out).not.toMatch(/WAIT|FLEET #/);
    expect(calls.some((c) => c[1] === 'merge')).toBe(false);
  });

  it('combine-check folds a SHA as given, behind its branch tip, and names one it does not have', async () => {
    git('checkout', '-q', 'fix/fleet-c');
    commit('src/fleet-c-2.ts', 'a push after the fold');
    git('push', '-q', 'origin', 'fix/fleet-c');
    git('checkout', '-q', 'main');
    const folded = await run('bash', [join(work, 'bin/combine-check.sh'), '--sequential', shaA, shaC], { cwd: work, env: gitEnv });
    expect(folded.stdout).toContain(`ok        ${shaA}`);
    expect(folded.stdout).toContain(`ok        ${shaC}`);
    expect(folded.stdout).not.toContain('origin/fix/fleet-c');
    const missing = '3'.repeat(40);
    const err = await run('bash', [join(work, 'bin/combine-check.sh'), '--sequential', missing], { cwd: work, env: gitEnv }).catch((e) => e as { code: number; stdout: string; stderr: string });
    expect(err).toMatchObject({ code: 1 });
    expect((err as { stderr: string }).stderr).toContain(`error: no such branch or commit '${missing}'`);
    expect((err as { stdout: string }).stdout).not.toContain('CONFLICT');
  });
});
