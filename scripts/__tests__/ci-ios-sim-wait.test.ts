// The ios job's "Wait for the pinned simulator" step fails only on a broken
// runner, which no PR run can summon, so its failure paths are tested here: the
// exact script ci.yml holds runs against a fake clock (`date`, `sleep`), a fake
// `xcrun simctl` and a fake `sudo`, with the step's real 180 s, 90 s and 10 s
// windows. Real jq and perl run it; the perl alarm itself was checked against
// a real blocked simctl on a Mac (PR #556). This PR's own ios run is the proof
// on a healthy runner.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ciYml = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
const STEP = 'Wait for the pinned simulator';

/** A top-level job's lines, up to the next job or top-level key. */
function jobLines(text: string, name: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`no \`${name}\` job`);
  let end = lines.findIndex((l, i) => i > start && /^ {0,2}[^\s#]/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

/** The `run: |` block of the ios step named STEP, dedented. */
function stepScript(text: string): string {
  const lines = jobLines(text, 'ios');
  const named = lines.flatMap((l, i) => (l === `      - name: ${STEP}` ? [i] : []));
  if (named.length !== 1) throw new Error(`the ios job has ${named.length} "${STEP}" steps, not one`);
  const run = lines.findIndex((l, i) => i > named[0] && l === '        run: |');
  const next = lines.findIndex((l, i) => i > named[0] && l.startsWith('      - '));
  if (run < 0 || (next >= 0 && run > next)) throw new Error(`"${STEP}" has no \`run: |\` block`);
  const body: string[] = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && !l.startsWith(' '.repeat(10))) break;
    body.push(l.slice(10));
  }
  return body.join('\n') + '\n';
}

const scriptText = stepScript(ciYml);
const work = mkdtempSync(join(tmpdir(), 'ci-ios-sim-wait-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const script = join(work, 'step.sh');
writeFileSync(script, scriptText);

const realPath = process.env.PATH ?? '/usr/bin:/bin';
for (const tool of ['bash', 'jq', 'perl']) {
  if (spawnSync('sh', ['-c', `command -v ${tool}`], { env: { PATH: realPath } }).status !== 0) {
    throw new Error(`${tool} is not on PATH; the step needs it, and so does this test`);
  }
}

// The fakes. The clock is a file holding seconds; it starts at 1000.
// `sleep N` and every simctl call move it forward instead of waiting.
const bin = join(work, 'bin');
mkdirSync(bin);
const fake = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
fake('date', `if [ "$*" = "+%s" ]; then cat "$FAKE_CLOCK"; else PATH="$REAL_PATH" exec date "$@"; fi`);
fake('sleep', `echo $(( $(cat "$FAKE_CLOCK") + \${1%.*} )) > "$FAKE_CLOCK"`);
fake('sudo', `echo "$*" >> "$FAKE_SUDO_LOG"`);
// FAKE_HANG: every call is cut off by the step's 20 s alarm (perl exits 142).
// FAKE_READY_AT: from that many seconds in, \`list -j\` answers FAKE_READY_JSON.
// FAKE_READY_AFTER_RESTART: it answers FAKE_READY_JSON once sudo has run.
fake(
  'xcrun',
  `[ "$1" = simctl ] || exit 64
now=$(cat "$FAKE_CLOCK")
if [ -n "\${FAKE_HANG:-}" ]; then echo $(( now + 20 )) > "$FAKE_CLOCK"; exit 142; fi
if [ "$*" != "simctl list -j" ]; then echo "[fake xcrun $*]"; exit 0; fi
if { [ -n "\${FAKE_READY_AT:-}" ] && [ $(( now - 1000 )) -ge "$FAKE_READY_AT" ]; } ||
   { [ -n "\${FAKE_READY_AFTER_RESTART:-}" ] && [ -s "$FAKE_SUDO_LOG" ]; }; then
  printf '%s' "$FAKE_READY_JSON"
else
  printf '%s' "$FAKE_JSON"
fi
exit "\${FAKE_RC:-0}"`,
);

// simctl list -j shapes, as Xcode 26.6 prints them (trimmed to the keys the step reads).
const IOS = 'com.apple.CoreSimulator.SimRuntime.iOS-';
type Runtime = { identifier: string; version: string; isAvailable: boolean; availabilityError?: string };
type Device = { name: string; udid: string; isAvailable: boolean; availabilityError?: string };
const runtime = (id: string, version: string, isAvailable = true, availabilityError?: string): Runtime => ({
  identifier: `${IOS}${id}`,
  version,
  isAvailable,
  ...(availabilityError ? { availabilityError } : {}),
});
const device = (name: string, udid: string, isAvailable = true, availabilityError?: string): Device => ({
  name,
  udid,
  isAvailable,
  ...(availabilityError ? { availabilityError } : {}),
});
const sims = (runtimes: Runtime[], devices: Record<string, Device[]>) =>
  JSON.stringify({ devicetypes: [], runtimes, devices, pairs: {} });

const ios18 = { [`${IOS}18-6`]: [device('iPhone 16', 'A'), device('iPhone 16 Pro', 'B')] };
const PINNED = sims([runtime('18-6', '18.6'), runtime('26-5', '26.5')], {
  ...ios18,
  [`${IOS}26-5`]: [device('iPhone 17 Pro', 'PRO'), device('iPhone 17', 'PIN-UDID')],
});
const EMPTY = sims([], {});

let runs = 0;
/** Runs the step the way a default `run:` step does (bash -e), with the pin ci.yml sets. */
function wait(env: Record<string, string>) {
  const dir = join(work, `run-${++runs}`);
  mkdirSync(dir);
  const clock = join(dir, 'clock');
  writeFileSync(clock, '1000');
  const sudoLog = join(dir, 'sudo.log');
  const r = spawnSync('bash', ['-e', script], {
    env: {
      PATH: `${bin}:${realPath}`,
      REAL_PATH: realPath,
      HOME: dir,
      GITHUB_RUN_ID: '123',
      IOS_SIM_DEVICE: 'iPhone 17',
      IOS_SIM_OS: '26.5',
      FAKE_CLOCK: clock,
      FAKE_SUDO_LOG: sudoLog,
      FAKE_JSON: EMPTY,
      FAKE_READY_JSON: PINNED,
      ...env,
    },
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  return {
    status: r.status,
    out,
    errors: out.split('\n').filter((l) => l.startsWith('::error::')),
    notices: out.split('\n').filter((l) => l.startsWith('::notice::')),
    sudo: existsSync(sudoLog) ? readFileSync(sudoLog, 'utf8').trim().split('\n') : [],
    seconds: Number(readFileSync(clock, 'utf8')) - 1000,
  };
}

const RESTART = 'killall -9 com.apple.CoreSimulator.CoreSimulatorService';
const T = 20_000;

describe('the pin in ci.yml', () => {
  it('is set once, on the ios job, and the xcodebuild destination reads it', () => {
    const job = jobLines(ciYml, 'ios').join('\n');
    expect(job).toMatch(/^ {4}env:\n {6}IOS_SIM_DEVICE: iPhone 17\n {6}IOS_SIM_OS: '26\.5'$/m);
    expect(job).toContain(`-destination "platform=iOS Simulator,name=$IOS_SIM_DEVICE,OS=$IOS_SIM_OS"`);
    // No second, literal pin outside the comments.
    const code = job.split('\n').filter((l) => !/^\s*#/.test(l));
    expect(code.filter((l) => /name=iPhone|OS=\d/.test(l))).toEqual([]);
  });

  it('is waited for before "Build and test"', () => {
    const job = jobLines(ciYml, 'ios');
    const at = (name: string) => job.indexOf(`      - name: ${name}`);
    expect(at(STEP)).toBeGreaterThan(0);
    expect(at(STEP)).toBeLessThan(at('Build and test'));
    // Worst case below is 430 s; the step's own cap must hold it.
    expect(job[at(STEP) + 1]).toBe('        timeout-minutes: 10');
  });
});

describe('a healthy runner', () => {
  it('passes on the first poll with no restart and no notice', () => {
    const r = wait({ FAKE_JSON: PINNED });
    expect(r.status).toBe(0);
    expect(r.out).toContain('iPhone 17 on iOS 26.5 is ready: PIN-UDID (after 0s, poll 1).');
    expect(r.notices).toEqual([]);
    expect(r.sudo).toEqual([]);
  }, T);

  it('takes the device of the pinned name, not one whose name starts with it', () => {
    const r = wait({
      FAKE_JSON: sims([runtime('26-5', '26.5')], {
        [`${IOS}26-5`]: [device('iPhone 17 Pro', 'PRO'), device('iPhone 17e', 'E'), device('iPhone 17', 'PIN-UDID')],
      }),
    });
    expect(r.out).toContain('is ready: PIN-UDID');
  }, T);

  it('matches a point-release pin on its version, whatever the runtime id says', () => {
    const r = wait({
      IOS_SIM_OS: '26.4.1',
      FAKE_JSON: sims([runtime('26-4', '26.4.1')], { [`${IOS}26-4`]: [device('iPhone 17', 'POINT')] }),
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain('iPhone 17 on iOS 26.4.1 is ready: POINT');
  }, T);
});

describe('a late device', () => {
  it('found within xcodebuild\'s own wait (up to 110 s) leaves no notice', () => {
    for (const at of [10, 50, 110]) {
      const r = wait({ FAKE_READY_AT: String(at) });
      expect(r.status).toBe(0);
      expect(r.out).toContain(`(after ${at}s, poll ${at / 10 + 1}).`);
      expect(r.notices).toEqual([]);
    }
  }, T);

  it('found after 120 s leaves a notice with the time', () => {
    const r = wait({ FAKE_READY_AT: '115' });
    expect(r.status).toBe(0);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatch(/appeared only after 120s, later than xcodebuild alone waited/);
    expect(r.sudo).toEqual([]);
  }, T);

  it('found only after the restart leaves a notice that says so', () => {
    const r = wait({ FAKE_READY_AFTER_RESTART: '1' });
    expect(r.status).toBe(0);
    expect(r.sudo).toEqual([RESTART]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatch(/after a CoreSimulatorService restart, 180s in/);
  }, T);
});

describe('a runner that never shows the device', () => {
  const machine = /It is the machine, not the code: re-run the job \(gh run rerun 123 --failed\) and change nothing/;

  it.each([
    ['no simulators at all', { FAKE_JSON: EMPTY }],
    ['runtimes but no devices', { FAKE_JSON: sims([runtime('26-5', '26.5')], {}) }],
    ['simctl failing with no JSON', { FAKE_JSON: '', FAKE_RC: '1' }],
    ['garbage output', { FAKE_JSON: 'not json' }],
    ['JSON without runtimes', { FAKE_JSON: JSON.stringify({ devices: ios18 }) }],
    [
      'watchOS only',
      {
        FAKE_JSON: JSON.stringify({
          runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-26-0', version: '26.0', isAvailable: true }],
          devices: { 'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [device('Watch', 'W')] },
        }),
      },
    ],
  ])('%s: waits 180 s, dumps, restarts once, waits 90 s, then says re-run', (_name, env) => {
    const r = wait(env);
    expect(r.status).toBe(1);
    expect(r.sudo).toEqual([RESTART]);
    expect(r.out).toContain('No iPhone 17 on iOS 26.5 after 180s (none).');
    for (const group of ['list runtimes', 'runtime list (disk images)', 'list devices']) {
      expect(r.out.split(`::group::xcrun simctl ${group}`)).toHaveLength(3);
    }
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^::error::This runner has no iOS simulators, after 270s of waiting/);
    expect(r.errors[0]).toMatch(machine);
    expect(r.seconds).toBe(270);
  }, T);

  it('with simctl hanging on every call: each call is cut off, and the error still comes inside the step cap', () => {
    const r = wait({ FAKE_HANG: '1' });
    expect(r.status).toBe(1);
    expect(r.sudo).toEqual([RESTART]);
    expect(r.errors[0]).toMatch(/^::error::This runner has no iOS simulators, after 430s/);
    expect(r.seconds).toBeLessThan(10 * 60);
  }, T);

  it('with the runtime there but unavailable: the reason on one line, and re-run', () => {
    const r = wait({
      FAKE_JSON: sims([runtime('18-6', '18.6'), runtime('26-5', '26.5', false, 'disk image\nnot mounted')], {
        ...ios18,
        [`${IOS}26-5`]: [device('iPhone 17', 'PIN', false)],
      }),
    });
    expect(r.status).toBe(1);
    expect(r.errors).toEqual([expect.stringMatching(/^::error::iOS 26\.5 is on this runner but unavailable \(disk image not mounted\)\. /)]);
    expect(r.errors[0]).toMatch(machine);
  }, T);

  it('with the runtime there and no devices on it: re-run', () => {
    const r = wait({ FAKE_JSON: sims([runtime('18-6', '18.6'), runtime('26-5', '26.5')], { ...ios18, [`${IOS}26-5`]: [] }) });
    expect(r.errors).toEqual([expect.stringMatching(/^::error::iOS 26\.5 is on this runner with no available devices\. /)]);
    expect(r.errors[0]).toMatch(machine);
  }, T);

  it('with the pinned device there but unavailable: its reason, re-run once, then move it', () => {
    const r = wait({
      FAKE_JSON: sims([runtime('26-5', '26.5')], {
        [`${IOS}26-5`]: [device('iPhone 17', 'PIN', false, 'device type profile not found'), device('iPhone Air', 'AIR')],
      }),
    });
    expect(r.status).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^::error::iPhone 17 on iOS 26\.5 is on this runner but unavailable \(device type profile not found\)\. Re-run the job once/);
    expect(r.errors[0]).toMatch(/move IOS_SIM_DEVICE in ci\.yml, in a PR/);
  }, T);
});

describe('an image without the pin', () => {
  it('that dropped the runtime: move IOS_SIM_OS', () => {
    const r = wait({ FAKE_JSON: sims([runtime('18-6', '18.6')], ios18) });
    expect(r.status).toBe(1);
    expect(r.errors).toEqual([expect.stringMatching(/^::error::This runner has iOS simulators but no iOS 26\.5 runtime .*move IOS_SIM_OS/)]);
  }, T);

  it('whose runtime is a point release of the pin: no match, as xcodebuild\'s OS= would not match either', () => {
    const r = wait({
      FAKE_JSON: sims([runtime('26-5', '26.5.1')], { [`${IOS}26-5`]: [device('iPhone 17', 'X')] }),
    });
    expect(r.errors).toEqual([expect.stringMatching(/no iOS 26\.5 runtime/)]);
  }, T);

  it('that changed its device set: move IOS_SIM_DEVICE', () => {
    const r = wait({
      FAKE_JSON: sims([runtime('26-5', '26.5')], { [`${IOS}26-5`]: [device('iPhone 18', 'X'), device('iPhone 18 Pro', 'Y')] }),
    });
    expect(r.status).toBe(1);
    expect(r.errors).toEqual([
      expect.stringMatching(/^::error::iOS 26\.5 is on this runner with 2 available devices, none named iPhone 17 .*The image changed its device set: move IOS_SIM_DEVICE/),
    ]);
    expect(r.errors[0]).not.toMatch(/change nothing/);
  }, T);
});
