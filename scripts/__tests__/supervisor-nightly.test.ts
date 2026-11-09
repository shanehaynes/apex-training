// supervisor.yml sweeps after CI's nightly instead of at a fixed hour, with a
// fallback cron for a day the nightly never ran. Its `nightly` job decides
// whether a run sweeps at all and whether the report opens with an ACTION
// about the nightly itself. A wrong `sweep=false` skips a day silently; a
// wrong `sweep=true` on the fallback cron reads main's newest run, where a
// green push run hides a red nightly. So the decision is tested here by
// running the exact script supervisor.yml holds between its nightly-check
// markers, against a gh stub that filters runs as gh does. The wiring around
// it (triggers, job conditions, outputs) is pinned as text: it only runs on
// GitHub.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const yml = readFileSync(fileURLToPath(new URL('../../.github/workflows/supervisor.yml', import.meta.url)), 'utf8');
const BEGIN = '# nightly-check:begin';
const END = '# nightly-check:end';

/** The script between the markers, dedented to the markers' indent. */
function markedScript(text: string): string {
  const lines = text.split('\n');
  const at = (marker: string) => {
    const hits = lines.flatMap((l, i) => (l.trim() === marker ? [i] : []));
    if (hits.length !== 1) throw new Error(`supervisor.yml has ${hits.length} \`${marker}\` lines, not one`);
    return hits[0];
  };
  const begin = at(BEGIN);
  const end = at(END);
  if (end <= begin + 1) throw new Error('nothing between the nightly-check markers');
  const indent = lines[begin].length - lines[begin].trimStart().length;
  const body = lines.slice(begin + 1, end);
  for (const l of body) {
    if (l.trim() && !l.startsWith(' '.repeat(indent))) throw new Error(`a line between the markers is outdented: ${l}`);
  }
  return body.map((l) => l.slice(indent)).join('\n') + '\n';
}

/** A top-level job's lines, up to the next job or top-level key. */
function jobLines(text: string, name: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`no \`${name}\` job`);
  let end = lines.findIndex((l, i) => i > start && /^ {0,2}[^\s#]/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

/** A job's own keys: its lines before `    steps:`. */
function jobHead(text: string, name: string): string[] {
  const lines = jobLines(text, name);
  return lines.slice(0, lines.indexOf('    steps:'));
}

/** The step of `job` that starts with `first` (a `      - ` line), up to the next step. */
function stepLines(text: string, job: string, first: string): string[] {
  const lines = jobLines(text, job);
  const start = lines.indexOf(first);
  if (start < 0) throw new Error(`no \`${first.trim()}\` step in the \`${job}\` job`);
  let end = lines.findIndex((l, i) => i > start && /^ {0,6}\S/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

/** A step's `run: |` block, dedented. */
function runBlock(step: string[]): string {
  const at = step.indexOf('        run: |');
  if (at < 0) throw new Error('the step has no `run: |` block');
  const body = step.slice(at + 1);
  const end = body.findIndex((l) => l.trim() && !l.startsWith('          '));
  return (end < 0 ? body : body.slice(0, end)).map((l) => l.slice(10)).join('\n') + '\n';
}

// Two calls: CI's run list (fixture.runs, filtered by --workflow, --event and
// --branch and cut to --limit, newest first, as gh does) and one run's view
// (fixture.views[id], or a failed call when absent). fixture.listFails fails
// the list. Like gh, an object carries only the fields --json names.
const GH_STUB = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const fixture = JSON.parse(readFileSync(process.env.GH_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.GH_FIXTURE + '.calls', JSON.stringify(args) + '\\n');
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const fields = (flag('--json') ?? '').split(',');
const pick = (o) => Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]]));
let data;
if (args[0] === 'run' && args[1] === 'list') {
  if (fixture.listFails) { process.stderr.write('HTTP 502: Bad Gateway'); process.exit(1); }
  let runs = flag('--workflow') === 'CI' ? fixture.runs : [];
  if (flag('--event')) runs = runs.filter((r) => r.event === flag('--event'));
  if (flag('--branch')) runs = runs.filter((r) => r.headBranch === flag('--branch'));
  data = runs.slice(0, Number(flag('--limit') ?? 20)).map(pick);
} else if (args[0] === 'run' && args[1] === 'view' && fixture.views && args[2] in fixture.views) {
  data = pick(fixture.views[args[2]]);
} else {
  process.stderr.write('HTTP 404: Not Found');
  process.exit(1);
}
const out = spawnSync('jq', ['-r', flag('--jq')], { input: JSON.stringify(data), encoding: 'utf8' });
process.stdout.write(out.stdout);
process.stderr.write(out.stderr);
process.exit(out.status ?? 1);
`;

type Run = { createdAt: string; event: string; headBranch: string };
type View = { jobs: { name: string }[]; conclusion: string };
type Fixture = { runs?: Run[]; views?: Record<string, View>; listFails?: boolean };

const HOUR = 3_600_000;
/** gh's timestamp form (no milliseconds) for `hours` ago. */
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ciRun = (hours: number, event = 'schedule'): Run => ({ createdAt: ago(hours), event, headBranch: 'main' });

const NIGHTLY_ID = '42499798880';
const MISSED = "action=ACTION CI's nightly has not run in 24 hours (newest: ";
const NO_JOB = `action=ACTION CI's nightly ran no job (run ${NIGHTLY_ID}, `;

let work: string;
let stubDir: string;
let script: string;
let cases = 0;

beforeAll(() => {
  // Without jq the stub cannot answer, and every case would read as gh failing.
  execOk('jq', ['--version']);
  const text = markedScript(yml);
  work = mkdtempSync(join(tmpdir(), 'apex-supervisor-nightly-'));
  stubDir = join(work, 'bin');
  mkdirSync(stubDir);
  writeFileSync(join(stubDir, 'gh'), GH_STUB);
  chmodSync(join(stubDir, 'gh'), 0o755);
  script = join(work, 'nightly-check.sh');
  writeFileSync(script, text);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

function execOk(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
}

/**
 * Runs the marked script the way a default `run:` step does (bash -e). After
 * the nightly, the job's env carries its run id and attempt (GitHub sends
 * `1` for a first attempt); on the fallback cron, neither.
 */
function check(fixture: Fixture, nightly?: { id: string; attempt: string }) {
  const dir = join(work, `case-${++cases}`);
  mkdirSync(dir);
  const fx = join(dir, 'fixture.json');
  writeFileSync(fx, JSON.stringify(fixture));
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, GH_FIXTURE: fx, GITHUB_OUTPUT: output };
  delete env.NIGHTLY_RUN_ID;
  delete env.NIGHTLY_ATTEMPT;
  if (nightly) Object.assign(env, { NIGHTLY_RUN_ID: nightly.id, NIGHTLY_ATTEMPT: nightly.attempt });
  const r = spawnSync('bash', ['-e', script], { cwd: dir, env, encoding: 'utf8' });
  const calls: string[][] = existsSync(`${fx}.calls`)
    ? readFileSync(`${fx}.calls`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    lines: readFileSync(output, 'utf8').split('\n').filter(Boolean),
    calls,
  };
}

describe('supervisor.yml nightly-check, on the fallback cron', () => {
  it("a nightly that started 3 hours ago: no sweep, and the log says which nightly's sweep stands", () => {
    const nightly = ciRun(3);
    const r = check({ runs: [nightly, ciRun(27)] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual(['sweep=false']);
    expect(r.stdout).toContain(`CI's nightly started at ${nightly.createdAt}`);
  });

  it('a nightly 23.5 hours old is still the last 24 hours: no sweep', () => {
    const r = check({ runs: [ciRun(23.5)] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual(['sweep=false']);
  });

  it('a nightly 24.5 hours old: sweep, opening with an ACTION that names it', () => {
    const nightly = ciRun(24.5);
    const r = check({ runs: [nightly] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([`${MISSED}${nightly.createdAt}), and with it evals and prod-checks — GitHub drops scheduled runs under load, and disables them in a public repository after 60 days without activity: gh run list --workflow CI --event schedule`, 'sweep=true']);
  });

  it('push and dispatch runs since do not count: only a scheduled run is a nightly', () => {
    const nightly = ciRun(30);
    const r = check({ runs: [ciRun(1, 'push'), ciRun(2, 'workflow_dispatch'), nightly] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines[0].startsWith(`${MISSED}${nightly.createdAt})`)).toBe(true);
    expect(r.lines.slice(1)).toEqual(['sweep=true']);
  });

  it('no scheduled run on record at all: sweep, and the ACTION says none', () => {
    const r = check({ runs: [ciRun(1, 'push')] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines[0].startsWith(`${MISSED}none)`)).toBe(true);
    expect(r.lines.slice(1)).toEqual(['sweep=true']);
  });

  it('runs cannot be listed: sweep without an ACTION, and warn', () => {
    const r = check({ runs: [ciRun(3)], listFails: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual(['sweep=true']);
    expect(r.stdout).toMatch(/^::warning::Could not list CI's scheduled runs/m);
  });

  it("asks for CI's scheduled runs on main, and reads no run's jobs", () => {
    const r = check({ runs: [ciRun(3)] });
    expect(r.calls).toHaveLength(1);
    const [call] = r.calls;
    expect(call.slice(0, 2)).toEqual(['run', 'list']);
    for (const [flag, value] of [['--workflow', 'CI'], ['--event', 'schedule'], ['--branch', 'main']]) {
      expect(call[call.indexOf(flag) + 1], flag).toBe(value);
    }
  });
});

describe('supervisor.yml nightly-check, after the nightly', () => {
  // Every case has a nightly a few minutes old on record: the 24-hour window
  // would say "no sweep" here, so a script that consulted it after the
  // nightly would skip the very sweep this trigger exists for.
  const recent = () => [ciRun(0.1), ciRun(24.1)];
  const first = { id: NIGHTLY_ID, attempt: '1' };
  const ran: View = { jobs: [{ name: 'check' }, { name: 'evals' }], conclusion: 'failure' };

  it('the nightly ran its jobs: sweep, no ACTION, and the run list is never read', () => {
    const r = check({ runs: recent(), views: { [NIGHTLY_ID]: ran } }, first);
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual(['sweep=true']);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].slice(0, 5)).toEqual(['run', 'view', NIGHTLY_ID, '--json', 'jobs,conclusion']);
  });

  it('cancelled before any job ran: sweep, opening with an ACTION that names the run and how it ended', () => {
    const r = check({ runs: recent(), views: { [NIGHTLY_ID]: { jobs: [], conclusion: 'cancelled' } } }, first);
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([
      `${NO_JOB}cancelled), so evals and prod-checks did not run tonight — a push that takes its place in main's queue cancels it this way`,
      'sweep=true',
    ]);
  });

  it('no job for another reason (ci.yml invalid on main): the ACTION carries that conclusion', () => {
    const r = check({ runs: recent(), views: { [NIGHTLY_ID]: { jobs: [], conclusion: 'startup_failure' } } }, first);
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines[0].startsWith(`${NO_JOB}startup_failure), `)).toBe(true);
    expect(r.lines.slice(1)).toEqual(['sweep=true']);
  });

  it('its jobs cannot be read: sweep without an ACTION, and warn', () => {
    const r = check({ runs: recent(), views: {} }, first);
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual(['sweep=true']);
    expect(r.stdout).toMatch(new RegExp(`^::warning::Could not read the jobs of CI run ${NIGHTLY_ID}`, 'm'));
  });

  it("a re-run of the nightly: no sweep, which would report main's newest run, not this one", () => {
    // A green push run created after the nightly would be the `── main`
    // block's verdict, and a clean sweep closes the issue over a red nightly.
    const r = check({ runs: [ciRun(0.5, 'push'), ...recent()], views: { [NIGHTLY_ID]: ran } }, { id: NIGHTLY_ID, attempt: '2' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual(['sweep=false']);
    expect(r.stdout).toContain(`CI run ${NIGHTLY_ID} is a re-run (attempt 2)`);
    expect(r.calls).toEqual([]);
  });
});

describe("supervisor.yml's wiring around nightly-check", () => {
  it('the markers hold the whole run block of the `nightly` job, and the test fails without them', () => {
    expect(() => markedScript(yml.replace(BEGIN, '# begin'))).toThrow(/0 `# nightly-check:begin` lines/);
    expect(() => markedScript(yml.replace(END, '# end'))).toThrow(/0 `# nightly-check:end` lines/);
    const step = stepLines(yml, 'nightly', '      - id: check');
    const body = runBlock(step).trimEnd().split('\n');
    expect(body[0]).toBe(BEGIN);
    expect(body.at(-1)).toBe(END);
    // The default shell (bash -e), no env override, no condition: id and run only.
    const keys = step.flatMap((l) => /^ {6}- ([\w-]+):|^ {8}([\w-]+):/.exec(l)?.slice(1).filter(Boolean) ?? []);
    expect(keys.sort()).toEqual(['id', 'run']);
  });

  it('runs after a CI run on main finishes, on the 23:00 fallback cron, and by hand', () => {
    const on = yml.split('\n');
    const from = on.indexOf('on:');
    const to = on.findIndex((l, i) => i > from && /^\S/.test(l));
    const keys = on.slice(from + 1, to).filter((l) => !/^\s*(#|$)/.test(l));
    expect(keys).toEqual([
      '  workflow_run:',
      '    workflows: [CI]',
      '    types: [completed]',
      '    branches: [main]',
      '  schedule:',
      "    - cron: '0 23 * * *'",
      '  workflow_dispatch:',
    ]);
  });

  it("names CI as ci.yml does, so a rename there fails here instead of silencing the sweep", () => {
    const ciYml = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
    const name = /^name: (.+)$/m.exec(ciYml)?.[1];
    expect(name).toBe('CI');
    expect(yml).toContain(`    workflows: [${name}]`);
    const named = [...markedScript(yml).matchAll(/--workflow (\S+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set([name]));
  });

  it('`nightly` runs on the fallback cron and after the nightly only, and knows which run and attempt that was', () => {
    const head = jobHead(yml, 'nightly');
    expect(head).toContain("    if: github.event_name == 'schedule' || github.event.workflow_run.event == 'schedule'");
    expect(head).toContain('      NIGHTLY_RUN_ID: ${{ github.event.workflow_run.id }}');
    expect(head).toContain('      NIGHTLY_ATTEMPT: ${{ github.event.workflow_run.run_attempt }}');
    expect(head).toContain('      sweep: ${{ steps.check.outputs.sweep }}');
    expect(head).toContain('      action: ${{ steps.check.outputs.action }}');
  });

  it("`sweep` waits on `nightly`, sweeps unless it said false, and never for another CI run's completion", () => {
    const head = jobHead(yml, 'sweep');
    expect(head).toContain('    needs: nightly');
    const at = head.indexOf('    if: >-');
    expect(at).toBeGreaterThan(-1);
    expect(head.slice(at + 1, at + 3)).toEqual([
      "      !cancelled() && needs.nightly.outputs.sweep != 'false' &&",
      "      (github.event_name != 'workflow_run' || github.event.workflow_run.event == 'schedule')",
    ]);
  });

  it('a run that sweeps nothing gets a concurrency group of its own', () => {
    expect(yml).toContain(
      "  group: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.event != 'schedule' && format('supervisor-{0}', github.run_id) || 'supervisor' }}",
    );
  });

  // The Sweep step's own run block, with the report script stubbed: the
  // nightly's ACTION must reach actions.txt, which files the issue and fails
  // the run, and its absence must add nothing.
  function sweepStep(nightlyAction: string, report: string) {
    const dir = join(work, `case-${++cases}`);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/supervisor-report.sh'), `#!/bin/sh\ncat <<'EOF'\n${report}\nEOF\n`);
    chmodSync(join(dir, 'scripts/supervisor-report.sh'), 0o755);
    const step = stepLines(yml, 'sweep', '      - name: Sweep');
    expect(step).toContain('          NIGHTLY_ACTION: ${{ needs.nightly.outputs.action }}');
    writeFileSync(join(dir, 'step.sh'), runBlock(step));
    const r = spawnSync('bash', ['-e', 'step.sh'], { cwd: dir, env: { ...process.env, NIGHTLY_ACTION: nightlyAction }, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, actions: readFileSync(join(dir, 'actions.txt'), 'utf8') };
  }

  it("the Sweep step puts the nightly's ACTION first in actions.txt", () => {
    const nightly = "ACTION CI's nightly has not run in 24 hours (newest: 2026-11-07T16:25:16Z)";
    const r = sweepStep(nightly, "── main\nACTION main's latest CI run is not green: failure  x  CI\n── backup\n   ok");
    expect(r.status, r.stderr).toBe(0);
    expect(r.actions).toBe(`${nightly}\nACTION main's latest CI run is not green: failure  x  CI\n`);
  });

  it('with no nightly ACTION, actions.txt is the report\'s alone, and a clean report leaves it empty', () => {
    const r = sweepStep('', "── main\n   green: success  x  CI");
    expect(r.status, r.stderr).toBe(0);
    expect(r.actions).toBe('');
  });
});
