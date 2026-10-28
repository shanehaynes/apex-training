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
        statusCheckRollup: [],
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

describe('merge-babysit.sh: a PR merges only once every check on its head has finished green', { timeout: 120_000 }, () => {
  // ios is not a required check, so GitHub's floor does not wait for it — the
  // babysitter must. In Oct 2026 fleet mode merged 12 of 16 iOS PRs while
  // ios was still running, and 9 of those runs ended red.
  const REQUIRED = ['check', 'e2e-mock', 'full', 'coach-gate'];
  const IOS_PR = 11;
  const BRANCH = 'fix/ios-fixture';
  let tmp: string;
  let work: string;
  let headSha: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8', env: gitEnv }).trim();

  beforeAll(() => {
    execFileSync('jq', ['--version']);
    tmp = mkdtempSync(join(tmpdir(), 'apex-babysit-ios-'));
    work = join(tmp, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    for (const path of ['scripts/merge-babysit.sh', 'scripts/merge-policy.mjs']) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      copyFileSync(join(repo, path), join(work, path));
    }
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'main');
    git('remote', 'add', 'origin', join(tmp, 'origin.git'));
    git('push', '-q', 'origin', 'main');
    // An iOS PR, on a branch of this repo: fleet mode folds origin/<head>.
    git('checkout', '-q', '-b', BRANCH);
    mkdirSync(join(work, 'ios/Packages/ApexCore/Sources'), { recursive: true });
    writeFileSync(join(work, 'ios/Packages/ApexCore/Sources/Fixture.swift'), 'let fixture = 1\n');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'an iOS change');
    headSha = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', BRANCH);
    git('checkout', '-q', 'main');
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const at = (minute: number) => new Date(Date.UTC(2026, 9, 28, 16, minute)).toISOString().replace('.000', '');
  const NOT_DONE = '0001-01-01T00:00:00Z';
  /** A CI job as gh's statusCheckRollup reports it; no conclusion means still running. */
  const job = (name: string, conclusion: string | null, startedAt: string | null, completedAt = NOT_DONE) => ({
    __typename: 'CheckRun',
    name,
    workflowName: 'CI',
    status: conclusion ? 'COMPLETED' : 'IN_PROGRESS',
    conclusion: conclusion ?? '',
    startedAt,
    completedAt,
  });
  const requiredGreen = REQUIRED.map((name) => job(name, 'SUCCESS', at(0), at(12)));
  const vercel = { __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS', startedAt: at(0) };

  const iosPr = (rollup: object[], { number = IOS_PR, state = 'UNSTABLE' } = {}) => ({
    number,
    title: `An iOS change (#${number})`,
    baseRefName: 'main',
    isDraft: false,
    mergeStateStatus: state,
    headRefName: BRANCH,
    headRefOid: headSha,
    changedFiles: 1,
    files: [{ path: 'ios/Packages/ApexCore/Sources/Fixture.swift' }],
    labels: [],
    statusCheckRollup: rollup,
  });

  /** stdout and stderr of a run (a non-zero exit too) over these PRs, and every gh call it made. */
  const babysitAll = async (prs: object[], { fleet = true, args = [] as string[] } = {}) => {
    const fixture = join(tmp, `gh-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(fixture, JSON.stringify({ protection: { strict: !fleet, contexts: REQUIRED }, prs }));
    const gh = join(tmp, 'gh');
    writeFileSync(gh, GH_STUB);
    chmodSync(gh, 0o755);
    let out: string;
    let err: string;
    try {
      ({ stdout: out, stderr: err } = await run('bash', [join(work, 'scripts/merge-babysit.sh'), ...(fleet ? ['--fleet'] : []), ...args], {
        cwd: work,
        env: { ...gitEnv, GH: gh, GH_FIXTURE: fixture },
      }));
    } catch (e) {
      ({ stdout: out, stderr: err } = e as { stdout: string; stderr: string });
    }
    const calls = readFileSync(`${fixture}.calls`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    return { out, err, calls };
  };
  /** stdout of a dry run against one iOS PR with this rollup. */
  const babysit = async (rollup: object[], { fleet = true, state = 'UNSTABLE' } = {}) =>
    (await babysitAll([iosPr(rollup, { state })], { fleet })).out;

  it('folds the PR once every check finished green — the fixture can go green at all', async () => {
    const out = await babysit([...requiredGreen, job('ios', 'SUCCESS', at(0), at(35)), vercel]);
    expect(out).toContain(`FLEET #${IOS_PR} — UNSTABLE, but every required check passed`);
    expect(out).toContain('WOULD PROVE the union of 1 PR(s)');
  });

  it('waits while ios is still running, though every required check passed', async () => {
    const out = await babysit([...requiredGreen, job('ios', null, at(0)), vercel]);
    expect(out).toContain(`WAIT  #${IOS_PR}: UNSTABLE — CI still running — waiting on ios; next pass.`);
    expect(out).not.toMatch(/FLEET #|WOULD PROVE/);
  });

  it('skips the PR when ios was cut off: a CANCELLED that is the newest run is red', async () => {
    // timeout-minutes reports cancelled, not timed_out (#395, #438, #451).
    const out = await babysit([...requiredGreen, job('ios', 'CANCELLED', at(0), at(41)), vercel]);
    expect(out).toContain(`SKIP  #${IOS_PR} has failing check(s): ios=CANCELLED (cut off before it finished — re-run it)`);
    expect(out).not.toMatch(/FLEET #|WOULD PROVE|WAIT/);
  });

  it("lets the newer run decide over a superseded run's CANCELLED, whichever the rollup lists first", async () => {
    const out = await babysit([
      job('full', 'CANCELLED', at(0), at(3)),
      ...requiredGreen,
      job('ios', 'CANCELLED', at(0), at(3)),
      job('ios', 'SUCCESS', at(3), at(38)),
      vercel,
    ]);
    expect(out).toContain(`FLEET #${IOS_PR}`);
    expect(out).not.toMatch(/SKIP|WAIT/);
  });

  it('picks the newest run by time, not by its place in the rollup', async () => {
    const green = await babysit([...requiredGreen, job('ios', 'SUCCESS', at(3), at(38)), job('ios', 'CANCELLED', at(0), at(3)), vercel]);
    expect(green).toContain(`FLEET #${IOS_PR}`);
    const red = await babysit([...requiredGreen, job('ios', 'FAILURE', at(3), at(38)), job('ios', 'SUCCESS', at(0), at(30)), vercel]);
    expect(red).toContain(`SKIP  #${IOS_PR} has failing check(s): ios=FAILURE`);
    expect(red).not.toMatch(/FLEET #/);
  });

  it('waits on a status that is still pending, and on a required check that has not reported', async () => {
    const vercelPending = await babysit([...requiredGreen, job('ios', 'SUCCESS', at(0), at(35)), { ...vercel, state: 'PENDING' }]);
    expect(vercelPending).toContain(`WAIT  #${IOS_PR}: UNSTABLE — CI still running — waiting on Vercel; next pass.`);
    const checkMissing = await babysit([...requiredGreen.filter((j) => j.name !== 'check'), job('ios', 'SUCCESS', at(0), at(35)), vercel]);
    expect(checkMissing).toContain(`WAIT  #${IOS_PR}: UNSTABLE — CI still running — waiting on check; next pass.`);
  });

  it('at the deadline, still runs the post-merge lifecycle for what it merged, and reads protection once', async () => {
    const { out, err, calls } = await babysitAll(
      [iosPr([...requiredGreen, job('ios', null, at(0)), vercel]), iosPr([...requiredGreen, job('ios', 'SUCCESS', at(0), at(35)), vercel], { number: IOS_PR + 1 })],
      { args: ['--yes', '--no-check', '--max-minutes=0'] },
    );
    expect(out).toContain(`WAIT  #${IOS_PR}: UNSTABLE — CI still running — waiting on ios; next pass.`);
    expect(out).toContain(`MERGE #${IOS_PR + 1}`);
    expect(err).toContain('giving up after 0m');
    expect(out).toContain('── post-merge: retiring merged branches and worktrees');
    expect(calls).toContainEqual(['pr', 'merge', String(IOS_PR + 1), '--squash']);
    expect(calls.some((c) => c[1] === 'merge' && c[2] === String(IOS_PR))).toBe(false);
    // The strict check, then one load of the required contexts — not one per PR.
    expect(calls.filter((c) => c[0] === 'api' && c[1].endsWith('/required_status_checks'))).toHaveLength(2);
  });

  it('waits, rather than calling it red, while the run that superseded a CANCELLED has not started', async () => {
    const out = await babysit([
      ...requiredGreen,
      job('ios', 'CANCELLED', at(0), at(3)),
      { ...job('ios', null, null), status: 'QUEUED' },
      vercel,
    ]);
    expect(out).toContain(`WAIT  #${IOS_PR}: UNSTABLE — CI still running — waiting on ios; next pass.`);
    expect(out).not.toMatch(/SKIP|FLEET #/);
  });

  it('serial loop: a cut-off ios is skipped with its reason, not waited on until the deadline', async () => {
    const out = await babysit([...requiredGreen, job('ios', 'CANCELLED', at(0), at(41)), vercel], { fleet: false });
    expect(out).toContain(`SKIP  #${IOS_PR} has failing check(s): ios=CANCELLED (cut off before it finished — re-run it)`);
    expect(out).not.toMatch(/WOULD MERGE|WAIT/);
  });

  it('serial loop: a stale CLEAN with ios still running waits instead of merging', async () => {
    const out = await babysit([...requiredGreen, job('ios', null, at(0)), vercel], { fleet: false, state: 'CLEAN' });
    expect(out).toContain(`WAIT  #${IOS_PR}: CLEAN, but CI still running — waiting on ios; next pass.`);
    expect(out).not.toMatch(/WOULD MERGE/);
  });

  it('serial loop: CLEAN with every check finished green would merge', async () => {
    const out = await babysit([...requiredGreen, job('ios', 'SUCCESS', at(0), at(35)), vercel], { fleet: false, state: 'CLEAN' });
    expect(out).toContain(`WOULD MERGE #${IOS_PR}`);
  });
});
