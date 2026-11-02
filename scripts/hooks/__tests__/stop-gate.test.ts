import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain JS hook, run with bare node; no .d.mts on purpose (builtins only, like bash-guard)
import { decide, gateArgv, lanePaths, lanesFor, lastSleepMs, parseSleepTime, runGate, sessionPaths } from '../stop-gate.mjs';

const hook = fileURLToPath(new URL('../stop-gate.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../stop-gate.sh', import.meta.url));

// A real git topology in the OS temp dir: a bare origin with `main`, a primary
// clone, a second clone ("github", where squash-merges happen), and one linked
// worktree under .claude/worktrees — the shape git-new.sh produces. The hook
// shells out to git, so the fixture has to be real; the gate itself is
// injected (`run`) or, for the process tests, replaced by APEX_STOP_GATE_CMD.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'stop-gate-')));
const origin = join(base, 'origin.git');
const primary = join(base, 'primary');
const github = join(base, 'github');
const lane = join(primary, '.claude', 'worktrees', 'feat-a');
const sid = 'sess-1234';

// Isolate git from the machine: no signing, no hooks, a fixed identity.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
Object.assign(process.env, gitEnv); // the hook's own spawnSync inherits this (vitest isolates files per process)

function sh(cwd: string, cmd: string, args: string[], env: Record<string, string | undefined> = gitEnv) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}:\n${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}
const git = (cwd: string, ...args: string[]) => sh(cwd, 'git', args);

beforeAll(() => {
  writeFileSync(join(base, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  git(base, 'init', '--bare', '-b', 'main', origin);
  const seed = join(base, 'seed');
  git(base, 'init', '-b', 'main', seed);
  writeFileSync(join(seed, 'README'), 'seed\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', origin, 'main');
  git(base, 'clone', '-q', origin, primary);
  git(base, 'clone', '-q', origin, github);
  mkdirSync(join(primary, '.claude', 'worktrees'), { recursive: true });
  git(primary, 'worktree', 'add', '-q', lane, '-b', 'feat/a', 'origin/main');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const sp = sessionPaths(primary, sid);
const lp = lanePaths(primary, sid, lane);
const bind = (...lanes: string[]) => {
  mkdirSync(join(primary, '.claude', 'state', 'sessions'), { recursive: true });
  writeFileSync(sp.binding, lanes.join('\n') + '\n');
};
const count = () => (existsSync(lp.count) ? readFileSync(lp.count, 'utf8').trim() : null);

type Gate = { ok: boolean; timedOut?: boolean; tail: string; cmd: string; sleptAt?: number | null };
const gate = (ok: boolean, tail = ok ? 'all green' : 'FAIL src/x.test.ts > breaks', sleptAt: number | null = null) => {
  const calls: string[] = [];
  const run = async (wt: string): Promise<Gate> => {
    calls.push(wt);
    return { ok, timedOut: false, tail, cmd: 'fake-gate', sleptAt };
  };
  return { run, calls };
};
const stop = (run: (wt: string) => Promise<Gate>, input: Record<string, unknown> = {}) =>
  decide({ session_id: sid, cwd: primary, hook_event_name: 'Stop', ...input }, { primary, run });

describe('which lanes', () => {
  it('a session with no binding and a cwd outside any worktree is never gated', async () => {
    expect(lanesFor({ primary, sessionId: sid, cwd: primary })).toEqual([]);
    const g = gate(false);
    expect((await stop(g.run)).action).toBe('allow');
    expect(g.calls).toEqual([]);
  });
  it('a cwd inside a linked worktree is its own binding', () => {
    expect(lanesFor({ primary, sessionId: 'other', cwd: join(lane, 'src') })).toEqual([lane]);
  });
  it('the primary checkout is never a lane, even if bound; stale and duplicate lines are dropped', () => {
    mkdirSync(join(primary, '.claude', 'state', 'sessions'), { recursive: true });
    writeFileSync(sessionPaths(primary, 'p').binding, `${primary}\n${join(base, 'gone')}\n${lane}\n${lane}/\n`);
    expect(lanesFor({ primary, sessionId: 'p', cwd: primary })).toEqual([lane]);
  });
  it('a stop while background tasks run is a wait, not an end', async () => {
    bind(lane);
    writeFileSync(join(lane, 'wip.txt'), 'x\n');
    const g = gate(false);
    const v = await stop(g.run, { background_tasks: [{ id: 'abc' }] });
    expect(v.action).toBe('allow');
    expect(v.why).toMatch(/background/);
    rmSync(join(lane, 'wip.txt'));
  });
});

describe('the gate, in order', () => {
  it('a bound lane with no commits of its own may stop without running the gate', async () => {
    bind(lane);
    const g = gate(false);
    const v = await stop(g.run);
    expect(v.action).toBe('allow');
    expect(v.notes[0]).toMatch(/already in origin\/main/);
    expect(g.calls).toEqual([]);
  });

  it('1. dirty: blocks, lists the files, runs nothing, counts nothing', async () => {
    writeFileSync(join(lane, 'notes.txt'), 'scratch\n');
    const g = gate(true);
    const v = await stop(g.run);
    expect(v.action).toBe('block');
    expect(v.reason).toContain('notes.txt');
    expect(v.reason).toMatch(/[Cc]ommit/);
    expect(g.calls).toEqual([]);
    expect(count()).toBeNull();
  });

  it('3. red: blocks with the failing tail and the log path; budget 1/3 at this commit', async () => {
    git(lane, 'add', '.');
    git(lane, 'commit', '-q', '-m', 'wip');
    const sha = git(lane, 'rev-parse', 'HEAD');
    const g = gate(false);
    const v = await stop(g.run);
    expect(v.action).toBe('block');
    expect(g.calls).toEqual([lane]);
    expect(v.reason).toContain('gate is red');
    expect(v.reason).toContain('run 1/3');
    expect(v.reason).toContain('FAIL src/x.test.ts');
    expect(count()).toBe(`${sha} 1 1 0`);
    expect(existsSync(lp.green)).toBe(false);
  });

  it('red twice more spends the per-commit budget; then the gate stands aside and the push check still applies', async () => {
    const sha = git(lane, 'rev-parse', 'HEAD');
    expect((await stop(gate(false).run)).reason).toContain('run 2/3');
    expect((await stop(gate(false).run)).reason).toContain('run 3/3');
    expect(count()).toBe(`${sha} 3 3 0`);
    const g = gate(false);
    const v = await stop(g.run);
    expect(g.calls).toEqual([]); // stood aside
    expect(v.notes.join('\n')).toMatch(/stood aside/);
    expect(v.action).toBe('block');
    expect(v.reason).toMatch(/not on origin/); // the cap never silences the push check
    expect(v.reason).toContain('gate stood aside');
    writeFileSync(join(lane, 'dirty-again.txt'), 'z\n');
    expect((await stop(gate(false).run)).reason).toContain('dirty-again.txt'); // nor the dirty check
    rmSync(join(lane, 'dirty-again.txt'));
  });

  it('a new commit gets a fresh per-commit budget; green caches and clears the count', async () => {
    writeFileSync(join(lane, 'fix.txt'), 'x\n');
    git(lane, 'add', '.');
    git(lane, 'commit', '-q', '-m', 'fix');
    const sha = git(lane, 'rev-parse', 'HEAD');
    const g = gate(true);
    const v = await stop(g.run);
    expect(g.calls).toEqual([lane]);
    expect(v.action).toBe('block');
    expect(v.reason).toMatch(/not on origin/);
    expect(v.reason).toContain('push -u origin feat/a');
    expect(readFileSync(lp.green, 'utf8')).toBe(sha);
    expect(count()).toBeNull();
  });

  it('the session-wide budget stands the gate aside across commits', async () => {
    writeFileSync(join(lane, 'again.txt'), 'x\n');
    git(lane, 'add', '.');
    git(lane, 'commit', '-q', '-m', 'again');
    const sha = git(lane, 'rev-parse', 'HEAD');
    writeFileSync(lp.count, `${sha} 0 10`);
    const g = gate(false);
    const v = await stop(g.run);
    expect(g.calls).toEqual([]);
    expect(v.notes.join('\n')).toMatch(/10 this session/);
    rmSync(lp.count);
  });

  it('pushed under another name is not pushed', async () => {
    const g = gate(true);
    await stop(g.run); // green at this commit, blocked on push
    git(lane, 'push', '-q', 'origin', 'HEAD:refs/heads/other-name');
    const v = await stop(gate(false).run);
    expect(v.action).toBe('block');
    expect(v.reason).toContain('branch feat/a is not on origin');
    git(lane, 'push', '-q', 'origin', '--delete', 'other-name');
  });

  it('origin/<branch> behind HEAD is unpushed even when the new commits sit under another remote ref', async () => {
    git(lane, 'push', '-q', '-u', 'origin', 'feat/a');
    writeFileSync(join(lane, 'behind.txt'), 'x\n');
    git(lane, 'add', '.');
    git(lane, 'commit', '-q', '-m', 'behind');
    git(lane, 'push', '-q', 'origin', 'HEAD:refs/heads/other-name');
    const v = await stop(gate(true).run);
    expect(v.action).toBe('block');
    expect(v.reason).toContain('1 commit(s) not on origin');
    git(lane, 'push', '-q', 'origin', '--delete', 'other-name');
  });

  it('pushed: allows, and the cached green run is not repeated', async () => {
    git(lane, 'push', '-q', '-u', 'origin', 'feat/a');
    const g = gate(false); // would be red if it ran
    const v = await stop(g.run);
    expect(v.action).toBe('allow');
    expect(v.why).toBe('clean, green, pushed');
    expect(g.calls).toEqual([]);
  });

  it('after a squash-merge, a deleted remote branch and a prune, the lane is done, not unpushed', async () => {
    git(github, 'fetch', '-q', 'origin');
    git(github, 'merge', '-q', '--squash', 'origin/feat/a');
    git(github, 'commit', '-q', '-m', 'feat a (#1)');
    git(github, 'push', '-q', 'origin', 'main');
    git(github, 'push', '-q', 'origin', '--delete', 'feat/a');
    git(primary, 'fetch', '-q', '--prune', 'origin');
    expect(() => git(lane, 'rev-parse', '--verify', 'refs/remotes/origin/feat/a')).toThrow();
    const g = gate(false);
    const v = await stop(g.run);
    expect(v.action).toBe('allow');
    expect(v.notes[0]).toMatch(/already in origin\/main/);
    expect(g.calls).toEqual([]);
  });
});

describe('a red run the Mac slept through', () => {
  const commit = (name: string) => {
    writeFileSync(join(lane, name), 'x\n');
    git(lane, 'add', '.');
    git(lane, 'commit', '-q', '-m', name);
    return git(lane, 'rev-parse', 'HEAD');
  };
  const timeouts = 'Error: page.goto: Timeout 30000ms exceeded.';
  const asleep = () => gate(false, timeouts, Date.now() - 60_000).run;

  it('blocks with the tail, says the Mac slept, and charges nothing', async () => {
    const sha = commit('slept-1.txt');
    const v = await stop(asleep());
    expect(v.action).toBe('block');
    expect(v.reason).toMatch(/the gate is red at \w{7} \(`fake-gate`\), but the Mac went to sleep during the run \(at \d\d:\d\d:\d\d\)/);
    expect(v.reason).toContain('not charged to the red budget (uncharged run 1/3 for this commit; red runs still 0/3)');
    expect(v.reason).toContain(timeouts);
    expect(v.reason).toContain(lp.log);
    expect(count()).toBe(`${sha} 0 0 1`);
  });

  it('three per commit; past that a slept red counts like any red, and says so', async () => {
    const sha = git(lane, 'rev-parse', 'HEAD');
    expect((await stop(asleep())).reason).toContain('uncharged run 2/3');
    expect((await stop(asleep())).reason).toContain('uncharged run 3/3');
    expect(count()).toBe(`${sha} 0 0 3`);
    const v = await stop(asleep());
    expect(v.reason).toContain('run 1/3 for this commit');
    expect(v.reason).toContain('this commit has had its 3 uncharged runs, so this one counts');
    expect(count()).toBe(`${sha} 1 1 3`);
  });

  it('an awake red is charged as before; a new commit gets fresh uncharged runs and the session total carries', async () => {
    const sha = git(lane, 'rev-parse', 'HEAD');
    const v = await stop(gate(false).run);
    expect(v.reason).toContain('run 2/3 for this commit');
    expect(v.reason).not.toMatch(/sleep|uncharged/);
    expect(count()).toBe(`${sha} 2 2 3`);
    const next = commit('slept-2.txt');
    expect((await stop(asleep())).reason).toContain('uncharged run 1/3 for this commit; red runs still 0/3');
    expect(count()).toBe(`${next} 0 2 1`);
    const st = spawnSync('bash', [cli, 'status'], { cwd: primary, encoding: 'utf8', env: { ...gitEnv, CLAUDE_CODE_SESSION_ID: sid } });
    expect(st.status).toBe(0); // the count file has no newline; status used to die on it
    expect(st.stdout).toContain(`red runs: feat-a — 0 at ${next.slice(0, 7)}, 2 this session`);
    expect(st.stdout).toContain(`uncharged: feat-a — 1 at ${next.slice(0, 7)}, the Mac slept (cap 3)`);
  });

  it('a run the Mac slept through that passes is green', async () => {
    const sha = git(lane, 'rev-parse', 'HEAD');
    const v = await stop(gate(true, 'all green', Date.now() - 60_000).run);
    expect(readFileSync(lp.green, 'utf8')).toBe(sha);
    expect(count()).toBeNull();
    expect(v.reason).toMatch(/not on origin/);
  });
});

describe('knowing the Mac slept', () => {
  it('parseSleepTime reads `sysctl -n kern.sleeptime`; never slept, or junk, is null', () => {
    expect(parseSleepTime('{ sec = 1793624521, usec = 923212 } Mon Nov  2 08:02:01 2026\n')).toBe(1793624521923);
    expect(parseSleepTime('{ sec = 0, usec = 0 } Thu Jan  1 00:00:00 1970')).toBeNull();
    expect(parseSleepTime('')).toBeNull();
    expect(parseSleepTime('sysctl: unknown oid')).toBeNull();
  });

  it('off darwin there is nothing to ask', () => {
    expect(lastSleepMs({ platform: 'linux' })).toBeNull();
  });

  it.runIf(process.platform === 'darwin')('on a Mac the kernel answers with a time in the past, or null if it never slept', () => {
    const v = lastSleepMs();
    expect(v === null || (Number.isInteger(v) && v <= Date.now())).toBe(true);
    expect(v).toBe(parseSleepTime(spawnSync('/usr/sbin/sysctl', ['-n', 'kern.sleeptime'], { encoding: 'utf8' }).stdout));
  });

  it('runGate reports a sleep that began after the gate started, and logs it', async () => {
    const log = join(base, 'slept.gate.log');
    const g = await runGate(lane, { cmd: 'echo t; exit 1', platform: 'linux', logPath: log, timeoutMs: 10_000, lastSleep: () => Date.now() });
    expect(g.ok).toBe(false);
    expect(g.sleptAt).toEqual(expect.any(Number));
    expect(readFileSync(log, 'utf8')).toMatch(/\n\[stop-gate: the Mac went to sleep at \d\d:\d\d:\d\d, after the gate started at \d\d:\d\d:\d\d\]\n$/);
  });

  it('a sleep before the gate started, no answer, or a reader that throws reads as awake', async () => {
    const before = Date.now() - 1000;
    const readers = [
      () => before,
      () => null,
      () => {
        throw new Error('sysctl gone');
      },
    ];
    for (const lastSleep of readers) {
      expect(await runGate(lane, { cmd: 'echo t', platform: 'linux', timeoutMs: 10_000, lastSleep })).toMatchObject({ ok: true, sleptAt: null });
    }
  });

  it('by default runGate asks this machine, and a gate that stayed awake is not reported as slept', async () => {
    expect(await runGate(lane, { cmd: 'echo t', timeoutMs: 10_000 })).toMatchObject({ ok: true, sleptAt: null });
  });
});

describe('the gate command: held awake on a Mac', () => {
  // A fake caffeinate on an injected PATH, so the platform choice is tested
  // on any OS. It says it ran, drops -i -s, and execs the gate.
  const bin = join(base, 'bin');
  const noExec = join(base, 'bin-noexec');
  const empty = join(base, 'bin-empty');
  const cmd = 'npm run agent:check';
  const plain = { argv: ['sh', '-c', `(${cmd}) 2>&1`], shown: cmd };
  beforeAll(() => {
    for (const d of [bin, noExec, empty]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, 'caffeinate'), '#!/bin/sh\necho "held $1 $2"\nshift 2\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(join(noExec, 'caffeinate'), '', { mode: 0o644 });
  });

  it('darwin: the gate runs under the caffeinate found on PATH, holding idle and AC sleep off', () => {
    expect(gateArgv(cmd, { platform: 'darwin', PATH: `${empty}:${bin}` })).toEqual({
      argv: [join(bin, 'caffeinate'), '-i', '-s', 'sh', '-c', `(${cmd}) 2>&1`],
      shown: `caffeinate -i -s ${cmd}`,
    });
  });

  it('any other platform runs sh as before, even with caffeinate on PATH', () => {
    for (const platform of ['linux', 'win32', 'freebsd']) expect(gateArgv(cmd, { platform, PATH: bin })).toEqual(plain);
  });

  it('darwin without an executable caffeinate on PATH runs sh as before', () => {
    expect(gateArgv(cmd, { platform: 'darwin', PATH: empty })).toEqual(plain);
    expect(gateArgv(cmd, { platform: 'darwin', PATH: noExec })).toEqual(plain);
    expect(gateArgv(cmd, { platform: 'darwin', PATH: '' })).toEqual(plain);
  });

  it('a relative PATH entry or a directory named caffeinate is passed over', () => {
    // Relative to the test's cwd it finds the fake; spawn would resolve it
    // against the lane instead, so it must not count.
    expect(gateArgv(cmd, { platform: 'darwin', PATH: relative(process.cwd(), bin) })).toEqual(plain);
    mkdirSync(join(empty, 'caffeinate'), { recursive: true });
    expect(gateArgv(cmd, { platform: 'darwin', PATH: `${empty}:${bin}` }).argv[0]).toBe(join(bin, 'caffeinate'));
  });

  it('runGate spawns what gateArgv returns and reports the wrapped command', async () => {
    const g = await runGate(lane, { cmd: 'echo gate-ran; exit 3', platform: 'darwin', PATH: bin, timeoutMs: 10_000 });
    expect(g.ok).toBe(false); // the gate's status comes back through the wrapper
    expect(g.tail).toBe('held -i -s\ngate-ran');
    expect(g.cmd).toBe('caffeinate -i -s echo gate-ran; exit 3');
    const off = await runGate(lane, { cmd: 'echo gate-ran', platform: 'linux', PATH: bin, timeoutMs: 10_000 });
    expect(off).toMatchObject({ ok: true, tail: 'gate-ran', cmd: 'echo gate-ran' });
  });
});

describe('the deliberate exit', () => {
  it('`blocked` lets exactly one stop through and consumes the marker', async () => {
    writeFileSync(join(lane, 'new.txt'), 'x\n'); // dirty again, would block
    mkdirSync(sp.dir, { recursive: true });
    writeFileSync(sp.blocked, '2026-10-13T00:00:00Z — needs Shane: deletes prod rows\n');
    const g = gate(true);
    const v = await stop(g.run);
    expect(v.action).toBe('allow');
    expect(v.why).toContain('needs Shane');
    expect(existsSync(sp.blocked)).toBe(false);
    expect((await stop(g.run)).action).toBe('block'); // the one after is gated again
    rmSync(join(lane, 'new.txt'));
  });
});

describe('as a hook process', () => {
  const runHook = (input: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
    spawnSync('node', [hook], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...gitEnv, CLAUDE_PROJECT_DIR: primary, ...env },
    });
  const freshCommit = (name: string) => {
    writeFileSync(join(lane, name), 'x\n');
    git(lane, 'add', '.');
    git(lane, 'commit', '-q', '-m', name);
  };

  it('exit 2 with the reason on stderr when the lane is dirty', () => {
    writeFileSync(join(lane, 'dirty.txt'), 'x\n');
    const r = runHook({ session_id: sid, cwd: primary });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('dirty.txt');
    rmSync(join(lane, 'dirty.txt'));
  });

  it('runs the real gate command from APEX_STOP_GATE_CMD, in order, and reports red', () => {
    freshCommit('p1.txt');
    const r = runHook({ session_id: sid, cwd: primary }, { APEX_STOP_GATE_CMD: 'echo out1; echo err1 >&2; echo out2; exit 1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('gate is red');
    expect(r.stderr).toMatch(/out1\s+err1\s+out2/); // stderr folded into stdout, in order
    expect(readFileSync(lp.log, 'utf8')).toContain('err1');
  });

  it('a timed-out gate leaves no processes behind, caffeinate included on a Mac', () => {
    freshCommit('p2.txt');
    // Each leaf carries the marker in argv, which ps shows on Linux and macOS
    // alike (macOS has no /proc and hides other processes' env), and touches a
    // file once running, so the check cannot pass because nothing started. The
    // marker is in the gate command too, so caffeinate and sh carry it as well.
    const marker = join(base, `STOPGATE_${process.pid}_${Date.now()}`);
    const leaf = (n: number) => `node -e "require('fs').writeFileSync(process.argv[1], ''); setTimeout(() => {}, 30000)" ${marker}.${n}`;
    const r = runHook(
      { session_id: sid, cwd: primary },
      { APEX_STOP_GATE_CMD: `${leaf(1)} & ${leaf(2)}`, STOP_GATE_TIMEOUT_MS: '3000' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('timed out');
    expect([existsSync(`${marker}.1`), existsSync(`${marker}.2`)]).toEqual([true, true]);
    const ps = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' });
    expect(ps.stdout.split('\n').filter((l) => l.includes(marker))).toEqual([]);
  }, 20_000); // runs inside the Stop hook's own gate, often beside other sessions' gates

  // The hook's real gate, on a real Mac: caffeinate's idle-sleep assertion
  // names the gate shell's pid. caffeinate takes it a moment after the shell
  // starts, so the gate polls for up to 2s. The guard does not ask gateArgv,
  // so a broken gateArgv fails here instead of skipping.
  const mac = process.platform === 'darwin' && spawnSync('sh', ['-c', 'command -v caffeinate']).status === 0;
  it.runIf(mac)('on a Mac the gate runs holding an idle-sleep assertion', () => {
    freshCommit('p3.txt');
    const held = `pmset -g assertions | grep -B1 "(pid $$)" | grep -c PreventUserIdleSystemSleep`;
    const r = runHook(
      { session_id: sid, cwd: primary },
      { APEX_STOP_GATE_CMD: `for i in 1 2 3 4 5 6 7 8 9 10; do n=$(${held}); [ "$n" -gt 0 ] && break; sleep 0.2; done; echo "idle-held=$n"; exit 1` },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('idle-held=1');
    expect(r.stderr).toContain('(`caffeinate -i -s for i in');
    expect(readFileSync(lp.log, 'utf8')).toMatch(/^\$ caffeinate -i -s for i in/);
  }, 20_000);

  it('exit 0 for a session that never cut a lane', () => {
    const r = runHook({ session_id: 'nobody', cwd: primary });
    expect(r.status).toBe(0);
  });

  it('APEX_STOP_GATE=off disables it', () => {
    const r = runHook({ session_id: sid, cwd: primary }, { APEX_STOP_GATE: 'off', APEX_STOP_GATE_CMD: 'exit 1' });
    expect(r.status).toBe(0);
  });

  it('malformed input allows (fail open)', () => {
    const r = spawnSync('node', [hook], { input: 'not json', encoding: 'utf8', env: gitEnv });
    expect(r.status).toBe(0);
  });
});

describe('scripts/stop-gate.sh', () => {
  const run = (args: string[], cwd = primary, env: Record<string, string | undefined> = {}) =>
    spawnSync('bash', [cli, ...args], { cwd, encoding: 'utf8', env: { ...gitEnv, CLAUDE_CODE_SESSION_ID: 'cli-1', ...env } });
  const binding = sessionPaths(primary, 'cli-1').binding;

  it('bind appends once per lane and refuses anything that is not a worktree of this repo', () => {
    expect(run(['bind', lane]).status).toBe(0);
    expect(run(['bind', lane]).stdout).toMatch(/already bound/);
    expect(readFileSync(binding, 'utf8')).toBe(lane + '\n');
    expect(run(['bind', primary]).status).toBe(1);
    const fake = join(base, 'fake');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, '.git'), 'gitdir: /nowhere\n');
    expect(run(['bind', fake]).status).toBe(1);
    expect(run(['bind', lane], primary, { CLAUDE_CODE_SESSION_ID: '../x' }).status).toBe(1);
  });

  it('status exits 0 whether or not a gate has run', () => {
    const r = run(['status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(lane);
    expect(run([]).status).toBe(0);
  });

  it('blocked writes the marker; unbind <lane> drops that lane; unbind drops everything', () => {
    expect(run(['blocked', 'needs Shane']).status).toBe(0);
    expect(readFileSync(sessionPaths(primary, 'cli-1').blocked, 'utf8')).toContain('needs Shane');
    expect(run(['blocked']).status).toBe(64);
    expect(run(['unbind', lane]).status).toBe(0);
    expect(readFileSync(binding, 'utf8')).toBe('');
    expect(run(['unbind']).status).toBe(0);
    expect(existsSync(binding)).toBe(false);
    expect(existsSync(sessionPaths(primary, 'cli-1').dir)).toBe(false);
  });
});
