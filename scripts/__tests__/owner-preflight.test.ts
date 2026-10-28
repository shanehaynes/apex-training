import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

const run = (cmd: string, env: Record<string, string> = {}) => {
  const base = { ...process.env, ...gitEnv };
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete base[k];
  const r = spawnSync('bash', [join(repo, 'scripts/owner-preflight.sh'), cmd], { env: { ...base, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
};

describe('owner-preflight.sh', () => {
  it('a clean primary on main takes the lock, and a second run is refused until release', () => {
    expect(run('acquire')).toMatchObject({ code: 0, out: expect.stringContaining('lock taken') });
    expect(run('acquire')).toMatchObject({ code: 6, out: expect.stringContaining('another owner run holds the lock') });
    expect(run('release').code).toBe(0);
    expect(run('acquire').code).toBe(0);
  });

  it.each(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'])('refuses when %s is set (API billing)', (v) => {
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
    const lock = join(repo, '.claude/state/owner.lock.d');
    writeFileSync(join(lock, 'since'), String(Math.floor(Date.now() / 1000) - 5 * 3600));
    const r = run('acquire');
    expect(r.code).toBe(0);
    expect(r.out).toContain('clearing a stale lock');
  });

  it('a lock mid-acquire (no timestamp yet) is not reaped', () => {
    mkdirSync(join(repo, '.claude/state/owner.lock.d'), { recursive: true });
    expect(run('acquire')).toMatchObject({ code: 6, out: expect.stringContaining('right now') });
    const old = Date.now() / 1000 - 600;
    utimesSync(join(repo, '.claude/state/owner.lock.d'), old, old);
    expect(run('acquire').code).toBe(0);
  });

  it('an unknown command is a usage error', () => {
    expect(run('go').code).toBe(64);
  });
});
