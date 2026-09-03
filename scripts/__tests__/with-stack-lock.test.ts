import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../with-stack-lock.sh', import.meta.url));
const lockDir = mkdtempSync(join(tmpdir(), 'stack-lock-'));
const lock = join(lockDir, 'stack.lock.d');
const holder = join(lockDir, 'stack.lock.holder');

// APEX_STACK_LOCK_DIR keeps the tests out of the real primary-checkout lock;
// stripping APEX_STACK_LOCKED matters because this suite itself may run
// under agent:check:full's lock, which would otherwise short-circuit it.
const baseEnv: NodeJS.ProcessEnv = { ...process.env, APEX_STACK_LOCK_DIR: lockDir };
delete baseEnv.APEX_STACK_LOCKED;

afterAll(() => rmSync(lockDir, { recursive: true, force: true }));

function waitFor(cond: () => boolean, ms: number) {
  return new Promise<void>((res, rej) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (cond()) {
        clearInterval(id);
        res();
      } else if (Date.now() - t0 > ms) {
        clearInterval(id);
        rej(new Error('timed out waiting for the lock holder note'));
      }
    }, 25);
  });
}

/** A pid that is certainly not running: spawn a process and wait for it to exit. */
function deadPid(): number {
  const p = spawnSync('true');
  if (p.pid === undefined) throw new Error('could not spawn a throwaway process');
  return p.pid;
}

describe('with-stack-lock', () => {
  it('runs the command, forwards output, and propagates the exit code', () => {
    const ok = spawnSync(script, ['echo', 'through the lock'], { env: baseEnv, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('through the lock');

    const fail = spawnSync(script, ['sh', '-c', 'exit 7'], { env: baseEnv, encoding: 'utf8' });
    expect(fail.status).toBe(7);
  });

  it('needs no flock: the lock is a directory that comes and goes with the command', () => {
    const during = spawnSync(script, ['sh', '-c', `test -d "${lock}" && cat "${lock}/pid"`], {
      env: baseEnv,
      encoding: 'utf8',
    });
    expect(during.status).toBe(0);
    expect(during.stdout.trim()).toMatch(/^\d+$/);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(holder)).toBe(false);
  });

  it('a contender is told who holds the lock; an already-locked chain passes through', async () => {
    const first = spawn(script, ['sh', '-c', 'sleep 2'], { env: baseEnv });
    const done = new Promise<void>((res) => first.on('exit', () => res()));
    await waitFor(() => existsSync(holder), 2000);

    const second = spawnSync(script, ['true'], {
      env: { ...baseEnv, APEX_STACK_LOCK_WAIT: '0' },
      encoding: 'utf8',
    });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/locked by: pid/);
    expect(second.stderr).toMatch(/gave up after 0s/);

    // Re-entrancy: db:reset-local under agent:check:full must not deadlock
    // against its own chain's lock.
    const nested = spawnSync(script, ['echo', 'nested ok'], {
      env: { ...baseEnv, APEX_STACK_LOCKED: '1' },
      encoding: 'utf8',
    });
    expect(nested.status).toBe(0);
    expect(nested.stdout).toContain('nested ok');

    await done;
  });

  it('a contender waits for a live holder and then runs', async () => {
    const first = spawn(script, ['sh', '-c', 'sleep 2'], { env: baseEnv });
    const done = new Promise<void>((res) => first.on('exit', () => res()));
    await waitFor(() => existsSync(holder), 2000);

    const t0 = Date.now();
    const second = spawnSync(script, ['echo', 'queued ok'], {
      env: { ...baseEnv, APEX_STACK_LOCK_WAIT: '10' },
      encoding: 'utf8',
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('queued ok');
    expect(second.stderr).toMatch(/locked by: pid/);
    expect(Date.now() - t0).toBeGreaterThan(500);

    await done;
  });

  it('reaps a lock whose holder is dead instead of waiting on it', () => {
    mkdirSync(lock, { recursive: true });
    const pid = deadPid();
    writeFileSync(join(lock, 'pid'), `${pid}\n`);
    writeFileSync(holder, `pid ${pid} in /nowhere since long ago: sleep forever\n`);

    const run = spawnSync(script, ['echo', 'after reap'], {
      env: { ...baseEnv, APEX_STACK_LOCK_WAIT: '0' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('after reap');
    expect(run.stderr).toMatch(new RegExp(`stale stack lock from dead pid ${pid}`));
    expect(existsSync(lock)).toBe(false);
  });

  it('does not reap a lock directory that has no pid yet (holder mid-acquire)', () => {
    mkdirSync(lock, { recursive: true });
    try {
      const run = spawnSync(script, ['true'], {
        env: { ...baseEnv, APEX_STACK_LOCK_WAIT: '0' },
        encoding: 'utf8',
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/holder note missing/);
      expect(existsSync(lock)).toBe(true);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it('records the holder note with pid, cwd and command', async () => {
    const first = spawn(script, ['sh', '-c', 'sleep 1'], { env: baseEnv });
    const done = new Promise<void>((res) => first.on('exit', () => res()));
    await waitFor(() => existsSync(holder), 2000);
    const note = readFileSync(holder, 'utf8');
    expect(note).toMatch(/^pid \d+ in \S+ since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}: sh -c sleep 1$/m);
    await done;
  });
});
