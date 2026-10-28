// The `changes` job in ci.yml decides whether `ios` must run. A wrong `false`
// skips `ios` at job level, and a skipped job passes a required check, so the
// decision is tested here by running the exact script ci.yml holds between
// its ios-paths markers. The real runs recorded in
// docs/specs/ios-required-check.md prove the wiring around it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ciYml = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
const BEGIN = '# ios-paths:begin';
const END = '# ios-paths:end';

/** The script between the markers, dedented to the markers' indent. */
function markedScript(text: string): string {
  const lines = text.split('\n');
  const at = (marker: string) => {
    const hits = lines.flatMap((l, i) => (l.trim() === marker ? [i] : []));
    if (hits.length !== 1) throw new Error(`ci.yml has ${hits.length} \`${marker}\` lines, not one`);
    return hits[0];
  };
  const begin = at(BEGIN);
  const end = at(END);
  if (end <= begin + 1) throw new Error('nothing between the ios-paths markers');
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
  const steps = lines.indexOf('    steps:');
  if (steps < 0) throw new Error(`the \`${name}\` job has no steps`);
  return lines.slice(0, steps);
}

/** The lines of the job step that holds `marker` at 8 spaces, from its `- ` line up to the next step. */
function stepLines(text: string, job: string, marker: string): string[] {
  const lines = jobLines(text, job);
  const at = lines.indexOf(marker);
  if (at < 0) throw new Error(`no \`${marker.trim()}\` in the \`${job}\` job`);
  let start = at;
  while (start > 0 && !lines[start].startsWith('      - ')) start--;
  let end = lines.findIndex((l, i) => i > at && /^ {0,6}\S/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

// Extracted before any temp directory exists, so a missing marker fails the
// file without leaving one behind.
const scriptText = markedScript(ciYml);
const work = mkdtempSync(join(tmpdir(), 'ci-ios-paths-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const script = join(work, 'ios-paths.sh');
writeFileSync(script, scriptText);

// No GIT_* from the caller (a hook's GIT_DIR would point every command below
// at the real repository), and no user or system config.
const gitEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
Object.assign(gitEnv, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(cwd: string, path: string, content = `${path}\n`) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

function commit(cwd: string, message: string) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
}

let repos = 0;
/** main with a web file, an iOS file and ci.yml, published as origin/main; HEAD on a `pr` branch. */
function repo(): string {
  const dir = join(work, `repo-${++repos}`);
  mkdirSync(dir);
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write(dir, 'src/app.ts');
  write(dir, 'ios/Apex/App.swift');
  write(dir, '.github/workflows/ci.yml', 'name: CI\n');
  commit(dir, 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'pr');
  return dir;
}

/** Runs the marked script the way a default `run:` step does (bash -e). */
function decide(cwd: string, event: string) {
  const output = join(cwd, '.github-output');
  writeFileSync(output, '');
  const r = spawnSync('bash', ['-e', script], {
    cwd,
    env: { ...gitEnv, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr, output: readFileSync(output, 'utf8') };
}

describe('the ios-paths script in ci.yml', () => {
  it('is between exactly one pair of markers, and the test fails without them', () => {
    expect(markedScript(ciYml)).toContain('git merge-base origin/main HEAD');
    expect(() => markedScript(ciYml.replace(BEGIN, '# begin'))).toThrow(/0 `# ios-paths:begin` lines/);
    expect(() => markedScript(ciYml.replace(END, '# end'))).toThrow(/0 `# ios-paths:end` lines/);
  });

  it('is the whole run block of the `changes` step whose output gates `ios`', () => {
    // Nothing runs outside the markers: a line above `begin` would never be tested.
    const step = stepLines(ciYml, 'changes', '        id: paths');
    const run = step.indexOf('        run: |');
    expect(run).toBeGreaterThan(-1);
    const body = step.slice(run + 1).filter((l) => l.trim());
    expect(body.every((l) => l.startsWith('          '))).toBe(true);
    expect(body[0].trim()).toBe(BEGIN);
    expect(body.at(-1)?.trim()).toBe(END);
    // The default shell (bash -e), no env override, no condition: id and run only.
    const keys = step.slice(1).flatMap((l) => /^ {8}([\w-]+):/.exec(l)?.[1] ?? []);
    expect(keys.sort()).toEqual(['id', 'run']);

    const head = jobHead(ciYml, 'changes');
    expect(head).toContain('    runs-on: ubuntu-latest');
    expect(head).toContain('    timeout-minutes: 5');
    expect(head).toContain('    outputs:');
    expect(head).toContain('      ios: ${{ steps.paths.outputs.ios }}');
    expect(head.some((l) => /^ {4}if:/.test(l))).toBe(false);
    // Without the full history origin/main is never fetched and the merge base fails.
    expect(jobLines(ciYml, 'changes').join('\n')).toContain(
      '    steps:\n      - uses: actions/checkout@v7\n        with:\n          fetch-depth: 0\n',
    );
  });

  it('gates `ios` at job level, skipping only on a successful false, and fails closed first', () => {
    const head = jobHead(ciYml, 'ios');
    expect(head).toContain('    needs: changes');
    expect(head).toContain(
      "    if: ${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.ios != 'false') }}",
    );
    expect(head.filter((l) => /^ {4}if:/.test(l))).toHaveLength(1);

    const ios = jobLines(ciYml, 'ios');
    expect(ios.join('\n')).not.toContain('env.skip');
    const first = ios.slice(ios.indexOf('    steps:') + 1).filter((l) => !/^\s*(#|$)/.test(l));
    expect(first[0]).toMatch(/^ {6}- name: /);
    expect(first[1]).toBe("        if: needs.changes.result != 'success'");
    expect(first[2]).toBe('        run: |');
    expect(first[3]).toMatch(/^ {10}echo "::error::The changes job /);
    expect(first[4]).toBe('          exit 1');
  });

  it('web-only change: false, diffed from the merge base rather than main tip', () => {
    const dir = repo();
    write(dir, 'src/app.ts', 'changed\n');
    commit(dir, 'web change');
    // main moves on with an iOS change after the PR forked; it is not the PR's.
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'ios/Apex/App.swift', 'main moved\n');
    commit(dir, 'ios on main');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', 'pr');

    for (const event of ['pull_request', 'merge_group']) {
      const r = decide(dir, event);
      expect(r.status, r.stderr).toBe(0);
      expect(r.output).toBe('ios=false\n');
    }
  });

  it('a file under ios/: true', () => {
    const dir = repo();
    write(dir, 'ios/Apex/New.swift');
    commit(dir, 'ios change');
    const r = decide(dir, 'pull_request');
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toBe('ios=true\n');
  });

  it('.github/workflows/ci.yml: true', () => {
    const dir = repo();
    write(dir, '.github/workflows/ci.yml', 'name: CI\n# coach-gate edit\n');
    commit(dir, 'ci change');
    const r = decide(dir, 'pull_request');
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toBe('ios=true\n');
  });

  it('push event with an empty diff: true, and so is every other event, where a pull request would skip', () => {
    const dir = repo();
    git(dir, 'checkout', '-q', 'main');
    for (const event of ['push', 'schedule', 'workflow_dispatch', '']) {
      const r = decide(dir, event);
      expect(r.status, r.stderr).toBe(0);
      expect(r.output, `event "${event}"`).toBe('ios=true\n');
    }
    // The same tree as a pull request skips, so the event is what decided.
    expect(decide(dir, 'pull_request').output).toBe('ios=false\n');
  });

  it('no merge base: true', () => {
    const dir = repo();
    write(dir, 'src/app.ts', 'changed\n');
    commit(dir, 'web change');
    git(dir, 'checkout', '-q', '--orphan', 'unrelated');
    git(dir, 'rm', '-rqf', '.');
    write(dir, 'README.md');
    commit(dir, 'unrelated root');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', 'pr');

    const r = decide(dir, 'pull_request');
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toBe('ios=true\n');
  });
});
