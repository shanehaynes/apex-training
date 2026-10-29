import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const BILLING = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const run = (cmd: string, env: Record<string, string> = {}, ...args: string[]) => {
  const base = { ...process.env, ...gitEnv };
  for (const k of BILLING) delete base[k];
  const r = spawnSync('bash', [join(repo, 'scripts/owner-preflight.sh'), cmd, ...args], { env: { ...base, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
};

describe('owner-preflight.sh', () => {
  const tokenOf = (out: string) => /token=(\S+)/.exec(out)?.[1] ?? '';
  const lockPath = () => join(repo, '.claude/state/owner.lock');
  // Rewrite the lock's timestamp, keeping its token: the lock is the symlink "<since>.<token>".
  const age = (secs: number) => {
    const token = readlinkSync(lockPath()).replace(/^\d+\./, '');
    rmSync(lockPath());
    symlinkSync(`${Math.floor(Date.now() / 1000) - secs}.${token}`, lockPath());
  };

  it('a clean primary on main takes the lock, and a second run is refused until release', () => {
    const first = run('acquire');
    expect(first).toMatchObject({ code: 0, out: expect.stringContaining('lock taken') });
    expect(run('acquire')).toMatchObject({ code: 6, out: expect.stringContaining('another owner run holds the lock') });
    expect(run('release', {}, tokenOf(first.out)).code).toBe(0);
    expect(run('acquire').code).toBe(0);
  });

  it("release refuses without the lock's own token, so a reaped run cannot free the next run's lock", () => {
    const first = run('acquire');
    expect(run('release').code).toBe(7);
    expect(run('release', {}, 'someone-else').code).toBe(7);
    age(5 * 3600);
    const second = run('acquire');
    expect(second.code).toBe(0);
    expect(run('release', {}, tokenOf(first.out))).toMatchObject({ code: 7, out: expect.stringContaining('not this run') });
    expect(run('release', {}, tokenOf(second.out)).code).toBe(0);
  });

  it('check-off reports a kill switch that appears mid-run', () => {
    expect(run('check-off').code).toBe(0);
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude/OWNER_OFF'), '');
    expect(run('check-off').code).toBe(4);
  });

  it('the stale window is under the 4-hour cadence: a lock from 3h30m ago holds, 3h50m ago is reaped', () => {
    run('acquire');
    age(210 * 60);
    expect(run('acquire').code).toBe(6);
    age(230 * 60);
    expect(run('acquire').code).toBe(0);
  });

  it('a lock with a garbage target is stale, not a crash', () => {
    mkdirSync(join(repo, '.claude/state'), { recursive: true });
    symlinkSync('garbage', lockPath());
    expect(run('acquire')).toMatchObject({ code: 0, out: expect.stringContaining('cleared a stale lock') });
  });

  it('of several runs reaping one stale lock at once, exactly one wins and every loser says why', async () => {
    mkdirSync(join(repo, '.claude/state'), { recursive: true });
    const base = { ...process.env, ...gitEnv };
    for (const k of BILLING) delete base[k];
    for (let round = 0; round < 25; round++) {
      rmSync(lockPath(), { force: true });
      symlinkSync('1.stale', lockPath());
      const procs = [0, 1, 2, 3].map(() => new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn('bash', [join(repo, 'scripts/owner-preflight.sh'), 'acquire'], { env: base });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', (code) => resolve({ code, out }));
      }));
      const results = await Promise.all(procs);
      expect(results.filter((r) => r.code === 0), JSON.stringify(results)).toHaveLength(1);
      for (const r of results.filter((x) => x.code !== 0)) {
        expect(r.code).toBe(6);
        expect(r.out).toMatch(/refused/);
      }
    }
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

  it('refuses a dirty primary', () => {
    writeFileSync(join(repo, 'stray.txt'), 'x');
    expect(run('acquire')).toMatchObject({ code: 5, out: expect.stringContaining('dirty') });
  });

  it('refuses a primary off main', () => {
    git('checkout', '-qb', 'other');
    expect(run('acquire')).toMatchObject({ code: 5, out: expect.stringContaining('on other, not main') });
  });

  it('clears a lock older than one cadence', () => {
    expect(run('acquire').code).toBe(0);
    age(5 * 3600);
    const r = run('acquire');
    expect(r.code).toBe(0);
    expect(r.out).toContain('cleared a stale lock');
  });

  it('refuses a detached primary and a modified tracked file', () => {
    git('checkout', '-q', '--detach');
    expect(run('acquire')).toMatchObject({ code: 5, out: expect.stringContaining('(detached)') });
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, '.gitignore'), 'changed\n');
    expect(run('acquire').code).toBe(5);
  });

  it('an unknown command is a usage error', () => {
    expect(run('go').code).toBe(64);
  });
});
