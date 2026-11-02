#!/usr/bin/env node
// Stop hook (wired in .claude/settings.json): a session that cut a lane may
// not stop while that lane is dirty, red, or unpushed.
//
// "Done" used to live in the agent's head, so a session ended wherever the
// agent decided it had done enough: after the smallest well-defined unit, or
// at the first question it could have answered itself. This hook makes done
// mechanical. When Claude tries to end its turn it checks every lane bound to
// the session, cheapest test first:
//
//   1. uncommitted or untracked files            → "commit them" (lists them)
//   2. work already landed in origin/main         → nothing left to prove
//   3. the gate (npm run agent:check) is red      → the failing tail
//   4. commits not on origin/<branch>             → "push"
//
// and refuses the stop (exit 2, reason on stderr — Claude reads it and keeps
// working). A green run is cached by commit SHA, so a session that stops
// twice on the same commit pays for the gate once.
//
// Which lanes are "the session's": scripts/git-new.sh appends the worktree to
// .claude/state/sessions/<session id> (CLAUDE_CODE_SESSION_ID is set in every
// Bash subprocess and equals the hook's session_id; subagents share their
// parent's id, so an orchestrator that cuts three lanes is gated on all
// three). A cwd inside a linked worktree counts too. A session with neither —
// a question, a review, a plan — is never touched, and neither is a stop
// taken while background tasks are still running: that is waiting, not
// ending.
//
// Ways out, all deliberate and all visible afterwards:
//   - `scripts/stop-gate.sh blocked "<reason>"` lets exactly one stop through
//     (an irreversible action needs Shane, or an ambiguity changes the design).
//   - the gate is run at most STOP_GATE_MAX_RED_RUNS (3) times per commit and
//     STOP_GATE_MAX_RED_TOTAL (10) times per session while red; past either
//     it stands aside with a note, so an unfixable red (stale stack, a flake,
//     no network for npm audit) cannot loop a session forever. The dirty and
//     unpushed checks never stand aside: they are one command to satisfy.
//   - a session that cannot fix a red is still expected to commit and push
//     it: a red branch on origin is visible; uncommitted work is not.
//
// A red run the Mac slept through is not charged. A sleep freezes the gate
// part-way and its in-flight tests time out on wake, which says nothing about
// the commit. runGate reads kern.sleeptime before and after the run; if it
// changed, the run crossed a sleep. Up to STOP_GATE_MAX_SLEPT_RUNS (3) such
// runs per commit and STOP_GATE_MAX_SLEPT_TOTAL (5) per session go uncharged,
// and the block reason says the Mac slept. Past either cap they count like
// any red, so a closed lid cannot loop a session forever either.
//
// Everything lives in this one file on purpose, like bash-guard.mjs: bare
// `node`, builtins only, and internal errors allow (fail open) — a broken
// guard must not brick every session. The gate itself is the one thing that
// fails closed: a gate that cannot run is reported as red.
//
// Knobs are read from the environment Claude Code itself was launched with
// (a hook does not see the Bash tool's shell): APEX_STOP_GATE=off,
// APEX_STOP_GATE_CMD, STOP_GATE_MAX_RED_RUNS, STOP_GATE_MAX_RED_TOTAL,
// STOP_GATE_MAX_SLEPT_RUNS, STOP_GATE_MAX_SLEPT_TOTAL, STOP_GATE_TIMEOUT_MS.

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_GATE = 'npm run agent:check';
export const MAX_RED_RUNS = Number(process.env.STOP_GATE_MAX_RED_RUNS) || 3;
export const MAX_RED_TOTAL = Number(process.env.STOP_GATE_MAX_RED_TOTAL) || 10;
export const MAX_SLEPT_RUNS = Number(process.env.STOP_GATE_MAX_SLEPT_RUNS) || 3;
export const MAX_SLEPT_TOTAL = Number(process.env.STOP_GATE_MAX_SLEPT_TOTAL) || 5;
const GATE_TIMEOUT_MS = Number(process.env.STOP_GATE_TIMEOUT_MS) || 1_740_000; // under the 1800s hook timeout; a cloud container's e2e leg alone takes ~15 min
const TAIL_LINES = 60;

// ---------------------------------------------------------------------------
// git helpers (sync, quiet; a failure is '' not a throw)
// ---------------------------------------------------------------------------

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

// The checkout that owns .git: a linked worktree's common dir is the
// primary's .git, and the primary is its parent.
export function primaryRootOf(dir) {
  const r = git(dir, ['rev-parse', '--git-common-dir']);
  if (!r.ok) return null;
  return resolve(dir, r.out, '..');
}

// A linked worktree has a `.git` *file* pointing at <primary>/.git/worktrees/<x>.
export function isLinkedWorktree(dir) {
  try {
    const g = join(dir, '.git');
    return statSync(g).isFile() && readFileSync(g, 'utf8').startsWith('gitdir:');
  } catch {
    return false;
  }
}

// Walk up from dir to the nearest linked worktree root, if any.
export function worktreeContaining(dir) {
  let d = resolve(dir);
  for (;;) {
    if (isLinkedWorktree(d)) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

// ---------------------------------------------------------------------------
// State files
//   <primary>/.claude/state/sessions/<id>                     one lane path per line
//   <primary>/.claude/state/stop-gate/<id>/blocked            the one-stop pass
//   <primary>/.claude/state/stop-gate/<id>/<lane>.green       SHA of the last green run
//   <primary>/.claude/state/stop-gate/<id>/<lane>.count       "<sha> <red runs at sha> <red runs total> <uncharged slept runs at sha> <uncharged total>"
//   <primary>/.claude/state/stop-gate/<id>/<lane>.gate.log    full output of the last run
// ---------------------------------------------------------------------------

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

export function sessionPaths(primary, sessionId) {
  const dir = join(primary, '.claude', 'state', 'stop-gate', safe(sessionId));
  return { binding: join(primary, '.claude', 'state', 'sessions', safe(sessionId)), dir, blocked: join(dir, 'blocked') };
}

export function lanePaths(primary, sessionId, lane) {
  const { dir } = sessionPaths(primary, sessionId);
  const slug = safe(basename(lane));
  return { green: join(dir, `${slug}.green`), count: join(dir, `${slug}.count`), log: join(dir, `${slug}.gate.log`) };
}

function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeText(p, s) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
}

// The lanes this session owns, in binding order, cwd's worktree last if it
// is not already bound. Only live linked worktrees that are not the primary.
export function lanesFor({ primary, sessionId, cwd }) {
  const seen = new Set();
  const lanes = [];
  const add = (p) => {
    if (!p) return;
    const r = resolve(p.trim());
    if (seen.has(r) || r === resolve(primary)) return;
    if (!existsSync(r) || !isLinkedWorktree(r)) return;
    seen.add(r);
    lanes.push(r);
  };
  const bound = sessionId ? readText(sessionPaths(primary, sessionId).binding) : null;
  for (const line of (bound ?? '').split('\n')) add(line);
  if (cwd) add(worktreeContaining(cwd));
  return lanes;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export function dirtyFiles(wt) {
  const r = git(wt, ['status', '--porcelain', '--untracked-files=normal']);
  if (!r.ok) return [];
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3));
}

export function headSha(wt) {
  return git(wt, ['rev-parse', 'HEAD']).out || null;
}

export function branchOf(wt) {
  const r = git(wt, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.ok ? r.out : null; // detached → null
}

// git-tidy.sh's landed_in_main, verbatim in spirit: ancestry, else "would
// merging it into origin/main change main's tree?" — which holds however the
// branch landed (squash, rebase, cherry-pick). Needs git 2.38+; older git or a
// conflicting merge reads as not landed, the safe direction.
export function landedInMain(wt) {
  if (git(wt, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).ok) return true;
  const merged = git(wt, ['merge-tree', '--write-tree', 'origin/main', 'HEAD']);
  if (!merged.ok || !merged.out) return false;
  return merged.out.split('\n')[0] === git(wt, ['rev-parse', 'origin/main^{tree}']).out;
}

export function hasRemoteBranch(wt, branch) {
  return !!branch && git(wt, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`]).ok;
}

// Commits on HEAD that origin/<branch> does not have — the branch's own ref,
// not "any remote ref": a push under another name must not count. A branch
// with no remote ref is wholly unpushed; detached HEAD falls back to every
// remote ref, since there is no name to check against.
export function unpushedCount(wt, branch) {
  const r = branch
    ? hasRemoteBranch(wt, branch)
      ? git(wt, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`])
      : git(wt, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
    : git(wt, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
  return r.ok ? Number(r.out) || 0 : 0;
}

// Absolute entries only: spawn resolves a relative one against the lane, not
// against the hook's cwd where it was found.
function onPath(name, PATH) {
  for (const d of PATH.split(':')) {
    if (!isAbsolute(d)) continue;
    const p = join(d, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

// What runGate spawns. A Mac sleeps when idle, and a Stop hook runs exactly
// when the session goes idle: unheld, the e2e leg stalls at page.goto and a
// green commit spends its red budget on timeouts. On darwin the gate runs
// under `caffeinate -i -s`, which holds off idle and (on AC) system sleep
// until the gate exits and exits with its status. caffeinate and the process
// it forks to hold the assertion stay in the gate's process group, so a
// timeout kills them with the rest.
// APEX_STOP_GATE_CMD is wrapped the same way, so a test of the hook runs the
// gate the way the hook does.
export function gateArgv(cmd, { platform = process.platform, PATH = process.env.PATH ?? '' } = {}) {
  const inner = ['sh', '-c', `(${cmd}) 2>&1`];
  const caffeinate = platform === 'darwin' ? onPath('caffeinate', PATH) : null;
  return caffeinate ? { argv: [caffeinate, '-i', '-s', ...inner], shown: `caffeinate -i -s ${cmd}` } : { argv: inner, shown: cmd };
}

// `sysctl -n kern.sleeptime` prints `{ sec = 1793624521, usec = 923212 } Mon
// Nov  2 08:02:01 2026`, and sec = 0 if the Mac has not slept since boot.
// Epoch ms (0 for never), or null for anything else.
export function parseSleepTime(text) {
  const m = /\bsec = (\d+), usec = (\d+)/.exec(text ?? '');
  return m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : null;
}

// When the Mac last went to sleep, from the kernel: idle sleep, a closed lid
// and each maintenance sleep between dark wakes all stamp it. Off darwin, or
// if sysctl fails, null. Node's monotonic clock keeps counting through sleep
// on darwin, so it cannot tell.
export function lastSleepMs({ platform = process.platform, sysctl = '/usr/sbin/sysctl' } = {}) {
  if (platform !== 'darwin') return null;
  const r = spawnSync(sysctl, ['-n', 'kern.sleeptime'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? parseSleepTime(r.stdout) : null;
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

// Run the gate in its own process group so a timeout kills vite, vitest and
// playwright too, not just the `sh` that started them. stderr is folded into
// stdout so the tail reads in order. `sleptAt` is the Mac's last sleep if the
// kernel's stamp changed while the gate ran, else null. Comparing two kernel
// readings, not a stamp against our own clock, keeps a clock step from
// reading as a sleep; a failed read at either end reads as awake.
export function runGate(
  wt,
  {
    cmd = process.env.APEX_STOP_GATE_CMD || DEFAULT_GATE,
    logPath,
    timeoutMs = GATE_TIMEOUT_MS,
    platform,
    PATH,
    sysctl,
    lastSleep = () => lastSleepMs({ platform, sysctl }),
  } = {},
) {
  const readSleep = () => {
    try {
      return lastSleep();
    } catch {
      return null;
    }
  };
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    const startedAt = Date.now();
    const sleptBefore = readSleep();
    const { argv, shown } = gateArgv(cmd, { platform, PATH });
    const child = spawn(argv[0], argv.slice(1), {
      cwd: wt,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', (b) => {
      chunks.push(b);
      size += b.length;
      while (size > 8 * 1024 * 1024 && chunks.length > 1) size -= chunks.shift().length; // keep the tail
    });
    child.on('error', () => {
      /* reported via status */
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString('utf8');
      const sleptAfter = readSleep();
      const sleptAt = sleptBefore !== null && sleptAfter !== null && sleptAfter !== sleptBefore ? sleptAfter : null;
      if (logPath) {
        try {
          writeText(
            logPath,
            `$ ${shown}\n(cwd ${wt})\n\n${out}${timedOut ? '\n[stop-gate: timed out, process group killed]\n' : ''}` +
              (sleptAt !== null ? `\n[stop-gate: the Mac slept during the gate (started ${clock(startedAt)}, last sleep ${clock(sleptAt)})]\n` : ''),
          );
        } catch {
          /* the log is a convenience */
        }
      }
      const tail = out.split('\n').filter(Boolean).slice(-TAIL_LINES).join('\n');
      done({ ok: status === 0 && !timedOut, timedOut, tail, cmd: shown, sleptAt });
    });
  });
}

// ---------------------------------------------------------------------------
// decide: the whole policy, testable. `run` is injectable.
// ---------------------------------------------------------------------------

function readCount(p) {
  const [sha = '', at = '0', total = '0', slept = '0', sleptTotal = '0'] = (readText(p) || '').trim().split(/\s+/);
  return { sha, at: Number(at) || 0, total: Number(total) || 0, slept: Number(slept) || 0, sleptTotal: Number(sleptTotal) || 0 };
}

export async function decide(
  input,
  {
    primary,
    run = runGate,
    maxRedRuns = MAX_RED_RUNS,
    maxRedTotal = MAX_RED_TOTAL,
    maxSleptRuns = MAX_SLEPT_RUNS,
    maxSleptTotal = MAX_SLEPT_TOTAL,
  } = {},
) {
  const sessionId = input.session_id ?? 'unknown';
  const cwd = input.cwd || process.cwd();
  primary ??= primaryRootOf(cwd);
  if (!primary) return { action: 'allow', why: 'not a git checkout' };

  if (Array.isArray(input.background_tasks) && input.background_tasks.length) {
    return { action: 'allow', why: 'background tasks still running — this stop is a wait, not an end' };
  }

  const lanes = lanesFor({ primary, sessionId, cwd });
  if (!lanes.length) return { action: 'allow', why: 'no lane bound to this session' };

  const sp = sessionPaths(primary, sessionId);

  // Deliberate early stop: honoured once, then forgotten.
  const blocked = readText(sp.blocked);
  if (blocked !== null) {
    try {
      rmSync(sp.blocked);
    } catch {
      /* already gone */
    }
    return { action: 'allow', why: `stop-gate.sh blocked: ${blocked.trim() || '(no reason given)'}`, lanes };
  }

  const notes = [];
  for (const wt of lanes) {
    const lp = lanePaths(primary, sessionId, wt);
    const block = (reason) => ({ action: 'block', reason: `stop-gate (${wt}):\n${reason}`, lane: wt, lanes, notes });

    // 1. Dirty.
    const dirty = dirtyFiles(wt);
    if (dirty.length) {
      const shown = dirty.slice(0, 20).map((f) => `  ${f}`).join('\n');
      const more = dirty.length > 20 ? `\n  … and ${dirty.length - 20} more` : '';
      return block(
        `${dirty.length} uncommitted or untracked file(s):\n${shown}${more}\n` +
          `Commit them (or, if they are scratch, delete them; or stash with a tag: git stash push -u -m "<unique-tag>"). ` +
          `Then run the gate and push.`,
      );
    }

    const sha = headSha(wt);
    if (!sha) {
      notes.push(`${wt}: no HEAD, skipped`);
      continue;
    }

    // 2. Landed, or nothing of its own yet: nothing to prove.
    if (landedInMain(wt)) {
      notes.push(`${wt}: already in origin/main`);
      continue;
    }

    // 3. Gate, cached by SHA, budgeted while red.
    const green = (readText(lp.green) || '').trim();
    if (green !== sha) {
      const c = readCount(lp.count);
      const at = c.sha === sha ? c.at : 0;
      const slept = c.sha === sha ? c.slept : 0;
      if (at >= maxRedRuns || c.total >= maxRedTotal) {
        notes.push(
          `${wt}: gate stood aside — red ${at} time(s) at ${sha.slice(0, 7)}, ${c.total} this session (caps ${maxRedRuns}/${maxRedTotal}); ` +
            `last output: ${lp.log}. Say what is red in your report.`,
        );
      } else {
        const g = await run(wt, { logPath: lp.log });
        if (!g.ok) {
          const what = `${g.timedOut ? 'the gate timed out' : 'the gate is red'} at ${sha.slice(0, 7)} (\`${g.cmd}\``;
          const asleep = g.sleptAt != null;
          const tail = `Last ${TAIL_LINES} lines:\n${g.tail}\nFull output: ${lp.log}\n`;
          if (asleep && slept < maxSleptRuns && c.sleptTotal < maxSleptTotal) {
            try {
              writeText(lp.count, `${sha} ${at} ${c.total} ${slept + 1} ${c.sleptTotal + 1}`);
            } catch {
              /* the budget is a convenience */
            }
            return block(
              `${what}), but the Mac went to sleep during the run (last at ${clock(g.sleptAt)}), so this run is not charged to the red budget ` +
                `(uncharged run ${slept + 1}/${maxSleptRuns} for this commit, ${c.sleptTotal + 1}/${maxSleptTotal} this session; red runs still ${at}/${maxRedRuns}). ` +
                `A sleep freezes the gate and its in-flight tests time out on wake; a closed lid can sleep the Mac even under caffeinate. ` +
                tail +
                `If the failures are only timeouts, stop again to re-run the gate; if they are real, fix them, commit, and stop again.`,
            );
          }
          try {
            writeText(lp.count, `${sha} ${at + 1} ${c.total + 1} ${slept} ${c.sleptTotal}`);
          } catch {
            /* the budget is a convenience */
          }
          const spent = slept >= maxSleptRuns ? `this commit has had its ${maxSleptRuns}` : `this session has had its ${maxSleptTotal}`;
          return block(
            `${what}, run ${at + 1}/${maxRedRuns} for this commit). ` +
              (asleep ? `The Mac went to sleep during this run too (last at ${clock(g.sleptAt)}), but ${spent} uncharged runs, so this one counts. ` : '') +
              tail +
              `Fix it, commit, and stop again.`,
          );
        }
        try {
          writeText(lp.green, sha);
          rmSync(lp.count, { force: true });
        } catch {
          /* caching is a convenience */
        }
      }
    }

    // 4. On origin, under its own name.
    const branch = branchOf(wt);
    const unpushed = unpushedCount(wt, branch);
    if (unpushed > 0 || (branch && !hasRemoteBranch(wt, branch))) {
      const push = branch ? `git -C ${wt} push -u origin ${branch}` : 'push it (HEAD is detached — check out the branch first)';
      const what = unpushed > 0 ? `${unpushed} commit(s) not on origin` : `branch ${branch} is not on origin`;
      return block(`${what}. ${green === sha || !readText(lp.count) ? 'The gate is green' : 'The gate stood aside'} at ${sha.slice(0, 7)}; push:\n  ${push}`);
    }
  }

  return { action: 'allow', why: 'clean, green, pushed', lanes, notes };
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (process.env.APEX_STOP_GATE === 'off') return 0;
  let verdict;
  try {
    verdict = await decide(input, { primary: process.env.CLAUDE_PROJECT_DIR ? primaryRootOf(process.env.CLAUDE_PROJECT_DIR) : undefined });
  } catch (e) {
    process.stderr.write(`stop-gate: internal error, allowing: ${e?.message ?? e}\n`);
    return 0; // fail open
  }
  for (const n of verdict.notes ?? []) process.stderr.write(`stop-gate: ${n}\n`);
  if (verdict.action === 'block') {
    process.stderr.write(verdict.reason + '\n');
    return 2;
  }
  if (verdict.why?.startsWith('stop-gate.sh blocked')) process.stderr.write(`stop-gate: ${verdict.why}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then((code) => process.exit(code));
}
