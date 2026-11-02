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
//   3. a milestone checked off in docs/specs/<slug>/plan.md whose
//      requirements validation.md does not prove  → the slug, milestone, ids
//   4. the gate (npm run agent:check) is red      → the failing tail
//   5. commits not on origin/<branch>             → "push"
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
//     no network for npm audit) cannot loop a session forever. The dirty,
//     proof and unpushed checks never stand aside (the proof check only for
//     a validation.md it cannot read): each is one edit to satisfy.
//   - a session that cannot fix a red is still expected to commit and push
//     it: a red branch on origin is visible; uncommitted work is not.
//
// Everything lives in this one file on purpose, like bash-guard.mjs: bare
// `node`, builtins only, and internal errors allow (fail open) — a broken
// guard must not brick every session. The gate itself is the one thing that
// fails closed: a gate that cannot run is reported as red.
//
// Knobs are read from the environment Claude Code itself was launched with
// (a hook does not see the Bash tool's shell): APEX_STOP_GATE=off,
// APEX_STOP_GATE_CMD, STOP_GATE_MAX_RED_RUNS, STOP_GATE_MAX_RED_TOTAL,
// STOP_GATE_TIMEOUT_MS.

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_GATE = 'npm run agent:check';
export const MAX_RED_RUNS = Number(process.env.STOP_GATE_MAX_RED_RUNS) || 3;
export const MAX_RED_TOTAL = Number(process.env.STOP_GATE_MAX_RED_TOTAL) || 10;
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
//   <primary>/.claude/state/stop-gate/<id>/<lane>.count       "<sha> <red runs at sha> <red runs total>"
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

// ---------------------------------------------------------------------------
// Spec proofs. A feature folder docs/specs/<slug>/ holds plan.md, whose
// milestones each carry a `Delivers: R1, R2` line and acceptance boxes, and
// validation.md, a table with Req and Status columns, one row per
// requirement. A milestone with every box checked claims its requirements
// delivered, so each must have a row whose Status begins with "proven"
// ("proven (PR #517)"); "not proven", the template's placeholder, and a
// missing row are unproven. Only folders this branch touches
// (origin/main...HEAD) are read, so a lane without a feature folder is never
// touched. A validation.md with no such table cannot be judged: the check
// stands aside with a note.
// ---------------------------------------------------------------------------

const REQ_IDS = /\bR\d+\b/g;

export function changedSpecSlugs(wt) {
  const r = git(wt, ['diff', '--name-only', 'origin/main...HEAD']);
  if (!r.ok) return [];
  const slugs = new Set();
  for (const f of r.out.split('\n')) {
    const m = /^docs\/specs\/([^/]+)\//.exec(f);
    if (m && m[1] !== '_template') slugs.add(m[1]);
  }
  return [...slugs].sort();
}

const lines = (text) => text.replace(/\r\n?/g, '\n').split('\n');
const unmarked = (s) => s.replace(/[*_`]/g, '').trim(); // **bold**, _em_, `code` are not content

// plan.md → one record per `### M<n> — <name>` heading: the ids on its
// Delivers line (a parenthetical on that line is commentary, not ids) and
// its boxes, in `-`, `*` or `1.` lists. A heading at the milestone's level or
// above ends it; a deeper one (`#### Acceptance`) is part of it. Fenced code
// is skipped, so an example box is not a box.
export function parseMilestones(plan) {
  const out = [];
  let cur = null;
  let fenced = false;
  for (const line of lines(plan)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (cur && level > cur.level) continue;
      const m = /^(M\d+[a-z]?)\b\s*(?:[—–:-]+\s*)?(.*)$/.exec(unmarked(h[2]));
      cur = m ? { id: m[1], name: m[2].trim(), delivers: [], boxes: 0, checked: 0, level } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    const d = /^\s*(?:[-*]\s+)?Delivers:?\s*(.*)$/i.exec(unmarked(line));
    if (d) {
      for (const id of d[1].replace(/\([^)]*\)/g, '').match(REQ_IDS) ?? []) if (!cur.delivers.includes(id)) cur.delivers.push(id);
      continue;
    }
    const b = /^\s*(?:[-*]|\d+\.)\s+\[([ xX])\]/.exec(line);
    if (b) {
      cur.boxes += 1;
      if (b[1] !== ' ') cur.checked += 1;
    }
  }
  return out.map(({ level: _level, ...m }) => m);
}

// A GFM table row's cells: outer pipes optional, `\|` a literal pipe.
function tableCells(line) {
  const l = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return l.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}
const isTableLine = (line) => /(?<!\\)\|/.test(line);
const isDelimiterRow = (line) => tableCells(line).every((c) => /^:?-+:?$/.test(c));

// validation.md → the Status cell of each requirement id, from every table
// whose header has Req and Status columns (a file may keep one table per
// milestone); `malformed` says what is missing when there is none.
export function parseProofs(validation) {
  const ls = lines(validation);
  const rows = new Map();
  let tables = 0;
  for (let i = 0; i + 1 < ls.length; i++) {
    if (!isTableLine(ls[i]) || !isTableLine(ls[i + 1]) || !isDelimiterRow(ls[i + 1])) continue;
    const head = tableCells(ls[i]).map((c) => unmarked(c).toLowerCase());
    const req = head.findIndex((c) => /^req/.test(c));
    const status = head.findIndex((c) => /^status/.test(c));
    if (req < 0 || status < 0) continue;
    tables += 1;
    for (i += 2; i < ls.length && isTableLine(ls[i]); i++) {
      const c = tableCells(ls[i]);
      if (c.length <= Math.max(req, status)) continue;
      for (const id of c[req].match(REQ_IDS) ?? []) rows.set(id, c[status]);
    }
  }
  return tables ? { rows, malformed: null } : { rows, malformed: 'no table with Req and Status columns' };
}

export const isProven = (status) => /^proven\b/i.test(unmarked(status ?? ''));

// What one folder leaves unproven: every milestone with all boxes checked
// whose delivered requirements lack a proven row. `validation` null is a
// missing file, which proves nothing. A malformed table returns no gaps and
// says why, so the caller can stand aside instead of guessing.
export function specProofGaps({ plan, validation }) {
  const proofs = validation === null ? { rows: new Map(), malformed: null } : parseProofs(validation);
  const gaps = [];
  for (const m of parseMilestones(plan)) {
    if (!m.boxes || m.checked < m.boxes || !m.delivers.length) continue;
    if (proofs.malformed) return { gaps: [], malformed: proofs.malformed, missing: false };
    const unproven = m.delivers.filter((id) => !isProven(proofs.rows.get(id)));
    if (unproven.length) gaps.push({ milestone: m.id, name: m.name, unproven });
  }
  return { gaps, malformed: null, missing: validation === null && gaps.length > 0 };
}

// Read and judge every feature folder this lane's branch touches. The lane
// is clean by the time this runs (check 1), so the working tree is HEAD.
export function specProofCheck(wt) {
  const notes = [];
  const lines = [];
  for (const slug of changedSpecSlugs(wt)) {
    const dir = join(wt, 'docs', 'specs', slug);
    const plan = readText(join(dir, 'plan.md'));
    if (plan === null) continue; // no plan.md: nothing is claimed
    const { gaps, malformed, missing } = specProofGaps({ plan, validation: readText(join(dir, 'validation.md')) });
    if (malformed) {
      notes.push(`docs/specs/${slug}/validation.md: ${malformed}; the proof check stood aside`);
      continue;
    }
    for (const g of gaps) {
      const claim = `${g.milestone}${g.name ? ` (${g.name})` : ''} has every box checked`;
      const proof = missing ? 'validation.md is missing, so nothing proves' : 'validation.md does not prove';
      lines.push(`  docs/specs/${slug}: ${claim}, but ${proof} ${g.unproven.join(', ')}`);
    }
  }
  return { notes, lines };
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

// Run the gate in its own process group so a timeout kills vite, vitest and
// playwright too, not just the `sh` that started them. stderr is folded into
// stdout so the tail reads in order.
export function runGate(wt, { cmd = process.env.APEX_STOP_GATE_CMD || DEFAULT_GATE, logPath, timeoutMs = GATE_TIMEOUT_MS, platform, PATH } = {}) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
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
      if (logPath) {
        try {
          writeText(logPath, `$ ${shown}\n(cwd ${wt})\n\n${out}${timedOut ? '\n[stop-gate: timed out, process group killed]\n' : ''}`);
        } catch {
          /* the log is a convenience */
        }
      }
      const tail = out.split('\n').filter(Boolean).slice(-TAIL_LINES).join('\n');
      done({ ok: status === 0 && !timedOut, timedOut, tail, cmd: shown });
    });
  });
}

// ---------------------------------------------------------------------------
// decide: the whole policy, testable. `run` is injectable.
// ---------------------------------------------------------------------------

function readCount(p) {
  const [sha = '', at = '0', total = '0'] = (readText(p) || '').trim().split(/\s+/);
  return { sha, at: Number(at) || 0, total: Number(total) || 0 };
}

export async function decide(input, { primary, run = runGate, maxRedRuns = MAX_RED_RUNS, maxRedTotal = MAX_RED_TOTAL } = {}) {
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

    // 3. A milestone checked off in plan.md claims its requirements; validation.md must prove them.
    const proofs = specProofCheck(wt);
    for (const n of proofs.notes) notes.push(`${wt}: ${n}`);
    if (proofs.lines.length) {
      return block(
        `a milestone checked off in plan.md has unproven requirements:\n${proofs.lines.join('\n')}\n` +
          `Prove each with a validation.md row whose Status begins with "proven" (e.g. "proven (PR #NNN)"), ` +
          `or uncheck the milestone's boxes. Then commit and stop again.`,
      );
    }

    // 4. Gate, cached by SHA, budgeted while red.
    const green = (readText(lp.green) || '').trim();
    if (green !== sha) {
      const c = readCount(lp.count);
      const at = c.sha === sha ? c.at : 0;
      if (at >= maxRedRuns || c.total >= maxRedTotal) {
        notes.push(
          `${wt}: gate stood aside — red ${at} time(s) at ${sha.slice(0, 7)}, ${c.total} this session (caps ${maxRedRuns}/${maxRedTotal}); ` +
            `last output: ${lp.log}. Say what is red in your report.`,
        );
      } else {
        const g = await run(wt, { logPath: lp.log });
        if (!g.ok) {
          try {
            writeText(lp.count, `${sha} ${at + 1} ${c.total + 1}`);
          } catch {
            /* the budget is a convenience */
          }
          return block(
            `${g.timedOut ? 'the gate timed out' : 'the gate is red'} at ${sha.slice(0, 7)} (\`${g.cmd}\`, run ${at + 1}/${maxRedRuns} for this commit). Last ${TAIL_LINES} lines:\n${g.tail}\n` +
              `Full output: ${lp.log}\nFix it, commit, and stop again.`,
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

    // 5. On origin, under its own name.
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
