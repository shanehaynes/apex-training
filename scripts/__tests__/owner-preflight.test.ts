import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The owner loop's gate in a throwaway primary checkout: every refusal exits
// with its own code and says why, and a clean state takes the lock once.
const script = fileURLToPath(new URL('../owner-preflight.sh', import.meta.url));
const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

let repo: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, ...gitEnv } });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'apex-owner-'));
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(script, join(repo, 'scripts/owner-preflight.sh'));
  writeFileSync(join(repo, '.gitignore'), '.claude/state/\n.claude/OWNER_OFF\n.claude/AUTOMERGE_OFF\n');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
});
const holders: string[] = [];
afterEach(() => {
  // Every holder a test started dies with the test, released or not.
  for (const pid of holders.splice(0)) {
    try { execFileSync('bash', ['-c', `kill $(pgrep -P ${pid}) ${pid} 2>/dev/null || true`]); } catch { /* gone */ }
  }
  rmSync(repo, { recursive: true, force: true });
});

const BILLING = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const baseEnv = () => {
  const base: Record<string, string | undefined> = { ...process.env, ...gitEnv, OWNER_LOCK_MAX_SECS: '30' };
  for (const k of BILLING) delete base[k];
  return base;
};
const tokenOf = (out: string) => /token=(\d+)/.exec(out)?.[1] ?? '';
const run = (cmd: string, env: Record<string, string> = {}, ...args: string[]) => {
  const r = spawnSync('bash', [join(repo, 'scripts/owner-preflight.sh'), cmd, ...args], { env: { ...baseEnv(), ...env }, encoding: 'utf8' });
  const token = tokenOf(r.stdout);
  if (token) holders.push(token);
  return { code: r.status, out: r.stdout, token };
};
const alive = (pid: string) => spawnSync('kill', ['-0', pid]).status === 0;

describe('owner-preflight.sh', { timeout: 60_000 }, () => {
  it('a clean primary on main takes the lock, and a second run is refused until release', () => {
    const first = run('acquire');
    expect(first).toMatchObject({ code: 0, out: expect.stringContaining('lock taken') });
    expect(run('acquire')).toMatchObject({ code: 6, out: expect.stringContaining('another owner run holds the lock') });
    expect(run('release', {}, first.token).code).toBe(0);
    expect(run('acquire').code).toBe(0);
  });

  it('release kills the holder and its child, so nothing keeps the Mac awake after the run', () => {
    const first = run('acquire');
    const kids = spawnSync('pgrep', ['-P', first.token], { encoding: 'utf8' }).stdout.trim();
    expect(run('release', {}, first.token).code).toBe(0);
    expect(alive(first.token)).toBe(false);
    for (const k of kids.split('\n').filter(Boolean)) expect(alive(k)).toBe(false);
  });

  it("release refuses anything but this lock's holder", () => {
    run('acquire');
    expect(run('release').code).toBe(7);
    expect(run('release', {}, String(process.pid))).toMatchObject({ code: 7, out: expect.stringContaining('not this lock') });
    expect(run('release', {}, '999999').code).toBe(7);
  });

  it('a run that never releases frees the lock when its holder expires', () => {
    expect(run('acquire', { OWNER_LOCK_MAX_SECS: '2' }).code).toBe(0);
    expect(run('acquire').code).toBe(6);
    spawnSync('sleep', ['3']);
    expect(run('acquire').code).toBe(0);
  });

  it('the default lifetime is under the 4-hour cadence and above the 3h30m run budget', () => {
    const src = execFileSync('cat', [script], { encoding: 'utf8' });
    const max = Number(/OWNER_LOCK_MAX_SECS:-(\d+)/.exec(src)?.[1]);
    expect(max).toBeLessThan(4 * 3600);
    expect(max).toBeGreaterThan(3.5 * 3600);
  });

  it('of several runs at once, exactly one takes the lock and every other says why', async () => {
    for (let round = 0; round < 3; round++) {
      const procs = [0, 1, 2, 3].map(() => new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn('bash', [join(repo, 'scripts/owner-preflight.sh'), 'acquire'], { env: baseEnv() });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
      }));
      const results = await Promise.all(procs);
      const winners = results.filter((r) => r.code === 0);
      expect(winners, JSON.stringify(results)).toHaveLength(1);
      for (const r of results.filter((x) => x.code !== 0)) expect(r).toMatchObject({ code: 6, out: expect.stringContaining('refused') });
      expect(run('release', {}, tokenOf(winners[0].out)).code).toBe(0);
    }
  });

  it('check-off reports a kill switch that appears mid-run', () => {
    expect(run('check-off').code).toBe(0);
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude/OWNER_OFF'), '');
    expect(run('check-off').code).toBe(4);
  });

  it.each(BILLING)('refuses when %s is set (API billing)', (v) => {
    const r = run('acquire', { [v]: 'x' });
    expect(r.code).toBe(3);
    expect(r.out).toContain(`${v} is set`);
  });

  it.each(['OWNER_OFF', 'AUTOMERGE_OFF'])('refuses with the kill switch %s present', (f) => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', f), '');
    expect(run('acquire')).toMatchObject({ code: 4, out: expect.stringContaining(f) });
  });

  it('refuses a dirty primary, a modified tracked file, a primary off main, a detached primary', () => {
    writeFileSync(join(repo, 'stray.txt'), 'x');
    expect(run('acquire')).toMatchObject({ code: 5, out: expect.stringContaining('dirty') });
    rmSync(join(repo, 'stray.txt'));
    writeFileSync(join(repo, '.gitignore'), 'changed\n');
    expect(run('acquire').code).toBe(5);
    git('checkout', '-q', '.gitignore');
    git('checkout', '-qb', 'other');
    expect(run('acquire')).toMatchObject({ code: 5, out: expect.stringContaining('on other, not main') });
    git('checkout', '-q', '--detach');
    expect(run('acquire')).toMatchObject({ code: 5, out: expect.stringContaining('(detached)') });
  });

  it('an unknown command is a usage error', () => {
    expect(run('go').code).toBe(64);
  });
});
