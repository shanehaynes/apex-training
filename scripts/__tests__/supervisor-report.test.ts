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
// must not print it, and every other failure still must. Nor may a run that
// has not finished print it (gh gives its conclusion as "", not null): it is
// status, and the verdict is the run that finished last before it.

const repo = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const RUN_ID = 42077346149;
const NOT_GREEN = "ACTION main's latest CI run is not green";
const EVALS_RED = 'ACTION nightly coach evals red, no other job failed';

// Two calls: CI's run list (fixture.runs) and one run's jobs (fixture.jobs for
// run fixture.jobsRun, by default the first, or a failed call for any other).
// Anything else (backup runs, PR lists) answers nothing, which the script
// reports as none found. Like gh, an object carries only the fields --json
// names, so a script that stops asking for one it reads (databaseId) sees null
// here as it would from GitHub.
const GH_STUB = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const fixture = JSON.parse(readFileSync(process.env.GH_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.GH_FIXTURE + '.calls', JSON.stringify(args) + '\\n');
const fields = args.includes('--json') ? args[args.indexOf('--json') + 1].split(',') : [];
const pick = (o) => Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]]));
let data;
if (args[0] === 'run' && args[1] === 'list' && args[args.indexOf('--workflow') + 1] === 'CI') data = fixture.runs.map(pick);
else if (args[0] === 'run' && args[1] === 'view' && fixture.jobs && args[2] === String(fixture.jobsRun ?? fixture.runs[0].databaseId)) data = pick({ jobs: fixture.jobs });
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

type Run = {
  databaseId: number; status: string; conclusion: string;
  createdAt: string; startedAt: string; updatedAt: string; displayTitle: string;
};
/** A run that ran to its end. Pending-then-superseded runs are finished too: cancelled, with no jobs. */
const finished = (databaseId: number, conclusion: string, createdAt: string, updatedAt: string, displayTitle: string): Run =>
  ({ databaseId, status: 'completed', conclusion, createdAt, startedAt: createdAt, updatedAt, displayTitle });
/** A run with no verdict yet: gh reports its conclusion as "", not null. */
const unfinished = (databaseId: number, status: string, createdAt: string, displayTitle: string, startedAt = createdAt): Run =>
  ({ databaseId, status, conclusion: '', createdAt, startedAt, updatedAt: startedAt, displayTitle });

describe('supervisor-report.sh: a nightly red only in evals, or a run not finished yet, is not a broken main', { timeout: 60_000 }, () => {
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

  /** The whole report, its `── main` block, and every gh call the run made, for main's runs newest first. */
  const sweepRuns = async (runs: object[], jobs: Job[] | undefined, jobsRun?: number) => {
    const fixture = join(tmp, `gh-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(fixture, JSON.stringify({ runs, jobs, jobsRun }));
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

  /** One finished run, 42077346149, as the sweep saw it on 2026-11-05. */
  const sweep = (conclusion: string, jobs: Job[] | undefined) =>
    sweepRuns([{ databaseId: RUN_ID, conclusion, status: 'completed', updatedAt: '2026-11-05T18:25:02Z', displayTitle: 'CI' }], jobs);

  it('evals failed and nothing else did: the evals line sorts the key from main by first error, and the not-green line is absent', async () => {
    const { stdout, main, calls } = await sweep('failure', nightly('failure'));
    expect(main).toContain(`${EVALS_RED}: failure  2026-11-05T18:25:02Z  CI`);
    expect(main).toContain(`gh run view ${RUN_ID} --log-failed`);
    expect(main).toContain('ANTHROPIC_API_KEY');
    expect(main).toContain('src/lib/coach/models.ts');
    expect(stdout).not.toContain(NOT_GREEN);
    expect(calls).toContainEqual(['run', 'view', String(RUN_ID), '--json', 'jobs', '--jq', expect.any(String)]);
  });

  it.each(['cancelled', 'timed_out'])('evals cut off at its cap (%s): the evals line names the cap, and the not-green line is absent', async (evals) => {
    const { stdout, main } = await sweep('cancelled', nightly(evals));
    expect(main).toContain(`${EVALS_RED}: cancelled  2026-11-05T18:25:02Z  CI`);
    expect(main).toContain('timeout-minutes cap');
    expect(main).toContain(`gh run view ${RUN_ID}`);
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

  // Main's CI runs one run at a time (ci.yml: cancel-in-progress is off for
  // main), so a push during the nightly waits its turn, and a newer push
  // cancels the waiting one before it runs a job. The timestamps are main's
  // runs of 2026-11-08.
  const PUSH_GREEN = finished(42487068054, 'success', '2026-11-08T13:53:05Z', '2026-11-08T14:32:09Z', 'CI evals: 70-minute cap');
  const PUSH_RED = finished(42487068054, 'failure', '2026-11-08T13:53:05Z', '2026-11-08T14:32:09Z', 'CI evals: 70-minute cap');
  const NIGHTLY_RUNNING = unfinished(42490971500, 'in_progress', '2026-11-08T14:40:37Z', 'CI');

  it('a nightly still running over a green run: status, the green verdict, and no ACTION', async () => {
    const { main, calls } = await sweepRuns([NIGHTLY_RUNNING, PUSH_GREEN], undefined);
    expect(main).toBe([
      '   not finished: in_progress since 2026-11-08T14:40:37Z  CI',
      '   green: success  2026-11-08T14:32:09Z  CI evals: 70-minute cap',
    ].join('\n'));
    expect(main).not.toMatch(/^ACTION/m);
    expect(calls.some((c) => c[0] === 'run' && c[1] === 'view')).toBe(false);
  });

  it.each(['queued', 'pending'])('a push %s behind the running nightly: a status line for each, newest first, and no ACTION', async (status) => {
    const queued = unfinished(42491000000, status, '2026-11-08T14:55:00Z', 'Reorder: no stray keydown');
    const { main } = await sweepRuns([queued, NIGHTLY_RUNNING, PUSH_GREEN], undefined);
    expect(main).toBe([
      `   not finished: ${status} since 2026-11-08T14:55:00Z  Reorder: no stray keydown`,
      '   not finished: in_progress since 2026-11-08T14:40:37Z  CI',
      '   green: success  2026-11-08T14:32:09Z  CI evals: 70-minute cap',
    ].join('\n'));
    expect(main).not.toMatch(/^ACTION/m);
  });

  it('a run still going over a failed one: the not-green line names the failed run, not the running one', async () => {
    const { main, stdout, calls } = await sweepRuns([NIGHTLY_RUNNING, PUSH_RED], undefined);
    expect(main).toContain('   not finished: in_progress since 2026-11-08T14:40:37Z  CI');
    expect(main).toContain(`${NOT_GREEN}: failure  2026-11-08T14:32:09Z  CI evals: 70-minute cap`);
    expect(stdout).not.toContain(EVALS_RED);
    expect(calls).toContainEqual(['run', 'view', '42487068054', '--json', 'jobs', '--jq', expect.any(String)]);
  });

  it('a run still going over an evals-only red nightly: the evals line, not the not-green line', async () => {
    const nightlyCut = finished(RUN_ID, 'cancelled', '2026-11-05T17:43:09Z', '2026-11-05T18:25:02Z', 'CI');
    const pushRunning = unfinished(42080000000, 'in_progress', '2026-11-05T19:00:00Z', 'Supervisor: evals-only');
    const { main, stdout } = await sweepRuns([pushRunning, nightlyCut], nightly('cancelled'), RUN_ID);
    expect(main).toContain('   not finished: in_progress since 2026-11-05T19:00:00Z  Supervisor: evals-only');
    expect(main).toContain(`${EVALS_RED}: cancelled  2026-11-05T18:25:02Z  CI`);
    expect(stdout).not.toContain(NOT_GREEN);
  });

  // The cancelled runs here have no jobs, so if the verdict fell on one, the
  // job list would be empty and the not-green line would print.
  it.each([
    ['older than the running run', [
      unfinished(42490971500, 'in_progress', '2026-11-08T14:40:37Z', 'Nightly evals: go red'),
      finished(42487074004, 'cancelled', '2026-11-08T13:53:10Z', '2026-11-08T13:53:16Z', 'Supervisor: headroom'),
      PUSH_GREEN,
    ]],
    ['newer than the running run', [
      unfinished(42491100000, 'pending', '2026-11-08T15:00:00Z', 'Third push'),
      finished(42491050000, 'cancelled', '2026-11-08T14:50:00Z', '2026-11-08T15:00:01Z', 'Second push'),
      NIGHTLY_RUNNING,
      PUSH_GREEN,
    ]],
  ])('a run cancelled while waiting its turn (%s) is not the verdict: the run that finished last before the running one is', async (_, runs) => {
    const { main } = await sweepRuns(runs, undefined);
    expect(main).toContain('   green: success  2026-11-08T14:32:09Z  CI evals: 70-minute cap');
    expect(main).not.toMatch(/^ACTION/m);
  });

  it('a re-run in progress counts from when it restarted, not from when the run was first created', async () => {
    const rerun = unfinished(41710592089, 'in_progress', '2026-11-03T20:13:37Z', 'App Store order', '2026-11-04T12:32:23Z');
    const before = finished(41695721949, 'success', '2026-11-03T18:38:20Z', '2026-11-03T19:43:16Z', 'App Privacy');
    const { main } = await sweepRuns([rerun, before], undefined);
    expect(main).toContain('   not finished: in_progress since 2026-11-04T12:32:23Z  App Store order');
  });

  it('no run has finished yet: says so, with no ACTION and no "no CI runs found"', async () => {
    const { main } = await sweepRuns([NIGHTLY_RUNNING], undefined);
    expect(main).toBe([
      '   not finished: in_progress since 2026-11-08T14:40:37Z  CI',
      "   no finished CI run among main's last 20",
    ].join('\n'));
  });

  it('no runs at all: none found, not a not-green line about a null run', async () => {
    const { main, calls } = await sweepRuns([], undefined);
    expect(main).toBe('   no CI runs found (gh auth?)');
    expect(calls.some((c) => c[0] === 'run' && c[1] === 'view')).toBe(false);
  });
});
