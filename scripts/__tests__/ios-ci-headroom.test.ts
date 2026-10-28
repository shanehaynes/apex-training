import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidates, jobFrom, main, nearCap } from '../ios-ci-headroom.mjs';

const ciYml = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
const NOW = Date.parse('2026-10-28T12:00:00Z');
const T0 = Date.parse('2026-10-27T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

// The shape that matters: a job before and after `ios` with their own caps,
// and a step-level timeout inside `ios` that is not the job's cap.
const workflow = (cap = '75', extra = '') => `name: CI
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: npm test
  # a comment between jobs
  ios:
    runs-on: macos-26
    timeout-minutes: ${cap}
${extra}    steps:
      - uses: actions/checkout@v7
      - name: Build and test
        timeout-minutes: 50
        run: xcodebuild test
  e2e:
    timeout-minutes: 10
`;

type Job = {
  name: string; run_id: number; run_attempt: number; status: string; conclusion: string | null;
  started_at: string | null; completed_at: string | null; steps: { name: string; conclusion: string | null }[];
};

function job(run: number, seconds: number, o: Partial<{ conclusion: string; build: string | null; attempt: number; name: string; at: number }> = {}): Job {
  const at = o.at ?? T0;
  const steps = [{ name: 'Set up job', conclusion: 'success' }];
  if (o.build !== null) steps.push({ name: 'Build and test', conclusion: o.build ?? 'success' });
  return {
    name: o.name ?? 'ios', run_id: run, run_attempt: o.attempt ?? 1, status: 'completed',
    conclusion: o.conclusion ?? 'success', started_at: iso(at), completed_at: iso(at + seconds * 1000), steps,
  };
}

function run(id: number, wallMinutes: number, status = 'completed') {
  return { databaseId: id, status, createdAt: iso(T0), updatedAt: iso(T0 + wallMinutes * 60_000) };
}

/** A stand-in for the gh CLI: canned runs, canned jobs per run, a call log. */
function fakeGh(runs: unknown[] | Error, jobs: Record<number, Job[] | Error>) {
  const calls: string[][] = [];
  const gh = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'run') {
      if (runs instanceof Error) throw runs;
      return JSON.stringify(runs);
    }
    const id = Number(args[1].match(/runs\/(\d+)\/jobs/)![1]);
    const page = jobs[id];
    if (page instanceof Error) throw page;
    return JSON.stringify({ total_count: page?.length ?? 0, jobs: page ?? [] });
  });
  return { gh, calls };
}

let log: string[];
beforeEach(() => {
  log = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { log.push(line); });
});
afterEach(() => vi.restoreAllMocks());

describe('jobFrom', () => {
  it("reads the ios job's own cap, not a neighbour's or a step's", () => {
    expect(jobFrom(workflow())).toEqual({ cap: 75, name: 'ios' });
    expect(jobFrom(workflow('40  # was 30'))).toEqual({ cap: 40, name: 'ios' });
  });

  it('follows a job-level name:, which is what the jobs API reports', () => {
    expect(jobFrom(workflow('75', '    name: iOS build\n')).name).toBe('iOS build');
    expect(jobFrom(workflow('75', '    name: "iOS build"  # shown in the checks list\n')).name).toBe('iOS build');
    expect(jobFrom(workflow('"75"')).cap).toBe(75);
  });

  it('throws when the shape it depends on is gone, rather than reporting all-clear', () => {
    expect(() => jobFrom(workflow().replace('  ios:', '  apple:'))).toThrow(/no `ios` job/);
    expect(() => jobFrom(workflow().replace('    timeout-minutes: 75\n', ''))).toThrow(/no timeout-minutes/);
    expect(() => jobFrom(workflow('${{ inputs.cap }}'))).toThrow(/not a number/);
    expect(() => jobFrom(workflow().replace('Build and test', 'Test'))).toThrow(/no "Build and test" step/);
    expect(() => jobFrom(workflow('75', '    name: ios-${{ matrix.os }}\n'))).toThrow(/name is an expression/);
  });

  // The guard that matters in CI: renaming the job or the step, or making the
  // cap an expression, fails here instead of turning the report silently blind.
  it("parses this repository's own ci.yml", () => {
    const { cap, name } = jobFrom(ciYml);
    expect(name).toBe('ios');
    expect(Number.isInteger(cap) && cap > 15).toBe(true);
  });
});

describe('candidates', () => {
  it("fetches jobs only for runs long enough to hold a slow ios job, and every run still going", () => {
    const runs = [run(1, 59), run(2, 60), run(3, 5, 'in_progress'), run(4, 200)];
    expect(candidates(runs, 75)).toEqual([2, 3, 4]);
  });
});

describe('nearCap', () => {
  it('counts from cap − 15 inclusive', () => {
    expect(nearCap([job(1, 60 * 60)], 75)).toHaveLength(1);
    expect(nearCap([job(1, 60 * 60 - 1)], 75)).toHaveLength(0);
  });

  it('counts a cap kill: cancelled at or past the cap', () => {
    expect(nearCap([job(1, 75 * 60 + 9, { conclusion: 'cancelled', build: 'cancelled' })], 75))
      .toEqual([{ run: 1, attempt: 1, conclusion: 'cancelled', seconds: 75 * 60 + 9 }]);
  });

  it('skips jobs whose Build and test did not run, other jobs, and unfinished ones', () => {
    const long = 70 * 60;
    expect(nearCap([
      job(1, long, { build: 'skipped' }),
      job(2, long, { build: null }), // never reached a runner: no steps at all
      job(3, long, { name: 'e2e' }),
      job(5, long, { name: 'ios-lint' }),
      { ...job(4, long), status: 'in_progress', completed_at: null },
    ], 75)).toEqual([]);
  });

  it('counts a matrix job, which the API names "ios (<values>)"', () => {
    expect(nearCap([job(1, 70 * 60, { name: 'ios (iPhone 17, 26.5)' })], 75)).toHaveLength(1);
  });
});

describe('main', () => {
  it('prints the ACTION with the count, the cap, and the slowest run', async () => {
    const runs = [run(101, 65), run(102, 90), run(103, 30), run(104, 80)];
    const { gh, calls } = fakeGh(runs, {
      101: [job(101, 61 * 60 + 30)],
      102: [job(102, 75 * 60 + 9, { conclusion: 'cancelled', build: 'cancelled' }), job(102, 20 * 60, { name: 'e2e' })],
      104: [job(104, 40 * 60)],
    });
    expect(await main({ gh, now: NOW, workflow: workflow() })).toBe(1);
    expect(log).toEqual([
      'ACTION ios CI: 2 run(s) within 15 min of the 75-minute cap (slowest 75 min, run 102) — shorten the job rather than raise the cap (docs/ios/testing-and-ci.md)',
    ]);

    // Seven days back from now, ci.yml only, and the short run never fetched.
    expect(calls[0]).toEqual([
      'run', 'list', '--workflow', 'ci.yml', '--created', '>=2026-10-21T12:00:00Z', '--limit', '1000',
      '--json', 'databaseId,status,createdAt,updatedAt',
    ]);
    const fetched = calls.slice(1).map(c => c[1]);
    expect(fetched).toEqual([
      'repos/{owner}/{repo}/actions/runs/101/jobs?filter=all&per_page=100',
      'repos/{owner}/{repo}/actions/runs/102/jobs?filter=all&per_page=100',
      'repos/{owner}/{repo}/actions/runs/104/jobs?filter=all&per_page=100',
    ]);
  });

  it('counts a slow first attempt even when the re-run was fast', async () => {
    const { gh } = fakeGh([run(7, 130)], {
      7: [job(7, 75 * 60 + 5, { conclusion: 'cancelled', attempt: 1 }), job(7, 35 * 60, { attempt: 2, at: T0 + 80 * 60_000 })],
    });
    expect(await main({ gh, now: NOW, workflow: workflow() })).toBe(1);
    expect(log[0]).toContain('1 run(s) within 15 min of the 75-minute cap (slowest 75 min, run 7)');
  });

  // "Re-run failed jobs" copies a passed job into the new attempt with the
  // same timestamps; two slow attempts are still one run.
  it('counts runs, not attempts', async () => {
    const { gh } = fakeGh([run(8, 200), run(9, 200)], {
      8: [job(8, 62 * 60, { attempt: 1 }), job(8, 62 * 60, { attempt: 2 })],
      9: [job(9, 64 * 60, { attempt: 1 }), job(9, 66 * 60, { attempt: 2, at: T0 + 90 * 60_000 })],
    });
    expect(await main({ gh, now: NOW, workflow: workflow() })).toBe(1);
    expect(log[0]).toContain('2 run(s) within 15 min of the 75-minute cap (slowest 66 min, run 9)');
  });

  it('a matrix job is still watched', async () => {
    const { gh } = fakeGh([run(6, 90)], { 6: [job(6, 41 * 60, { conclusion: 'cancelled', name: 'ios (iPhone 17)' })] });
    expect(await main({ gh, now: NOW, workflow: workflow('40') })).toBe(1);
    expect(log[0]).toContain('1 run(s) within 15 min of the 40-minute cap (slowest 41 min, run 6)');
  });

  it('reads against whatever cap the workflow has today', async () => {
    const { gh } = fakeGh([run(5, 45)], { 5: [job(5, 41 * 60, { conclusion: 'cancelled' })] });
    expect(await main({ gh, now: NOW, workflow: workflow('40') })).toBe(1);
    expect(log[0]).toMatch(/^ACTION ios CI: 1 run\(s\) within 15 min of the 40-minute cap \(slowest 41 min, run 5\)/);
  });

  it('nothing near the cap: a status line and exit 0, no ACTION', async () => {
    const { gh } = fakeGh([run(1, 40), run(2, 70)], { 2: [job(2, 38 * 60)] });
    expect(await main({ gh, now: NOW, workflow: workflow() })).toBe(0);
    expect(log).toEqual(['   no built ios run within 15 min of the 75-minute cap in 7 days (2 CI runs)']);
  });

  it("cannot list runs: exit 2, a skipped status line naming gh's own error, never an ACTION", async () => {
    // The shape execFile rejects with: the command line in the message, what
    // gh said on stderr.
    const failed = Object.assign(new Error('Command failed: /opt/homebrew/bin/gh run list --workflow ci.yml'), {
      stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n',
    });
    const { gh } = fakeGh(failed, {});
    expect(await main({ gh, now: NOW, workflow: workflow() })).toBe(2);
    expect(log).toEqual(['   could not list CI runs (HTTP 401: Bad credentials (https://api.github.com/graphql)) — ios CI headroom skipped']);

    log.length = 0;
    expect(await main({ gh: fakeGh(new Error('spawn gh ENOENT'), {}).gh, now: NOW, workflow: workflow() })).toBe(2);
    expect(log).toEqual(['   could not list CI runs (spawn gh ENOENT) — ios CI headroom skipped']);
  });

  it('a run whose jobs cannot be read is reported, and the rest still count', async () => {
    const runs = [run(1, 90), run(2, 90)];
    const failing = { 1: new Error('HTTP 502'), 2: [job(2, 62 * 60)] };
    expect(await main({ gh: fakeGh(runs, failing).gh, now: NOW, workflow: workflow() })).toBe(1);
    expect(log).toEqual([
      expect.stringMatching(/^ACTION ios CI: 1 run\(s\) .* \(slowest 62 min, run 2\)/),
      '   1 of 2 long CI run(s) could not be read — ios CI headroom partly skipped',
    ]);

    log.length = 0;
    const quiet = { 1: new Error('HTTP 502'), 2: [job(2, 30 * 60)] };
    // Partly blind is not all-clear: 2, and no "no built ios run" line.
    expect(await main({ gh: fakeGh(runs, quiet).gh, now: NOW, workflow: workflow() })).toBe(2);
    expect(log).toEqual(['   1 of 2 long CI run(s) could not be read — ios CI headroom partly skipped']);
  });

  it('a workflow it cannot read is an ACTION, before any API call', async () => {
    const { gh } = fakeGh([], {});
    expect(await main({ gh, now: NOW, workflow: workflow().replace('Build and test', 'Test') })).toBe(1);
    expect(log[0]).toMatch(/^ACTION ios CI headroom is unwatched: .*no "Build and test" step/);
    expect(gh).not.toHaveBeenCalled();
  });
});
