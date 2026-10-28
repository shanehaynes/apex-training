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

// A gh that knows four calls: branch protection, the PR list, a PR's
// metadata, and anything else (comment/merge) as a recorded no-op. Each
// answer goes through jq with the --jq the script passed, as gh does.
const GH_STUB = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const fixture = JSON.parse(readFileSync(process.env.GH_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.GH_FIXTURE + '.calls', JSON.stringify(args) + '\\n');
const jq = args[args.indexOf('--jq') + 1];
let data;
if (args[0] === 'api' && args[1].endsWith('/required_status_checks')) data = { strict: true, contexts: [] };
else if (args[0] === 'pr' && args[1] === 'list') data = [fixture.pr];
else if (args[0] === 'pr' && args[1] === 'view') data = fixture.pr;
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

  it('refuses --yes, before any gh merge, when the policy it would run is not main\'s', async () => {
    ledger = [...onMain(), pullHead()];
    const policy = join(work, 'scripts/merge-policy.mjs');
    const original = readFileSync(policy, 'utf8');
    writeFileSync(policy, 'process.exit(0);\n');
    try {
      const out = await babysit(['shipit'], { args: ['--yes', '--max-minutes=0'] }).catch((e) => String(e));
      expect(ghCalls.some((c) => c[0] === 'pr' && c[1] === 'merge')).toBe(false);
      expect(out).not.toContain(`MERGE #${PR}`);
    } finally {
      writeFileSync(policy, original);
    }
  });

  it('refuses --yes when an untracked script sits beside the automation', async () => {
    ledger = [...onMain(), pullHead()];
    const extra = join(work, 'scripts/extra.mjs');
    writeFileSync(extra, '');
    try {
      await babysit(['shipit'], { args: ['--yes', '--max-minutes=0'] });
      expect(ghCalls.some((c) => c[0] === 'pr' && c[1] === 'merge')).toBe(false);
    } finally {
      rmSync(extra);
    }
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
