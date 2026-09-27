// Minimal test harness for the node acceptance suites: one PASS/FAIL line per
// case, a SUMMARY line, exit 1 on any failure. A case that throws anything is
// a FAIL with the message; the harness itself never aborts the run.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = resolve(process.env.SKILL_ROOT || join(here, '..', '..'));

export class Fail extends Error {}
export function ok(cond, msg) {
  if (!cond) throw new Fail(msg);
}
export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Fail(`${msg} (got ${a}, want ${e})`);
}
export function match(str, re, msg) {
  if (!re.test(String(str ?? ''))) throw new Fail(`${msg}: /${re.source}/ not in ${JSON.stringify(String(str ?? '').slice(0, 300))}`);
}
export function noMatch(str, re, msg) {
  if (re.test(String(str ?? ''))) throw new Fail(`${msg}: /${re.source}/ found in ${JSON.stringify(String(str ?? '').slice(0, 300))}`);
}

export function suite(component) {
  const cases = [];
  const cleanups = [];
  return {
    test(name, fn) {
      // ONLY=<regex> runs just the matching cases (for debugging one amendment).
      if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
      cases.push({ name, fn });
    },
    onCleanup(fn) {
      cleanups.push(fn);
    },
    async run() {
      let pass = 0;
      let fail = 0;
      for (const c of cases) {
        try {
          await c.fn();
          pass += 1;
          console.log(`PASS ${component}: ${c.name}`);
        } catch (err) {
          fail += 1;
          const m = err instanceof Fail ? err.message : `threw: ${err?.stack?.split('\n').slice(0, 2).join(' | ') ?? err}`;
          console.log(`FAIL ${component}: ${c.name} — ${m.replace(/\s*\n\s*/g, ' ')}`);
        } finally {
          while (cleanups.length) {
            try {
              cleanups.pop()();
            } catch {
              /* best effort */
            }
          }
        }
      }
      console.log(`SUMMARY ${component} pass=${pass} fail=${fail}`);
      process.exitCode = fail === 0 ? 0 : 1;
    },
  };
}

// ── git fixtures ────────────────────────────────────────────────────────────
const suiteTmp = realpathSync(mkdtempSync(join(tmpdir(), 'accept-node-')));
process.on('exit', () => rmSync(suiteTmp, { recursive: true, force: true }));
const gitconfig = join(suiteTmp, 'gitconfig');
writeFileSync(
  gitconfig,
  '[user]\n\tname = Acceptance Test\n\temail = accept@example.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[safe]\n\tdirectory = *\n[commit]\n\tgpgsign = false\n',
);
export const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'FLEET_DIR', 'FLEET_FIX_ROUNDS', 'PARALLEL_AGENTS_GUARD', 'PARALLEL_AGENTS_TEMP_DIRS', 'CLAUDE_PROJECT_DIR']) {
  delete baseEnv[k];
}

export function tmp(prefix = 'fx-') {
  return realpathSync(mkdtempSync(join(suiteTmp, prefix)));
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: baseEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A bare origin plus a clone with two commits on main, pushed.
// Returns { root, origin, primary }.
export function makeRepo() {
  const root = tmp();
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'README'), 'readme\n');
  git(seed, 'add', 'README');
  git(seed, 'commit', '-qm', 'first');
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n.claude/state/\nnode_modules/\n');
  git(seed, 'add', '.gitignore');
  git(seed, 'commit', '-qm', 'second');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, join(root, 'primary'));
  return { root, origin, primary: realpathSync(join(root, 'primary')) };
}

export function addWorktree(primary, name, { branch = name, detach = false } = {}) {
  const dir = join(primary, '.claude', 'worktrees', name);
  mkdirSync(dirname(dir), { recursive: true });
  if (detach) git(primary, 'worktree', 'add', '-q', '--detach', dir, 'origin/main');
  else git(primary, 'worktree', 'add', '-q', '-b', branch, dir, 'origin/main');
  return dir;
}

export function commitFile(dir, file, content, msg = `add ${file}`) {
  writeFileSync(join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

export function runNode(script, args, { cwd, env = {}, input, timeout = 60000 } = {}) {
  const e = { ...baseEnv };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env: e, encoding: 'utf8', input, timeout });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', signal: r.signal };
}

// Like runNode, but asynchronous, so several can run at once.
export function runNodeAsync(script, args, { cwd, env = {}, timeout = 60000 } = {}) {
  const e = { ...baseEnv };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return new Promise((res) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: e });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code, signal) => {
      clearTimeout(t);
      res({ code, out, err, signal });
    });
  });
}
