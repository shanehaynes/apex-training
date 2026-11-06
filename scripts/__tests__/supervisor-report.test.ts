import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The sweep's `── main` block, end to end: the real script copied alone into a
// throwaway repo, so every section that runs a sibling script finds it missing
// and skips (nothing here reaches production), and a gh stub answering from a
// fixture through the script's own --jq, as gh does. What is pinned is the line
// merge-shepherd acts on: "main's latest CI run is not green" stops merging, so
// a nightly whose only failed job is `evals` (a key or a cap, not main's code)
// must not print it, and every other failure still must.

const repo = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const RUN_ID = 42077346149;
const NOT_GREEN = "ACTION main's latest CI run is not green";
const EVALS_RED = "ACTION nightly coach evals red, main's code not implicated";

// Two calls: CI's run list (fixture.runs) and one run's jobs (fixture.jobs, or
// a failed call when it is absent). Anything else (backup runs, PR lists)
// answers nothing, which the script reports as none found.
const GH_STUB = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const fixture = JSON.parse(readFileSync(process.env.GH_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.GH_FIXTURE + '.calls', JSON.stringify(args) + '\\n');
let data;
if (args[0] === 'run' && args[1] === 'list' && args[args.indexOf('--workflow') + 1] === 'CI') data = fixture.runs;
else if (args[0] === 'run' && args[1] === 'view' && fixture.jobs && args[2] === String(fixture.runs[0].databaseId)) data = { jobs: fixture.jobs };
else if (args[0] === 'run' && args[1] === 'view') { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }
else process.exit(0);
const out = spawnSync('jq', ['-r', args[args.indexOf('--jq') + 1]], { input: JSON.stringify(data), encoding: 'utf8' });
process.stdout.write(out.stdout);
process.stderr.write(out.stderr);
process.exit(out.status ?? 1);
`;

type Job = { name: string; conclusion: string; status: string };
const done = (name: string, conclusion: string): Job => ({ name, conclusion, status: 'completed' });

// The nightly's jobs as main's run 42077346149 reported them on 2026-11-05,
// with evals and check set per case. coach-gate skips outside PRs.
function nightly(evals: string, check = 'success'): Job[] {
  return [
    done('changes', 'success'), done('check', check), done('full', 'success'), done('e2e-mock', 'success'),
    done('apexcore-linux', 'success'), done('ios', 'success'), done('hooks-macos', 'success'),
    done('prod-checks', 'success'), done('coach-gate', 'skipped'), done('evals', evals),
  ];
}

describe("supervisor-report.sh: a nightly red only in evals is not a broken main", { timeout: 60_000 }, () => {
  let tmp: string;
  let work: string;
  let gh: string;

  beforeAll(() => {
    // Without jq the stub cannot answer, and every case would read as gh failing.
    execFileSync('jq', ['--version']);
    tmp = mkdtempSync(join(tmpdir(), 'apex-supervisor-'));
    work = join(tmp, 'work');
    mkdirSync(join(work, 'scripts'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    copyFileSync(join(repo, 'scripts/supervisor-report.sh'), join(work, 'scripts/supervisor-report.sh'));
    gh = join(tmp, 'gh');
    writeFileSync(gh, GH_STUB);
    chmodSync(gh, 0o755);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** The whole report, its `── main` block, and every gh call the run made. */
  const sweep = async (conclusion: string, jobs: Job[] | undefined) => {
    const fixture = join(tmp, `gh-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(fixture, JSON.stringify({
      runs: [{ databaseId: RUN_ID, conclusion, status: 'completed', updatedAt: '2026-11-05T18:25:02Z', displayTitle: 'CI' }],
      jobs,
    }));
    const { stdout } = await run('bash', [join(work, 'scripts/supervisor-report.sh'), '--no-local'], {
      cwd: work,
      // HOME points at the scratch dir so no real credentials file is in reach.
      env: { PATH: process.env.PATH, HOME: tmp, GH: gh, GH_FIXTURE: fixture, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    const lines = stdout.split('\n');
    const start = lines.indexOf('── main');
    const end = lines.indexOf('', start);
    const calls = readFileSync(`${fixture}.calls`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    return { stdout, main: lines.slice(start + 1, end).join('\n'), calls };
  };

  it('evals failed and nothing else did: the evals line names the key, and the not-green line is absent', async () => {
    const { stdout, main, calls } = await sweep('failure', nightly('failure'));
    expect(main).toContain(EVALS_RED);
    expect(main).toContain('ANTHROPIC_API_KEY');
    expect(main).toContain(`gh run view ${RUN_ID} --log-failed`);
    expect(stdout).not.toContain(NOT_GREEN);
    expect(calls).toContainEqual(expect.arrayContaining(['run', 'view', String(RUN_ID), '--json', 'jobs']));
  });

  it('evals cut off at its cap (cancelled): the evals line names the cap, and the not-green line is absent', async () => {
    const { stdout, main } = await sweep('cancelled', nightly('cancelled'));
    expect(main).toContain(EVALS_RED);
    expect(main).toContain('timeout-minutes cap');
    expect(stdout).not.toContain(NOT_GREEN);
  });

  it('check failed: the not-green line still prints, and the evals line does not', async () => {
    const { main, stdout } = await sweep('failure', nightly('success', 'failure'));
    expect(main).toContain(`${NOT_GREEN}: failure  2026-11-05T18:25:02Z  CI`);
    expect(stdout).not.toContain(EVALS_RED);
  });

  it('check and evals both failed: evals is not the only failure, so the not-green line prints', async () => {
    const { main, stdout } = await sweep('failure', nightly('failure', 'failure'));
    expect(main).toContain(NOT_GREEN);
    expect(stdout).not.toContain(EVALS_RED);
  });

  it('evals failed while another job is still running: not settled, so the not-green line prints', async () => {
    const jobs = nightly('failure').map((j) => (j.name === 'ios' ? { name: 'ios', conclusion: '', status: 'in_progress' } : j));
    const { main, stdout } = await sweep('', jobs);
    expect(main).toContain(NOT_GREEN);
    expect(stdout).not.toContain(EVALS_RED);
  });

  it('the job list cannot be read: nothing proves main innocent, so the not-green line prints', async () => {
    const { main, stdout } = await sweep('failure', undefined);
    expect(main).toContain(NOT_GREEN);
    expect(stdout).not.toContain(EVALS_RED);
  });

  it('a green run stays green and never lists its jobs', async () => {
    const { main, calls } = await sweep('success', nightly('success'));
    expect(main).toBe('   green: success  2026-11-05T18:25:02Z  CI');
    expect(calls.some((c) => c[0] === 'run' && c[1] === 'view')).toBe(false);
  });
});
