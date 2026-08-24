import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../with-stack-lock.sh', import.meta.url));
const lockDir = mkdtempSync(join(tmpdir(), 'stack-lock-'));
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

describe('with-stack-lock', () => {
  it('runs the command, forwards output, and propagates the exit code', () => {
    const ok = spawnSync(script, ['echo', 'through the lock'], { env: baseEnv, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('through the lock');

    const fail = spawnSync(script, ['sh', '-c', 'exit 7'], { env: baseEnv, encoding: 'utf8' });
    expect(fail.status).toBe(7);
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
});
