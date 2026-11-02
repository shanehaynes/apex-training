import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain JS hook, run with bare node; no .d.mts on purpose (builtins only, like bash-guard)
import { decide, holdAwake, lanePaths, lanesFor, lastSleepMs, parseSleepTime, runGate, sessionPaths } from '../stop-gate.mjs';

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

// The hook runs agent:check with its own environment, so its knobs reach this
// file when it runs inside the gate; each test sets the ones it means.
for (const k of Object.keys(process.env)) if (/^(APEX_STOP_GATE|STOP_GATE_)/.test(k)) delete process.env[k];

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
    expect(count()).toBe(`${sha} 1 1 0 0`);
    expect(existsSync(lp.green)).toBe(false);
  });

  it('red twice more spends the per-commit budget; then the gate stands aside and the push check still applies', async () => {
    const sha = git(lane, 'rev-parse', 'HEAD');
    expect((await stop(gate(false).run)).reason).toContain('run 2/3');
    expect((await stop(gate(false).run)).reason).toContain('run 3/3');
    expect(count()).toBe(`${sha} 3 3 0 0`);
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
  const status = () => spawnSync('bash', [cli, 'status'], { cwd: primary, encoding: 'utf8', env: { ...gitEnv, CLAUDE_CODE_SESSION_ID: sid } });

  it('blocks with the tail, says the Mac slept, and charges nothing', async () => {
    const sha = commit('slept-1.txt');
    const v = await stop(asleep());
    expect(v.action).toBe('block');
    expect(v.reason).toMatch(/the gate is red at \w{7} \(`fake-gate`\), but the Mac went to sleep during the run \(last at \d\d:\d\d:\d\d\)/);
    expect(v.reason).toContain('not charged to the red budget (uncharged run 1/3 for this commit, 1/5 this session; red runs still 0/3)');
    expect(v.reason).toContain(timeouts);
    expect(v.reason).toContain(lp.log);
    expect(count()).toBe(`${sha} 0 0 1 1`);
  });

  it('three per commit; past that a slept red counts like any red, and says so', async () => {
    const sha = git(lane, 'rev-parse', 'HEAD');
    expect((await stop(asleep())).reason).toContain('uncharged run 2/3');
    expect((await stop(asleep())).reason).toContain('uncharged run 3/3');
    expect(count()).toBe(`${sha} 0 0 3 3`);
    const v = await stop(asleep());
    expect(v.reason).toContain('run 1/3 for this commit');
    expect(v.reason).toContain('but this commit has had its 3 uncharged runs, so this one counts');
    expect(count()).toBe(`${sha} 1 1 3 3`);
  });

  it('an awake red is charged as before; a new commit gets fresh uncharged runs and both totals carry', async () => {
    const sha = git(lane, 'rev-parse', 'HEAD');
    const v = await stop(gate(false).run);
    expect(v.reason).toContain('run 2/3 for this commit');
    expect(v.reason).not.toMatch(/sleep|uncharged/);
    expect(count()).toBe(`${sha} 2 2 3 3`);
    const next = commit('slept-2.txt');
    expect((await stop(asleep())).reason).toContain('uncharged run 1/3 for this commit, 4/5 this session; red runs still 0/3');
    expect(count()).toBe(`${next} 0 2 1 4`);
    const st = status();
    expect(st.status).toBe(0); // the count file has no newline; status used to die on it
    expect(st.stdout).toContain(`red runs: feat-a — 0 at ${next.slice(0, 7)}, 2 this session`);
    expect(st.stdout).toContain(`uncharged: feat-a — 1 at ${next.slice(0, 7)}, 4 this session, the Mac slept (caps 3/5)`);
  });

  it('a timed-out run is treated the same, and keeps the red runs already spent at this commit', async () => {
    const sha = git(lane, 'rev-parse', 'HEAD');
    writeFileSync(lp.count, `${sha} 1 3 1 4`);
    const run = async () => ({ ok: false, timedOut: true, tail: timeouts, cmd: 'fake-gate', sleptAt: Date.now() - 60_000 });
    const v = await stop(run);
    expect(v.reason).toMatch(/the gate timed out at \w{7} \(`fake-gate`\), but the Mac went to sleep during the run/);
    expect(v.reason).toContain('uncharged run 2/3 for this commit, 5/5 this session; red runs still 1/3');
    expect(count()).toBe(`${sha} 1 3 2 5`);
  });

  it('a run the Mac slept through that passes is green', async () => {
    const sha = git(lane, 'rev-parse', 'HEAD');
    const v = await stop(gate(true, 'all green', Date.now() - 60_000).run);
    expect(readFileSync(lp.green, 'utf8')).toBe(sha);
    expect(count()).toBeNull();
    expect(v.reason).toMatch(/not on origin/);
  });

  it('the session cap holds across commits: a commit after every slept red still ends in a stand-aside', async () => {
    rmSync(lp.count, { force: true });
    const g = gate(false, timeouts, Date.now() - 60_000);
    const verdicts = [];
    for (let i = 0; i < 18; i++) {
      commit(`loop-${i}.txt`);
      verdicts.push(await stop(g.run));
    }
    expect(g.calls).toHaveLength(5 + 10); // 5 uncharged per session, then the 10 charged ones
    expect(verdicts[4].reason).toContain('uncharged run 1/3 for this commit, 5/5 this session');
    expect(verdicts[5].reason).toContain('but this session has had its 5 uncharged runs, so this one counts');
    expect(verdicts[17].notes.join('\n')).toMatch(/stood aside.*10 this session/);
    rmSync(lp.count, { force: true });
  }, 30_000);
});

describe('knowing the Mac slept', () => {
  // A fake sysctl that reports a later sleep on every call, as if the Mac
  // slept between any two readings, and one that fails.
  const fakeSysctl = join(base, 'fake-sysctl');
  const failingSysctl = join(base, 'failing-sysctl');
  const reads = join(base, 'fake-sysctl.reads');
  beforeAll(() => {
    writeFileSync(
      fakeSysctl,
      `#!/bin/sh\nn=$(cat "${reads}" 2>/dev/null || echo 1793624521)\necho $((n + 60)) > "${reads}"\necho "{ sec = $n, usec = 0 } fake"\n`,
      { mode: 0o755 },
    );
    writeFileSync(failingSysctl, '#!/bin/sh\necho "sysctl: unknown oid" >&2\nexit 1\n', { mode: 0o755 });
  });

  it('parseSleepTime reads `sysctl -n kern.sleeptime`: never slept is 0, junk is null', () => {
    expect(parseSleepTime('{ sec = 1793624521, usec = 923212 } Mon Nov  2 08:02:01 2026\n')).toBe(1793624521923);
    expect(parseSleepTime('{ sec = 0, usec = 0 } Thu Jan  1 00:00:00 1970')).toBe(0);
    expect(parseSleepTime('')).toBeNull();
    expect(parseSleepTime('sysctl: unknown oid')).toBeNull();
  });

  it('lastSleepMs is null off darwin, and when sysctl fails or is missing', () => {
    expect(lastSleepMs({ platform: 'linux', sysctl: fakeSysctl })).toBeNull();
    expect(lastSleepMs({ platform: 'darwin', sysctl: failingSysctl })).toBeNull();
    expect(lastSleepMs({ platform: 'darwin', sysctl: join(base, 'no-such-sysctl') })).toBeNull();
  });

  it.runIf(process.platform === 'darwin')('on a Mac the kernel answers with a time in the past, or 0 if it never slept', () => {
    const v = lastSleepMs();
    expect(Number.isInteger(v) && v <= Date.now()).toBe(true);
    expect(v).toBe(parseSleepTime(spawnSync('/usr/sbin/sysctl', ['-n', 'kern.sleeptime'], { encoding: 'utf8' }).stdout));
  });

  it('runGate reads sysctl before and after the gate; a changed stamp is a sleep, reported and logged', async () => {
    rmSync(reads, { force: true });
    const log = join(base, 'slept.gate.log');
    const g = await runGate(lane, { cmd: 'echo t; exit 1', platform: 'darwin', sysctl: fakeSysctl, logPath: log, timeoutMs: 10_000 });
    expect(g.ok).toBe(false);
    expect(g.sleptAt).toBe(1793624581000); // the second reading
    expect(readFileSync(log, 'utf8')).toMatch(/\n\[stop-gate: the Mac slept during the gate \(started \d\d:\d\d:\d\d, last sleep \d\d:\d\d:\d\d\)\]\n$/);
    const failed = await runGate(lane, { cmd: 'echo t', platform: 'darwin', sysctl: failingSysctl, timeoutMs: 10_000 });
    expect(failed).toMatchObject({ ok: true, sleptAt: null });
  });

  it('an unchanged stamp, a failed read at either end, or a reader that throws is awake; a first sleep since boot is a sleep', async () => {
    const pairs: [number | null, number | null][] = [
      [1000, 1000],
      [0, 0],
      [null, 2000],
      [1000, null],
      [null, null],
    ];
    const reading = (before: number | null, after: number | null) => {
      let n = 0;
      return () => (n++ === 0 ? before : after);
    };
    for (const [before, after] of pairs) {
      expect(await runGate(lane, { cmd: 'echo t', platform: 'linux', timeoutMs: 10_000, lastSleep: reading(before, after) })).toMatchObject({
        ok: true,
        sleptAt: null,
      });
    }
    const throws = () => {
      throw new Error('sysctl gone');
    };
    expect(await runGate(lane, { cmd: 'echo t', platform: 'linux', timeoutMs: 10_000, lastSleep: throws })).toMatchObject({ ok: true, sleptAt: null });
    expect((await runGate(lane, { cmd: 'echo t', platform: 'linux', timeoutMs: 10_000, lastSleep: reading(0, 5000) })).sleptAt).toBe(5000);
  });

  it('with this machine\'s own sysctl, a gate that stayed awake is not reported as slept', async () => {
    expect(await runGate(lane, { cmd: 'echo t', timeoutMs: 10_000 })).toMatchObject({ ok: true, sleptAt: null });
  });
});

// Process checks. ps's argv column reads the same on Linux and macOS; a
// killed child of this process is a zombie until Node reaps it, so Z is gone.
const psLines = () => {
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' });
  expect(r.status).toBe(0); // a ps that failed would show no survivors
  return r.stdout.split('\n');
};
const alive = (pid: number) => {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0) {
    expect(r.stderr).toBe(''); // no such process, not a ps that failed
    return false;
  }
  return !r.stdout.trim().startsWith('Z');
};
const until = async (ok: () => boolean, ms = 3000) => {
  for (const t0 = Date.now(); !ok() && Date.now() - t0 < ms; ) await new Promise((r) => setTimeout(r, 25));
  return ok();
};

describe('the gate held awake on a Mac', () => {
  // A fake caffeinate at an injected path, so the platform choice is tested on
  // any OS. It records its pid and arguments, then waits like the real one;
  // the broken one fails the way an unknown flag does, and the last one
  // cannot be spawned at all.
  const fake = join(base, 'fake-caffeinate');
  const broken = join(base, 'broken-caffeinate');
  const noExec = join(base, 'noexec-caffeinate');
  const seen = join(base, 'fake-caffeinate.seen');
  const read = () => (existsSync(seen) ? readFileSync(seen, 'utf8').trim() : null);
  beforeAll(() => {
    writeFileSync(fake, `#!/bin/sh\necho "$$ $*" > '${seen}.tmp' && mv '${seen}.tmp' '${seen}'\nexec sleep 30\n`, { mode: 0o755 });
    writeFileSync(broken, '#!/bin/sh\necho "caffeinate: illegal option -- s" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(noExec, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  });

  it('darwin: a caffeinate beside the gate holds idle and AC sleep off for as long as the given process lives', async () => {
    rmSync(seen, { force: true });
    const hold = holdAwake({ platform: 'darwin', caffeinate: fake, pid: 4242 });
    expect(await until(() => read() !== null)).toBe(true);
    expect(read()).toBe(`${hold.pid} -i -s -w 4242`);
    hold.kill();
  });

  it('no hold off darwin, without the binary, or with APEX_STOP_GATE_CAFFEINATE=off', () => {
    for (const platform of ['linux', 'win32', 'freebsd']) expect(holdAwake({ platform, caffeinate: fake })).toBeNull();
    expect(holdAwake({ platform: 'darwin', caffeinate: join(base, 'no-such-caffeinate') })).toBeNull();
    process.env.APEX_STOP_GATE_CAFFEINATE = 'off';
    try {
      expect(holdAwake({ platform: 'darwin', caffeinate: fake })).toBeNull();
    } finally {
      delete process.env.APEX_STOP_GATE_CAFFEINATE;
    }
  });

  it('runGate holds for the hook while the gate runs, ends the hold when it closes, and leaves the gate alone', async () => {
    rmSync(seen, { force: true });
    // The gate waits for the hold, so the two are proven to overlap.
    const cmd = `until [ -f '${seen}' ]; do sleep 0.05; done; echo gate-ran; exit 3`;
    const g = await runGate(lane, { cmd, platform: 'darwin', caffeinate: fake, timeoutMs: 10_000 });
    expect(g).toMatchObject({ ok: false, timedOut: false, tail: 'gate-ran', cmd });
    const [pid, ...args] = (read() ?? '').split(' ');
    expect(args).toEqual(['-i', '-s', '-w', String(process.pid)]);
    expect(await until(() => !alive(Number(pid)))).toBe(true);
    rmSync(seen, { force: true });
    const off = await runGate(lane, { cmd: 'echo gate-ran', platform: 'linux', caffeinate: fake, timeoutMs: 10_000 });
    expect(off).toMatchObject({ ok: true, tail: 'gate-ran', cmd: 'echo gate-ran' });
    expect(read()).toBeNull();
  });

  it('a caffeinate that fails or cannot be spawned costs only the hold: the gate runs and its verdict stands', async () => {
    for (const caffeinate of [broken, noExec]) {
      const g = await runGate(lane, { cmd: 'echo gate-ran', platform: 'darwin', caffeinate, timeoutMs: 10_000 });
      expect(g).toMatchObject({ ok: true, tail: 'gate-ran', cmd: 'echo gate-ran' });
    }
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
    expect(readFileSync(lp.log, 'utf8')).toMatch(/^\$ echo out1; echo err1 >&2; echo out2; exit 1\n\(cwd \/.*\n\nout1\nerr1\nout2\n$/);
  });

  it('a timed-out gate leaves no processes behind', () => {
    freshCommit('p2.txt');
    // Each leaf carries the marker in argv, which ps shows on Linux and macOS
    // alike (macOS has no /proc and hides other processes' env), and touches a
    // file once running, so the check cannot pass because nothing started. The
    // marker is in the gate command too, so sh carries it as well.
    const marker = join(base, `STOPGATE_${process.pid}_${Date.now()}`);
    const leaf = (n: number) => `node -e "require('fs').writeFileSync(process.argv[1], ''); setTimeout(() => {}, 30000)" ${marker}.${n}`;
    const r = runHook(
      { session_id: sid, cwd: primary },
      { APEX_STOP_GATE_CMD: `${leaf(1)} & ${leaf(2)}`, STOP_GATE_TIMEOUT_MS: '3000' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('timed out');
    expect([existsSync(`${marker}.1`), existsSync(`${marker}.2`)]).toEqual([true, true]);
    const ps = psLines();
    expect(ps.some((l) => l.trim().startsWith(`${process.pid} `))).toBe(true); // ps can see this process at all
    expect(ps.filter((l) => l.includes(marker))).toEqual([]);
  }, 20_000); // runs inside the Stop hook's own gate, often beside other sessions' gates

  // The hook's real hold, on a real Mac: while the gate runs, caffeinate holds
  // PreventUserIdleSystemSleep on the hook's behalf, and when the hook is
  // killed outright the hold goes with it, although the detached gate lives
  // on. The guard does not ask holdAwake, so a broken holdAwake fails here
  // instead of skipping.
  const mac = process.platform === 'darwin' && existsSync('/usr/bin/caffeinate');
  it.runIf(mac)('on a Mac the gate runs under an idle-sleep hold that dies with the hook', async () => {
    freshCommit('p3.txt');
    const started = join(base, `gate-started-${process.pid}`);
    const child = spawn('node', [hook], {
      env: { ...gitEnv, CLAUDE_PROJECT_DIR: primary, APEX_STOP_GATE_CMD: `echo $$ > '${started}.tmp' && mv '${started}.tmp' '${started}'; sleep 30` },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end(JSON.stringify({ session_id: sid, cwd: primary }));
    const holdPid = () => psLines().find((l) => new RegExp(`caffeinate -i -s -w ${child.pid}(\\s|$)`).test(l))?.trim().split(/\s+/)[0];
    const asserted = (pid: string) =>
      new RegExp(`pid ${pid}\\(caffeinate\\):.*PreventUserIdleSystemSleep`).test(spawnSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' }).stdout);
    try {
      expect(await until(() => existsSync(started), 10_000)).toBe(true);
      const pid = holdPid();
      expect(pid).toBeDefined();
      expect(await until(() => asserted(pid!))).toBe(true);
      child.kill('SIGKILL');
      expect(await until(() => holdPid() === undefined)).toBe(true);
      expect(asserted(pid!)).toBe(false);
      expect(alive(Number(readFileSync(started, 'utf8')))).toBe(true); // the orphaned gate runs on; only the hold went
    } finally {
      child.kill('SIGKILL');
      try {
        process.kill(-Number(readFileSync(started, 'utf8')), 'SIGKILL'); // the gate's process group
      } catch {
        /* never started, or already gone */
      }
    }
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
