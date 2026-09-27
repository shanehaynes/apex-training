#!/usr/bin/env node
// fleet.mjs — the fleet ledger: the orchestrator's durable memory of a fleet
// of coding agents, so a new session can resume after the old one compacted
// or ended. Without it, which lanes exist, which are rival attempts, the
// dependency edges, checked facts and judge rulings live only in one context
// window, and the next session cannot tell a losing attempt from a real lane.
//
// The ledger is append-only JSONL, one object per line with `ts` (ISO-8601
// UTC) and `op`. Lines are never rewritten; every view is the fold of all
// lines. Only the orchestrator writes it: record BEFORE every launch and
// every decision.
//
// Location: <primary>/.claude/state/fleet/ledger.jsonl, archive in
// <primary>/.claude/state/fleet/archive/. <primary> is the primary checkout,
// found with `git rev-parse --git-common-dir` from the current directory.
// Env FLEET_DIR overrides the directory (tests use it).
//
// Usage: node fleet.mjs <cmd> …
//
//   init <name> [--goal TEXT]
//       Start a fleet. A non-empty ledger is first moved to
//       archive/<ts>-<oldname>.jsonl.
//   lane <slug> [--role R] [--shape S] [--group G] [--deps a,b] [--tier T]
//        [--branch B] [--path P] [--brief FILE] [--note TEXT]
//       Declare a lane (state planned). role: impl (default), verifier,
//       reviewer, judge, race, contract, spec, adjudicator. shape: ALL
//       (default), FIRST-SUFFICIENT, BEST-OF-N. tier: T0, T1 (default), T2, T3.
//       Rival attempts share a --group. Slug already declared → exit 1.
//   set <slug> key=value [key=value …]
//       Keys: state agent sha branch path brief report round note findings
//       confirmed disputed. state: planned running reported checked merged
//       retired stopped failed. round/findings/confirmed/disputed are
//       non-negative integers. path= and brief= are stored absolute. A key
//       given twice → exit 64. Unknown slug → exit 1.
//   fact <text> --evidence TEXT [--topic T] [--from SLUG]
//       Record a checked fact; gets a sequential id F1, F2, …
//   decide <text> [--kind K] [--lane SLUG]
//       kind: judge, adjudication, merge, escalation, plan (default). For
//       judge, --lane names the winner and is required.
//   defect <slug> <text>
//       A defect found after the lane merged. Unknown slug → exit 1.
//   show [--json]
//       Current state: one row per lane, then fact/decision/defect counts.
//       --json: {name, goal, lanes, facts, decisions, defects}.
//   ready
//       Planned lanes whose every dep is merged, one per line, most
//       transitive dependents first (ties: declaration order). A planned
//       BEST-OF-N / FIRST-SUFFICIENT rival is dropped once another lane of
//       its group merged. An ungrouped lane is its own group; it never
//       joins an explicit --group of the same name.
//   check
//       One line per problem, "ERROR …" or "WARN …"; exit 1 on any ERROR.
//       Env FLEET_FIX_ROUNDS (default 3) is the escalation threshold.
//   resume
//       show, then for each running/reported/checked lane: path exists,
//       dirty-file count, and origin vs recorded sha (MATCH / DIFFERS /
//       NOT PUSHED). Read-only.
//   metrics [--json]
//       Lanes per tier and role, BEST-OF-N outcomes, reviewer findings vs
//       confirmed, disputed verifier tests, fix rounds, defects per tier.
//
// Slugs, deps and group names match [A-Za-z0-9._-]+. A flag given twice is a
// usage error. decide --lane and fact --from must name a declared lane.
//
// Writes (init lane set fact decide defect) are serialized by a mkdir lock
// in the ledger directory (ledger.lock.d, holding the owner's pid); a lock
// whose pid is dead, with no pid file for over 10 s, or older than
// FLEET_LOCK_MAX_AGE_MS is stale and reaped under a second lock (renamed to
// a unique name first; only that instance is inspected and removed).
// Writes take milliseconds; a writer that somehow holds the lock longer than
// FLEET_LOCK_MAX_AGE_MS is treated as stale and can be reaped while still
// running (accepted limitation). Every append first ends a partial last line (left by
// a crash) with a newline, so the new record is never glued onto it.
//
// Env:
//   FLEET_DIR              ledger directory (default <primary>/.claude/state/fleet)
//   FLEET_NOW              clock override, an ISO-8601 timestamp (tests)
//   FLEET_FIX_ROUNDS       check's escalation threshold (default 3)
//   FLEET_GIT_TIMEOUT_MS   timeout for each git call in resume (default 15000)
//   FLEET_LOCK_TIMEOUT_MS  how long a writer waits for the lock (default 30000)
//   FLEET_LOCK_MAX_AGE_MS  a lock older than this is reaped whatever its pid (default 60000)
// An empty env value means "use the default".
//
// --path, `set path=` and `set brief=` are stored absolute; a relative path
// resolves against the primary checkout (against cwd outside a repository).
// `lane --brief` is stored as given.
//
// resume runs git with --no-optional-locks, -c credential.helper=,
// GIT_TERMINAL_PROMPT=0 and (unless set) GIT_SSH_COMMAND='ssh -o BatchMode=yes'.
// Per lane it prints path=ok|MISSING|NOT-A-WORKTREE (the path exists but is
// not the top of a git work tree), dirty=N, push=MATCH|DIFFERS|NOT PUSHED|
// UNKNOWN (…), and AHEAD n / AHEAD ? when HEAD has commits not on origin or
// that cannot be determined (including a branch never pushed: there is no
// origin/<branch> to count from). Known limitation: when a git call times out, its
// grandchildren (e.g. ssh) may outlive resume.
//
// Exit codes: 0 ok, 1 refused/failed (or check found an ERROR), 64 usage.
// This script: Node >= 18.0, builtins only. Its test suite
// (tests/fleet.test.mjs) needs Node >= 18.8 (node:test describe/after).

import { execFileSync } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync,
  readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROLES = ['impl', 'verifier', 'reviewer', 'judge', 'race', 'contract', 'spec', 'adjudicator'];
export const SHAPES = ['ALL', 'FIRST-SUFFICIENT', 'BEST-OF-N'];
export const TIERS = ['T0', 'T1', 'T2', 'T3'];
export const STATES = ['planned', 'running', 'reported', 'checked', 'merged', 'retired', 'stopped', 'failed'];
export const KINDS = ['judge', 'adjudication', 'merge', 'escalation', 'plan'];
export const SET_KEYS = ['state', 'agent', 'sha', 'branch', 'path', 'brief', 'report', 'round', 'note', 'findings', 'confirmed', 'disputed'];
export const INT_KEYS = ['round', 'findings', 'confirmed', 'disputed'];
export const RESUME_STATES = ['running', 'reported', 'checked'];
const ENDED_STATES = ['stopped', 'failed', 'retired'];
export const NAME_RE = /^[A-Za-z0-9._-]+$/;

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 64;

export class FleetError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
const usageError = (msg) => new FleetError(msg, EXIT_USAGE);
const refuse = (msg) => new FleetError(msg, EXIT_FAIL);

export const USAGE = `usage: node fleet.mjs <cmd> …
  init <name> [--goal TEXT]
  lane <slug> [--role R] [--shape S] [--group G] [--deps a,b] [--tier T]
       [--branch B] [--path P] [--brief FILE] [--note TEXT]
  set <slug> key=value [key=value …]
  fact <text> --evidence TEXT [--topic T] [--from SLUG]
  decide <text> [--kind K] [--lane SLUG]
  defect <slug> <text>
  show [--json]
  ready
  check
  resume
  metrics [--json]
roles: ${ROLES.join(' ')}
shapes: ${SHAPES.join(' ')}   tiers: ${TIERS.join(' ')}
states: ${STATES.join(' ')}
set keys: ${SET_KEYS.join(' ')}
decide kinds: ${KINDS.join(' ')}
env: FLEET_DIR (ledger dir), FLEET_NOW (clock), FLEET_FIX_ROUNDS (default 3),
     FLEET_GIT_TIMEOUT_MS (default 15000), FLEET_LOCK_TIMEOUT_MS (default 30000),
     FLEET_LOCK_MAX_AGE_MS (default 60000); empty means default
slugs, deps, groups: [A-Za-z0-9._-]+; a flag given twice is a usage error
`;

// ─── pure logic ──────────────────────────────────────────────────────────────

export function nowIso(env = process.env) {
  if (env.FLEET_NOW) {
    const d = new Date(env.FLEET_NOW);
    if (Number.isNaN(d.getTime())) throw usageError(`FLEET_NOW is not a date: ${env.FLEET_NOW}`);
    return d.toISOString();
  }
  return new Date().toISOString();
}

/** Parse ledger text into events. Unparseable lines are reported, not fatal. */
export function parseLedger(text) {
  const events = [];
  const bad = [];
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object' && typeof ev.op === 'string') events.push(ev);
      else bad.push(i + 1);
    } catch {
      bad.push(i + 1);
    }
  });
  return { events, bad };
}

export function splitDeps(s) {
  if (Array.isArray(s)) return s.map(String).map((x) => x.trim()).filter(Boolean);
  if (s === undefined || s === null) return [];
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}

/** Fold ledger events into the current fleet state. */
export function fold(events) {
  const state = { name: null, goal: null, lanes: [], facts: [], decisions: [], defects: [] };
  const bySlug = new Map();
  for (const ev of events) {
    const { op, ts } = ev;
    if (op === 'init') {
      state.name = ev.name ?? null;
      state.goal = ev.goal ?? null;
    } else if (op === 'lane') {
      if (!ev.slug || bySlug.has(ev.slug)) continue;
      const lane = { slug: ev.slug, role: 'impl', shape: 'ALL', tier: 'T1', deps: [], state: 'planned' };
      for (const [k, v] of Object.entries(ev)) {
        if (k === 'op' || k === 'ts' || v === undefined) continue;
        lane[k] = k === 'deps' ? splitDeps(v) : v;
      }
      lane.declared = ts;
      bySlug.set(lane.slug, lane);
      state.lanes.push(lane);
    } else if (op === 'set') {
      const lane = bySlug.get(ev.slug);
      if (!lane || !ev.values || typeof ev.values !== 'object') continue;
      Object.assign(lane, ev.values);
      lane.updated = ts;
    } else if (op === 'fact') {
      const f = { id: ev.id, text: ev.text, evidence: ev.evidence, ts };
      if (ev.topic !== undefined) f.topic = ev.topic;
      if (ev.from !== undefined) f.from = ev.from;
      state.facts.push(f);
    } else if (op === 'decide') {
      const d = { text: ev.text, kind: ev.kind ?? 'plan', ts };
      if (ev.lane !== undefined) d.lane = ev.lane;
      state.decisions.push(d);
    } else if (op === 'defect') {
      state.defects.push({ lane: ev.lane, text: ev.text, ts });
    }
  }
  return state;
}

const laneMap = (state) => new Map(state.lanes.map((l) => [l.slug, l]));

/** slug → array of declared lanes that list it as a dep (each at most once). */
function directDependents(state) {
  const direct = new Map(state.lanes.map((l) => [l.slug, new Set()]));
  for (const l of state.lanes) for (const d of l.deps) if (direct.has(d)) direct.get(d).add(l.slug);
  return direct;
}

/** How many distinct lanes depend on slug, directly or transitively (BFS). */
function countDependents(direct, slug) {
  const seen = new Set();
  const stack = [...direct.get(slug)];
  while (stack.length) {
    const s = stack.pop();
    if (seen.has(s)) continue;
    seen.add(s);
    for (const t of direct.get(s)) if (!seen.has(t)) stack.push(t);
  }
  seen.delete(slug); // a cycle through itself is not a dependent
  return seen.size;
}

/** slug → Set of slugs that depend on it, directly or transitively. O(n²); not used by ready. */
export function transitiveDependents(state) {
  const direct = directDependents(state);
  const out = new Map();
  for (const l of state.lanes) {
    const seen = new Set();
    const stack = [...direct.get(l.slug)];
    while (stack.length) {
      const s = stack.pop();
      if (seen.has(s)) continue;
      seen.add(s);
      for (const t of direct.get(s)) if (!seen.has(t)) stack.push(t);
    }
    seen.delete(l.slug);
    out.set(l.slug, seen);
  }
  return out;
}

const RIVAL_SHAPES = ['BEST-OF-N', 'FIRST-SUFFICIENT'];

/**
 * Planned lanes whose every dep is declared and merged, best-first. A planned
 * rival (BEST-OF-N / FIRST-SUFFICIENT) is never ready once another lane of
 * its group has merged. Dependents are counted only for the candidates, so a
 * long chain (one candidate) is linear.
 */
export function readyLanes(state) {
  const lanes = laneMap(state);
  const mergedGroups = new Set();
  for (const l of state.lanes) if (l.state === 'merged') mergedGroups.add(groupKey(l));
  const candidates = [];
  state.lanes.forEach((l, idx) => {
    if (l.state !== 'planned') return;
    if (!l.deps.every((d) => lanes.has(d) && lanes.get(d).state === 'merged')) return;
    if (RIVAL_SHAPES.includes(l.shape) && mergedGroups.has(groupKey(l))) return;
    candidates.push({ l, idx });
  });
  if (!candidates.length) return [];
  const direct = directDependents(state);
  for (const c of candidates) c.n = countDependents(direct, c.l.slug);
  candidates.sort((a, b) => (b.n - a.n) || (a.idx - b.idx));
  return candidates.map(({ l }) => l.slug);
}

/** Every dependency cycle among declared lanes, each as [a, b, …, a]. */
export function findCycles(state) {
  const lanes = laneMap(state);
  const order = new Map(state.lanes.map((l, i) => [l.slug, i]));
  const adj = (s) => lanes.get(s).deps.filter((d) => lanes.has(d));
  // Tarjan's strongly connected components (iterative).
  let index = 0;
  const idx = new Map(); const low = new Map(); const onStack = new Set(); const stack = [];
  const sccs = [];
  for (const root of state.lanes.map((l) => l.slug)) {
    if (idx.has(root)) continue;
    const work = [[root, 0]];
    idx.set(root, index); low.set(root, index); index++; stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const next = adj(v);
      if (i < next.length) {
        frame[1]++;
        const w = next[i];
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++; stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low.set(p, Math.min(low.get(p), low.get(v)));
        }
        if (low.get(v) === idx.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          sccs.push(comp);
        }
      }
    }
  }
  const cycles = [];
  for (const comp of sccs) {
    const members = new Set(comp);
    const start = [...comp].sort((a, b) => order.get(a) - order.get(b))[0];
    if (comp.length === 1 && !adj(start).includes(start)) continue;
    // BFS inside the component for the shortest path start → … → start.
    const prev = new Map();
    const queue = [start];
    let found = null;
    const seen = new Set();
    while (queue.length && !found) {
      const v = queue.shift();
      for (const w of adj(v)) {
        if (!members.has(w)) continue;
        if (w === start) { found = v; break; }
        if (!seen.has(w)) { seen.add(w); prev.set(w, v); queue.push(w); }
      }
    }
    const path = [start];
    for (let v = found; v !== start; v = prev.get(v)) path.splice(1, 0, v);
    path.push(start);
    cycles.push(path);
  }
  cycles.sort((a, b) => order.get(a[0]) - order.get(b[0]));
  return cycles;
}

const hasGroup = (l) => l.group !== undefined && l.group !== null && l.group !== '';
/**
 * Group identity for rival attempts: the explicit --group, or (ungrouped) the
 * lane alone. The two namespaces never mix: an ungrouped lane `api` is not a
 * member of an explicit group `api`.
 */
export const groupKey = (l) => (hasGroup(l) ? `group:${l.group}` : `lane:${l.slug}`);
const groupName = (l) => (hasGroup(l) ? String(l.group) : l.slug);

/** groupKey → {name, members} for lanes of one shape. */
function groups(state, shape) {
  const out = new Map();
  for (const l of state.lanes) {
    if (l.shape !== shape) continue;
    const k = groupKey(l);
    if (!out.has(k)) out.set(k, { name: groupName(l), members: [] });
    out.get(k).members.push(l);
  }
  return out;
}

/** The latest judge ruling naming any lane of the group, or null. */
export function standingWinner(state, members) {
  const slugs = new Set(members.map((l) => l.slug));
  let winner = null;
  for (const d of state.decisions) if (d.kind === 'judge' && slugs.has(d.lane)) winner = d.lane;
  return winner;
}

export function fixRoundsThreshold(env = process.env) {
  return envInt(env, 'FLEET_FIX_ROUNDS', 3, 1);
}

/** Problems in the fleet: [{level: 'ERROR'|'WARN', message}]. */
export function checkState(state, { fixRounds = 3 } = {}) {
  const problems = [];
  const err = (message) => problems.push({ level: 'ERROR', message });
  const warn = (message) => problems.push({ level: 'WARN', message });
  const lanes = laneMap(state);

  for (const l of state.lanes) {
    for (const d of l.deps) if (!lanes.has(d)) err(`lane ${l.slug}: dep ${d} is not a declared lane`);
  }
  for (const c of findCycles(state)) err(`dependency cycle: ${c.join(' -> ')}`);

  for (const { name: g, members } of groups(state, 'BEST-OF-N').values()) {
    const merged = members.filter((l) => l.state === 'merged');
    if (merged.length > 1) {
      err(`BEST-OF-N group ${g}: ${merged.length} lanes merged (${merged.map((l) => l.slug).join(', ')}) — only the judged winner may merge`);
    }
    const winner = standingWinner(state, members);
    for (const l of merged) {
      if (winner === null) {
        err(`BEST-OF-N lane ${l.slug} merged with no judge decision naming it (decide --kind judge --lane ${l.slug})`);
      } else if (winner !== l.slug) {
        err(`BEST-OF-N lane ${l.slug} merged but the standing judge winner of group ${g} is ${winner}`);
      }
    }
  }

  for (const l of state.lanes) {
    if (l.state !== 'planned') continue;
    for (const d of l.deps) {
      const dep = lanes.get(d);
      if (dep && ENDED_STATES.includes(dep.state)) warn(`lane ${l.slug}: blocked: dep ${d} is ${dep.state}`);
    }
  }

  const explicitGroups = new Map();
  for (const l of state.lanes) {
    if (!hasGroup(l)) continue; // A31: explicit groups only
    if (!explicitGroups.has(l.group)) explicitGroups.set(l.group, []);
    explicitGroups.get(l.group).push(l);
  }
  for (const [g, members] of explicitGroups) {
    if (new Set(members.map((l) => l.shape)).size > 1) {
      warn(`group ${g} mixes shapes: ${members.map((l) => `${l.slug}=${l.shape}`).join(', ')}`);
    }
  }

  for (const l of state.lanes) {
    if (Number.isInteger(l.round) && l.round >= fixRounds) {
      warn(`lane ${l.slug}: round ${l.round} >= ${fixRounds} fix rounds — escalate`);
    }
  }

  const named = new Set(state.decisions.filter((d) => d.lane).map((d) => d.lane));
  for (const { name: g, members } of groups(state, 'FIRST-SUFFICIENT').values()) {
    const allEnded = members.every((l) => ENDED_STATES.includes(l.state));
    const decided = members.some((l) => named.has(l.slug));
    if (allEnded && !decided) {
      warn(`FIRST-SUFFICIENT group ${g}: every lane is stopped/failed/retired (${members.map((l) => `${l.slug}=${l.state}`).join(', ')}) — race ended with no win`);
    }
  }

  for (const l of state.lanes) {
    if (l.state === 'running' && (l.agent === undefined || l.agent === '')) {
      warn(`lane ${l.slug}: state running with no agent (set ${l.slug} agent=…)`);
    }
  }
  return problems;
}

/** Fleet metrics from the folded state. */
export function computeMetrics(state) {
  const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
  const lanesPerTier = zero(TIERS);
  const lanesPerRole = zero(ROLES);
  for (const l of state.lanes) {
    lanesPerTier[l.tier] = (lanesPerTier[l.tier] ?? 0) + 1;
    lanesPerRole[l.role] = (lanesPerRole[l.role] ?? 0) + 1;
  }

  const bon = groups(state, 'BEST-OF-N');
  let judgedGroups = 0;
  let winnerNotFirst = 0;
  for (const { members } of bon.values()) {
    const winner = standingWinner(state, members); // the latest ruling stands
    if (winner === null) continue;
    judgedGroups++;
    if (winner !== members[0].slug) winnerNotFirst++;
  }

  const sum = (ls, k) => ls.reduce((a, l) => a + (Number.isInteger(l[k]) ? l[k] : 0), 0);
  const reviewers = state.lanes.filter((l) => l.role === 'reviewer');
  const verifiers = state.lanes.filter((l) => l.role === 'verifier');

  const rounds = state.lanes.filter((l) => Number.isInteger(l.round)).map((l) => l.round);
  const fixRounds = {
    lanes: rounds.length,
    max: rounds.length ? Math.max(...rounds) : null,
    mean: rounds.length ? rounds.reduce((a, b) => a + b, 0) / rounds.length : null,
  };

  const defectsPerTier = zero(TIERS);
  const lanes = laneMap(state);
  for (const d of state.defects) {
    const tier = lanes.get(d.lane)?.tier ?? 'unknown';
    defectsPerTier[tier] = (defectsPerTier[tier] ?? 0) + 1;
  }

  return {
    lanes: state.lanes.length,
    lanesPerTier,
    lanesPerRole,
    bestOfN: { groups: bon.size, judged: judgedGroups, winnerNotFirst },
    reviewer: { lanes: reviewers.length, findings: sum(reviewers, 'findings'), confirmed: sum(reviewers, 'confirmed') },
    verifier: { lanes: verifiers.length, disputed: sum(verifiers, 'disputed') },
    fixRounds,
    defects: state.defects.length,
    defectsPerTier,
  };
}

// ─── formatting ──────────────────────────────────────────────────────────────

const dash = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));

function table(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join('  ').trimEnd()).join('\n');
}

export function formatShow(state) {
  const out = [];
  out.push(`fleet: ${dash(state.name)}${state.goal ? ` — ${state.goal}` : ''}`);
  if (state.lanes.length) {
    const rows = [['SLUG', 'ROLE', 'SHAPE', 'GROUP', 'TIER', 'STATE', 'DEPS', 'SHA', 'ROUND', 'AGENT']];
    for (const l of state.lanes) {
      rows.push([
        l.slug, l.role, l.shape, dash(l.group), l.tier, l.state,
        l.deps.length ? l.deps.join(',') : '-',
        l.sha ? String(l.sha).slice(0, 12) : '-',
        dash(l.round), dash(l.agent),
      ]);
    }
    out.push(table(rows));
  } else {
    out.push('(no lanes)');
  }
  out.push(`facts: ${state.facts.length}  decisions: ${state.decisions.length}  defects: ${state.defects.length}`);
  return `${out.join('\n')}\n`;
}

export function showJson(state) {
  return {
    name: state.name,
    goal: state.goal,
    lanes: state.lanes,
    facts: state.facts,
    decisions: state.decisions,
    defects: state.defects,
  };
}

export function formatMetrics(m) {
  const kv = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
  const mean = m.fixRounds.mean === null ? '-' : String(Math.round(m.fixRounds.mean * 100) / 100);
  return [
    `lanes: ${m.lanes}`,
    `lanes per tier: ${kv(m.lanesPerTier)}`,
    `lanes per role: ${kv(m.lanesPerRole)}`,
    `BEST-OF-N groups: ${m.bestOfN.groups}  judged: ${m.bestOfN.judged}  winner not first-declared: ${m.bestOfN.winnerNotFirst}`,
    `reviewer findings: ${m.reviewer.findings}  confirmed: ${m.reviewer.confirmed}  (${m.reviewer.lanes} reviewer lanes)`,
    `verifier disputed tests: ${m.verifier.disputed}  (${m.verifier.lanes} verifier lanes)`,
    `fix rounds: max=${dash(m.fixRounds.max)} mean=${mean}  (${m.fixRounds.lanes} lanes with round set)`,
    `defects: ${m.defects}  per tier: ${kv(m.defectsPerTier)}`,
  ].join('\n') + '\n';
}

// ─── argument parsing ────────────────────────────────────────────────────────

const COMMANDS = {
  init: { min: 1, max: 1, flags: { goal: 'str' } },
  lane: {
    min: 1, max: 1,
    flags: { role: 'str', shape: 'str', group: 'str', deps: 'str', tier: 'str', branch: 'str', path: 'str', brief: 'str', note: 'str' },
  },
  set: { min: 2, max: Infinity, flags: {} },
  fact: { min: 1, max: Infinity, flags: { evidence: 'str', topic: 'str', from: 'str' } },
  decide: { min: 1, max: Infinity, flags: { kind: 'str', lane: 'str' } },
  defect: { min: 2, max: Infinity, flags: {} },
  show: { min: 0, max: 0, flags: { json: 'bool' } },
  ready: { min: 0, max: 0, flags: {} },
  check: { min: 0, max: 0, flags: {} },
  resume: { min: 0, max: 0, flags: {} },
  metrics: { min: 0, max: 0, flags: { json: 'bool' } },
};

/** Parse argv (after `node fleet.mjs`) → {cmd, pos, flags}; throws 64 on misuse. */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) throw usageError('no command');
  const spec = COMMANDS[cmd];
  if (!spec) throw usageError(`unknown command: ${cmd}`);
  const pos = [];
  const flags = {};
  let onlyPos = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!onlyPos && a === '--') { onlyPos = true; continue; }
    if (!onlyPos && a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq === -1 ? undefined : eq);
      const type = Object.prototype.hasOwnProperty.call(spec.flags, name) ? spec.flags[name] : undefined;
      if (!type) throw usageError(`unknown flag for ${cmd}: --${name}`);
      if (Object.prototype.hasOwnProperty.call(flags, name)) throw usageError(`--${name} given more than once`);
      if (type === 'bool') {
        if (eq !== -1) throw usageError(`--${name} takes no value`);
        flags[name] = true;
      } else if (eq !== -1) {
        flags[name] = a.slice(eq + 1);
      } else {
        if (i + 1 >= rest.length) throw usageError(`--${name} needs a value`);
        flags[name] = rest[++i];
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length < spec.min) throw usageError(`${cmd}: missing argument`);
  if (pos.length > spec.max) throw usageError(`${cmd}: unexpected argument: ${pos[spec.max]}`);
  return { cmd, pos, flags };
}

function oneOf(value, allowed, what) {
  if (!allowed.includes(value)) throw usageError(`invalid ${what}: ${value} (one of: ${allowed.join(', ')})`);
  return value;
}

function slugOk(value, what) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) throw usageError(`invalid ${what}: ${JSON.stringify(value)} (must match [A-Za-z0-9._-]+)`);
  return value;
}

function nonEmpty(value, what) {
  if (typeof value !== 'string' || !value.trim()) throw usageError(`${what} must not be empty`);
  return value;
}

/** Parse `key=value` pairs for `set`; throws 64 on unknown key or bad value. */
export function parseSetPairs(pairs) {
  const values = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq <= 0) throw usageError(`set: expected key=value, got: ${p}`);
    const key = p.slice(0, eq);
    const raw = p.slice(eq + 1);
    if (!SET_KEYS.includes(key)) throw usageError(`set: unknown key: ${key} (one of: ${SET_KEYS.join(', ')})`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw usageError(`set: key ${key} given more than once`);
    if (key === 'state') values.state = oneOf(raw, STATES, 'state');
    else if (INT_KEYS.includes(key)) {
      if (!/^\d+$/.test(raw)) throw usageError(`set: ${key} must be a non-negative integer, got: ${raw}`);
      values[key] = Number(raw);
    } else values[key] = raw;
  }
  return values;
}

// ─── env ─────────────────────────────────────────────────────────────────────

/**
 * A non-negative integer from env; unset, empty or invalid → the default
 * (A70: empty means "use the default"), below min → the default.
 */
export function envInt(env, name, def, min = 0) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return def;
  const n = Number(s);
  return n >= min ? n : def;
}

// ─── git ─────────────────────────────────────────────────────────────────────

export function gitTimeoutMs(env = process.env) {
  return envInt(env, 'FLEET_GIT_TIMEOUT_MS', 15000, 1);
}

/** The environment every git call runs with: no prompts, no interactive ssh. */
export function gitEnv(env = process.env) {
  const out = { ...env, GIT_TERMINAL_PROMPT: '0' };
  if (!out.GIT_SSH_COMMAND) out.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return out;
}

export class GitTimeout extends Error {}

/**
 * Run git read-only and non-interactively: --no-optional-locks, credential
 * helpers disabled, a hard timeout. Throws GitTimeout on timeout.
 */
function git(args, cwd, env = process.env) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'credential.helper=', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv(env), timeout: gitTimeoutMs(env), killSignal: 'SIGKILL',
    });
  } catch (e) {
    if (e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL')) throw new GitTimeout(`git ${args[0]} timed out`);
    throw e;
  }
}

/** The primary checkout (realpath) for cwd, or null outside a git repository. */
export function primaryDir(env = process.env, cwd = process.cwd()) {
  let common;
  try {
    common = git(['rev-parse', '--git-common-dir'], cwd, env).trim();
  } catch {
    return null;
  }
  const abs = isAbsolute(common) ? common : resolve(cwd, common);
  const primary = resolve(abs, '..');
  try { return realpathSync(primary); } catch { return primary; } // pwd -P
}

/** The ledger directory: FLEET_DIR, else <primary>/.claude/state/fleet. */
export function fleetDir(env = process.env, cwd = process.cwd()) {
  if (env.FLEET_DIR) return resolve(cwd, env.FLEET_DIR);
  const primary = primaryDir(env, cwd);
  if (primary === null) throw refuse('not inside a git repository (set FLEET_DIR to use a ledger elsewhere)');
  return join(primary, '.claude', 'state', 'fleet');
}

/**
 * A lane path as stored: absolute and normalized. Relative paths resolve
 * against the primary checkout (or cwd outside a repository). Empty stays
 * empty (it clears the field).
 */
export function absoluteLanePath(p, env = process.env, cwd = process.cwd()) {
  if (p === '' || isAbsolute(p)) return p === '' ? p : resolve(p);
  return resolve(primaryDir(env, cwd) ?? cwd, p);
}

// ─── lock ────────────────────────────────────────────────────────────────────
//
// mkdir lock <dir>/ledger.lock.d holding a file `pid` = "<pid> <token>".
// Stale when: its pid is dead; or it has no pid file after LOCK_NOPID_GRACE_MS;
// or it is older than FLEET_LOCK_MAX_AGE_MS (default 60000) whatever its pid
// says (a reused pid — even pid 1 — cannot wedge the ledger). Reaping is
// serialized by <dir>/ledger.lock.reap.d and works on one instance: the lock
// is first renamed to a unique name, and only that renamed instance is
// inspected and removed; if it turns out to be live it is put back.

export const LOCK_NAME = 'ledger.lock.d';
const REAP_NAME = 'ledger.lock.reap.d';
export const LOCK_NOPID_GRACE_MS = 10000;
const REAP_STALE_MS = 30000;

const sleepMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const uniqueSuffix = () => `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLockInfo(lockDir) {
  try {
    const [pid, token] = readFileSync(join(lockDir, 'pid'), 'utf8').trim().split(/\s+/);
    return { pid: /^\d+$/.test(pid ?? '') ? Number(pid) : null, token: token ?? null };
  } catch {
    return null;
  }
}

/** Why a lock instance is stale, or null if it is (or may be) live. */
export function lockStaleReason(lockDir, { now = Date.now(), maxAgeMs = 60000 } = {}) {
  let st;
  try { st = statSync(lockDir); } catch { return null; } // gone: nothing to reap
  const age = now - st.mtimeMs;
  if (age > maxAgeMs) return `older than ${maxAgeMs} ms`;
  const info = readLockInfo(lockDir);
  if (info && info.pid !== null) return pidAlive(info.pid) ? null : `pid ${info.pid} is dead`;
  return age > LOCK_NOPID_GRACE_MS ? `no pid after ${LOCK_NOPID_GRACE_MS} ms` : null;
}

/** Back-compat boolean form. */
export function lockIsStale(lockDir, now = Date.now(), maxAgeMs = 60000) {
  return lockStaleReason(lockDir, { now, maxAgeMs }) !== null;
}

/** Break a reap directory left by a crashed reaper: atomic rename, then remove. */
function breakStaleReap(reap) {
  try {
    if (Date.now() - statSync(reap).mtimeMs <= REAP_STALE_MS) return;
    const moved = `${reap}.broken-${uniqueSuffix()}`;
    renameSync(reap, moved);
    rmSync(moved, { recursive: true, force: true });
  } catch { /* raced with its owner or another breaker */ }
}

/** Reap a stale ledger lock. Returns true if one was removed. */
export function reapStaleLock(dir, env = process.env) {
  const lock = join(dir, LOCK_NAME);
  const reap = join(dir, REAP_NAME);
  const maxAgeMs = envInt(env, 'FLEET_LOCK_MAX_AGE_MS', 60000, 1);
  if (lockStaleReason(lock, { maxAgeMs }) === null) return false; // cheap filter
  try {
    mkdirSync(reap);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    breakStaleReap(reap);
    return false;
  }
  try {
    const moved = `${lock}.reaping-${uniqueSuffix()}`;
    try { renameSync(lock, moved); } catch { return false; } // released meanwhile
    // Decide on the instance we now own exclusively.
    if (lockStaleReason(moved, { maxAgeMs }) !== null) {
      rmSync(moved, { recursive: true, force: true });
      return true;
    }
    try { renameSync(moved, lock); } catch { /* a new holder took the name; leave it */ }
    return false;
  } finally {
    try { rmdirSync(reap); } catch { /* broken by another after REAP_STALE_MS */ }
  }
}

/** Run fn while holding the ledger directory's write lock. */
export function withLock(dir, fn, env = process.env) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, LOCK_NAME);
  const deadline = Date.now() + envInt(env, 'FLEET_LOCK_TIMEOUT_MS', 30000, 0);
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    reapStaleLock(dir, env);
    if (Date.now() > deadline) {
      const info = readLockInfo(lock);
      const holder = info && info.pid !== null ? `pid ${info.pid}` : 'no pid recorded';
      const maxAge = envInt(env, 'FLEET_LOCK_MAX_AGE_MS', 60000, 1);
      throw refuse(`ledger lock ${lock} is held (${holder}); another fleet.mjs write may be in progress. `
        + `It is reaped automatically after ${maxAge} ms; if no fleet.mjs is running, clear it now with: rm -rf '${lock}'`);
    }
    sleepMs(10 + Math.floor(Math.random() * 30));
  }
  const token = uniqueSuffix();
  try {
    writeFileSync(join(lock, 'pid'), `${process.pid} ${token}\n`);
    return fn();
  } finally {
    releaseLock(lock, token);
  }
}

/** Remove the lock only if it is still our instance. */
function releaseLock(lock, token) {
  const moved = `${lock}.release-${token}`;
  try { renameSync(lock, moved); } catch { return; } // already reaped
  const info = readLockInfo(moved);
  if (info && info.token === token) {
    rmSync(moved, { recursive: true, force: true });
  } else {
    try { renameSync(moved, lock); } catch { /* the name was taken again; leave it */ }
  }
}

// ─── ledger ──────────────────────────────────────────────────────────────────

export class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'ledger.jsonl');
    this.archiveDir = join(dir, 'archive');
  }

  text() {
    return existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
  }

  load(stderr) {
    const { events, bad } = parseLedger(this.text());
    if (bad.length && stderr) stderr.write(`fleet: ignoring unparseable ledger line(s): ${bad.join(', ')}\n`);
    return events;
  }

  /** True when the ledger is non-empty and its last byte is not a newline. */
  endsPartial() {
    if (!existsSync(this.file)) return false;
    const fd = openSync(this.file, 'r');
    try {
      const { size } = fstatSync(fd);
      if (size === 0) return false;
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, size - 1);
      return b[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  }

  append(record) {
    mkdirSync(this.dir, { recursive: true });
    // A crash can leave a partial last line; never glue the new record onto it.
    const prefix = this.endsPartial() ? '\n' : '';
    appendFileSync(this.file, `${prefix}${JSON.stringify(record)}\n`);
  }

  /** Move a non-empty ledger to archive/<ts>-<name>.jsonl; returns the path or null. */
  archive(ts) {
    if (!existsSync(this.file) || !this.text().trim()) return null;
    const old = fold(parseLedger(this.text()).events);
    const name = String(old.name ?? 'unnamed').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '') || 'unnamed';
    const stamp = ts.replace(/:/g, '-');
    mkdirSync(this.archiveDir, { recursive: true });
    let target = join(this.archiveDir, `${stamp}-${name}.jsonl`);
    for (let n = 2; existsSync(target); n++) target = join(this.archiveDir, `${stamp}-${name}-${n}.jsonl`);
    renameSync(this.file, target);
    return target;
  }
}

// ─── resume ──────────────────────────────────────────────────────────────────

const firstLine = (e) => String((e && (e.stderr || e.message)) || e).trim().split('\n')[0];

/** Is dir the top level of a git work tree (not merely inside one)? */
function isWorktreeRoot(dir, env) {
  try {
    const top = git(['rev-parse', '--show-toplevel'], dir, env).trim();
    return realpathSync(top) === realpathSync(dir);
  } catch {
    return false;
  }
}

/**
 * Inspect one lane on disk and on origin. Read-only.
 * pathState: null (no path) | 'ok' | 'MISSING' | 'NOT-A-WORKTREE'.
 * ahead: null (not applicable) | number | '?' (could not be determined).
 */
export function inspectLane(lane, cwd = process.cwd(), env = process.env) {
  const r = {
    slug: lane.slug, state: lane.state, path: lane.path ?? null, pathState: null, pathExists: null,
    dirty: null, push: null, remoteSha: null, ahead: null, detail: '',
  };
  if (lane.path) {
    r.pathExists = existsSync(lane.path) && statSync(lane.path).isDirectory();
    if (!r.pathExists) r.pathState = 'MISSING';
    else if (!isWorktreeRoot(lane.path, env)) r.pathState = 'NOT-A-WORKTREE';
    else {
      r.pathState = 'ok';
      try {
        const out = git(['status', '--porcelain'], lane.path, env);
        r.dirty = out.split('\n').filter((x) => x.length).length;
      } catch { r.dirty = null; }
    }
  }
  const inWorktree = r.pathState === 'ok';
  if (lane.branch) {
    const where = inWorktree ? lane.path : cwd;
    try {
      const out = git(['ls-remote', 'origin', `refs/heads/${lane.branch}`], where, env).trim();
      const line = out.split('\n').find((x) => x.endsWith(`\trefs/heads/${lane.branch}`));
      if (!line) {
        r.push = 'NOT PUSHED';
        r.detail = `origin has no ${lane.branch}`;
      } else {
        r.remoteSha = line.split('\t')[0];
        const rec = lane.sha ? String(lane.sha).toLowerCase() : '';
        if (rec && rec.length >= 4 && r.remoteSha.startsWith(rec)) {
          r.push = 'MATCH';
          r.detail = `origin ${lane.branch} = ${r.remoteSha.slice(0, 12)}`;
        } else {
          r.push = 'DIFFERS';
          r.detail = rec
            ? `origin ${lane.branch} = ${r.remoteSha.slice(0, 12)}, recorded ${rec.slice(0, 12)}`
            : `origin ${lane.branch} = ${r.remoteSha.slice(0, 12)}, no sha recorded`;
        }
      }
    } catch (e) {
      r.push = 'UNKNOWN';
      r.detail = e instanceof GitTimeout ? 'timeout' : `ls-remote failed: ${firstLine(e)}`;
    }
    if (r.pathState === 'NOT-A-WORKTREE') r.ahead = '?';
    else if (inWorktree && r.push === 'NOT PUSHED') r.ahead = '?'; // no origin/<branch> to count from
    else if (inWorktree) r.ahead = aheadOfOrigin(lane, r.push === 'UNKNOWN' ? null : r.remoteSha, env);
  }
  return r;
}

/**
 * Commits on the worktree's HEAD not on origin/<branch>, or '?'. With a
 * known remote sha the count is against that commit, and '?' if it is not
 * present locally (a stale tracking ref would miscount). Only when origin
 * could not be asked does it fall back to refs/remotes/origin/<branch>.
 */
function aheadOfOrigin(lane, remoteSha, env) {
  const base = remoteSha ?? `refs/remotes/origin/${lane.branch}`;
  try {
    git(['cat-file', '-e', `${base}^{commit}`], lane.path, env);
    return Number(git(['rev-list', '--count', `${base}..HEAD`], lane.path, env).trim());
  } catch {
    return '?';
  }
}

export function formatInspection(r) {
  const path = r.pathState === null ? 'path=-' : `path=${r.pathState} ${r.path}`;
  const dirty = `dirty=${r.dirty === null ? '-' : r.dirty}`;
  const push = r.push === null ? 'push=- (no branch)' : `push=${r.push} (${r.detail})`;
  const ahead = r.ahead === '?' || r.ahead > 0 ? `  AHEAD ${r.ahead}` : '';
  return `${r.slug}  state=${r.state}  ${path}  ${dirty}  ${push}${ahead}`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

/** Run one command. Returns the exit code; never calls process.exit. */
export function run(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
      stdout.write(USAGE);
      return EXIT_OK;
    }
    const { cmd, pos, flags } = parseArgs(argv);

    // Validate everything that is a usage error before touching the disk.
    let setValues;
    if (cmd === 'init') nonEmpty(pos[0], 'name');
    if (cmd === 'lane') {
      slugOk(pos[0], 'slug');
      oneOf(flags.role ?? 'impl', ROLES, 'role');
      oneOf(flags.shape ?? 'ALL', SHAPES, 'shape');
      oneOf(flags.tier ?? 'T1', TIERS, 'tier');
      if (flags.group !== undefined) slugOk(flags.group, 'group');
      for (const d of splitDeps(flags.deps)) slugOk(d, 'dep');
    }
    if (cmd === 'set') {
      slugOk(pos[0], 'slug');
      setValues = parseSetPairs(pos.slice(1));
    }
    if (cmd === 'fact') {
      nonEmpty(pos.join(' '), 'fact text');
      if (flags.evidence === undefined) throw usageError('fact: --evidence is required');
      nonEmpty(flags.evidence, '--evidence');
      if (flags.from !== undefined) slugOk(flags.from, '--from');
    }
    if (cmd === 'decide') {
      nonEmpty(pos.join(' '), 'decision text');
      oneOf(flags.kind ?? 'plan', KINDS, 'kind');
      if ((flags.kind ?? 'plan') === 'judge' && !flags.lane) throw usageError('decide --kind judge: --lane <winner> is required');
      if (flags.lane !== undefined) slugOk(flags.lane, '--lane');
    }
    if (cmd === 'defect') {
      slugOk(pos[0], 'slug');
      nonEmpty(pos.slice(1).join(' '), 'defect text');
    }

    const ledger = new Ledger(fleetDir(env, cwd));
    const state = () => fold(ledger.load(stderr));
    const declared = (slug) => state().lanes.some((l) => l.slug === slug);

    // Writes: read, validate against the fold and append under one lock, so
    // concurrent writers never duplicate a fact id or a slug.
    const write = (fn) => withLock(ledger.dir, () => fn(nowIso(env)), env);

    switch (cmd) {
      case 'init': return write((ts) => {
        const archived = ledger.archive(ts);
        if (archived) stdout.write(`archived previous ledger to ${archived}\n`);
        const rec = { ts, op: 'init', name: pos[0] };
        if (flags.goal !== undefined) rec.goal = flags.goal;
        ledger.append(rec);
        stdout.write(`fleet ${pos[0]} started: ${ledger.file}\n`);
        return EXIT_OK;
      });
      case 'lane': return write((ts) => {
        const slug = pos[0];
        if (declared(slug)) throw refuse(`lane ${slug} is already declared`);
        const rec = {
          ts, op: 'lane', slug,
          role: flags.role ?? 'impl', shape: flags.shape ?? 'ALL', tier: flags.tier ?? 'T1',
          deps: splitDeps(flags.deps), state: 'planned',
        };
        for (const k of ['group', 'branch', 'path', 'brief', 'note']) if (flags[k] !== undefined) rec[k] = flags[k];
        if (rec.path !== undefined) rec.path = absoluteLanePath(rec.path, env, cwd);
        ledger.append(rec);
        stdout.write(`lane ${slug} declared (planned)\n`);
        return EXIT_OK;
      });
      case 'set': return write((ts) => {
        const slug = pos[0];
        if (!declared(slug)) throw refuse(`unknown lane: ${slug}`);
        for (const k of ['path', 'brief']) if (setValues[k] !== undefined) setValues[k] = absoluteLanePath(setValues[k], env, cwd);
        ledger.append({ ts, op: 'set', slug, values: setValues });
        stdout.write(`lane ${slug}: ${Object.entries(setValues).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
        return EXIT_OK;
      });
      case 'fact': return write((ts) => {
        const s = state();
        if (flags.from !== undefined && !s.lanes.some((l) => l.slug === flags.from)) throw refuse(`fact --from: unknown lane: ${flags.from}`);
        const id = `F${s.facts.length + 1}`;
        const rec = { ts, op: 'fact', id, text: pos.join(' '), evidence: flags.evidence };
        if (flags.topic !== undefined) rec.topic = flags.topic;
        if (flags.from !== undefined) rec.from = flags.from;
        ledger.append(rec);
        stdout.write(`${id}\n`);
        return EXIT_OK;
      });
      case 'decide': return write((ts) => {
        if (flags.lane !== undefined && !declared(flags.lane)) throw refuse(`decide --lane: unknown lane: ${flags.lane}`);
        const rec = { ts, op: 'decide', text: pos.join(' '), kind: flags.kind ?? 'plan' };
        if (flags.lane !== undefined) rec.lane = flags.lane;
        ledger.append(rec);
        stdout.write(`decision recorded (${rec.kind}${rec.lane ? `, lane ${rec.lane}` : ''})\n`);
        return EXIT_OK;
      });
      case 'defect': return write((ts) => {
        const slug = pos[0];
        if (!declared(slug)) throw refuse(`unknown lane: ${slug}`);
        ledger.append({ ts, op: 'defect', lane: slug, text: pos.slice(1).join(' ') });
        stdout.write(`defect recorded against ${slug}\n`);
        return EXIT_OK;
      });
      case 'show': {
        const s = state();
        stdout.write(flags.json ? `${JSON.stringify(showJson(s), null, 2)}\n` : formatShow(s));
        return EXIT_OK;
      }
      case 'ready': {
        const r = readyLanes(state());
        if (r.length) stdout.write(`${r.join('\n')}\n`);
        return EXIT_OK;
      }
      case 'check': {
        const problems = checkState(state(), { fixRounds: fixRoundsThreshold(env) });
        for (const p of problems) stdout.write(`${p.level} ${p.message}\n`);
        return problems.some((p) => p.level === 'ERROR') ? EXIT_FAIL : EXIT_OK;
      }
      case 'resume': {
        const s = state();
        stdout.write(formatShow(s));
        const live = s.lanes.filter((l) => RESUME_STATES.includes(l.state));
        stdout.write(`\nin flight (${RESUME_STATES.join('/')}): ${live.length}\n`);
        for (const l of live) stdout.write(`${formatInspection(inspectLane(l, cwd, env))}\n`);
        return EXIT_OK;
      }
      case 'metrics': {
        const m = computeMetrics(state());
        stdout.write(flags.json ? `${JSON.stringify(m, null, 2)}\n` : formatMetrics(m));
        return EXIT_OK;
      }
      default:
        throw usageError(`unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof FleetError) {
      stderr.write(`fleet: ${e.message}\n`);
      if (e.code === EXIT_USAGE) stderr.write(USAGE);
      return e.code;
    }
    stderr.write(`fleet: ${e?.stack ?? e}\n`);
    return EXIT_FAIL;
  }
}

function main() {
  return run(process.argv.slice(2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
