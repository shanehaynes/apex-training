// Acceptance tests for scripts/fleet.mjs (contract v2, section 3).
// Usage: SKILL_ROOT=<dir> node fleet.accept.test.mjs
// Every case drives the CLI; a missing fleet.mjs makes each case FAIL.
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SKILL_ROOT, addWorktree, baseEnv, commitFile, eq, git, makeRepo, match, noMatch, ok, runNode, runNodeAsync, suite, tmp } from './harness.mjs';

const FLEET = join(SKILL_ROOT, 'scripts', 'fleet.mjs');
const s = suite('fleet');
const test = s.test.bind(s);

// ── helpers ─────────────────────────────────────────────────────────────────
function ctx() {
  const repo = tmp('repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const dir = join(tmp('fleet-'), 'fleet');
  return { cwd: repo, dir, ledger: join(dir, 'ledger.jsonl'), archive: join(dir, 'archive') };
}
function fleet(c, args, env = {}) {
  return runNode(FLEET, args, { cwd: c.cwd, env: { FLEET_DIR: c.dir, ...env } });
}
function must(c, args, env) {
  const r = fleet(c, args, env);
  ok(r.code === 0, `\`fleet ${args.join(' ')}\` exited ${r.code}: ${(r.err || r.out).slice(0, 200)}`);
  return r;
}
function expectCode(c, args, code, what) {
  const before = readLedger(c);
  const r = fleet(c, args);
  eq(r.code, code, `${what}: exit code of \`fleet ${args.join(' ')}\``);
  eq(readLedger(c), before, `${what}: ledger unchanged after a rejected command`);
  return r;
}
function readLedger(c) {
  return existsSync(c.ledger) ? readFileSync(c.ledger, 'utf8') : '';
}
function lines(c) {
  return readLedger(c)
    .split('\n')
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`ledger line ${i + 1} is not JSON: ${l}`);
      }
    });
}
function show(c) {
  const r = must(c, ['show', '--json']);
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`show --json is not JSON: ${r.out.slice(0, 200)}`);
  }
}
function laneOf(js, slug) {
  const l = (js.lanes ?? []).find((x) => x.slug === slug);
  ok(l, `lane ${slug} in show --json (lanes: ${JSON.stringify(js.lanes).slice(0, 200)})`);
  return l;
}
function depsOf(l) {
  if (Array.isArray(l.deps)) return l.deps;
  if (typeof l.deps === 'string') return l.deps.split(',').filter(Boolean);
  return [];
}
function outLines(r) {
  return r.out.split('\n').map((x) => x.trim()).filter(Boolean);
}
function problems(r, kind) {
  return outLines(r).filter((l) => l.startsWith(kind));
}
function fleetOf(c, name, lanes) {
  must(c, ['init', name]);
  for (const l of lanes) must(c, ['lane', ...l]);
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// ── init / ledger ───────────────────────────────────────────────────────────
test('init: appends {op:init,name,goal} with ISO-8601 UTC ts', () => {
  const c = ctx();
  must(c, ['init', 'alpha', '--goal', 'ship v2']);
  const ls = lines(c);
  eq(ls.length, 1, 'ledger lines');
  eq(ls[0].op, 'init', 'op');
  eq(ls[0].name, 'alpha', 'name');
  eq(ls[0].goal, 'ship v2', 'goal');
  match(ls[0].ts, ISO, 'ts');
});

test('ledger: every line has ts+op; earlier bytes are never rewritten', () => {
  const c = ctx();
  const steps = [
    ['init', 'alpha'],
    ['lane', 'a', '--role', 'impl'],
    ['set', 'a', 'state=running', 'agent=ag1'],
    ['fact', 'the api is sync', '--evidence', 'src/api.ts:12'],
    ['decide', 'go with plan A'],
    ['set', 'a', 'state=merged'],
    ['defect', 'a', 'broke login'],
  ];
  let prev = '';
  for (const st of steps) {
    must(c, st);
    const cur = readLedger(c);
    ok(cur.startsWith(prev) && cur.length > prev.length, `after \`${st.join(' ')}\` the ledger must only grow by appending`);
    prev = cur;
  }
  const ls = lines(c);
  eq(ls.length, steps.length, 'one line per command');
  for (const l of ls) {
    match(l.ts, ISO, `ts of ${l.op}`);
    ok(typeof l.op === 'string' && l.op, 'op present');
  }
  eq(ls.map((l) => l.op), ['init', 'lane', 'set', 'fact', 'decide', 'set', 'defect'], 'ops');
});

test('init: archives a non-empty ledger to archive/<ts>-<oldname>.jsonl first', () => {
  const c = ctx();
  must(c, ['init', 'oldfleet']);
  must(c, ['lane', 'a']);
  const old = readLedger(c);
  must(c, ['init', 'newfleet', '--goal', 'g2']);
  const files = existsSync(c.archive) ? readdirSync(c.archive) : [];
  eq(files.length, 1, 'archive files');
  match(files[0], /^.+-oldfleet\.jsonl$/, 'archive file name');
  eq(readFileSync(join(c.archive, files[0]), 'utf8'), old, 'archived content is the old ledger, byte for byte');
  const ls = lines(c);
  eq(ls.length, 1, 'fresh ledger has only the new init');
  eq(ls[0].name, 'newfleet', 'new name');
  eq(show(c).lanes.length, 0, 'old lanes are gone from the fold');
});

test('init: no archive when there is no ledger or it is empty', () => {
  const c = ctx();
  must(c, ['init', 'first']);
  const n1 = existsSync(c.archive) ? readdirSync(c.archive).length : 0;
  eq(n1, 0, 'no archive for a missing ledger');
  writeFileSync(c.ledger, '');
  must(c, ['init', 'second']);
  const n2 = existsSync(c.archive) ? readdirSync(c.archive).length : 0;
  eq(n2, 0, 'no archive for an empty ledger');
});

test('AMBIGUOUS init: re-initialising the same name twice keeps both archives', () => {
  const c = ctx();
  must(c, ['init', 'same']);
  must(c, ['lane', 'a']);
  must(c, ['init', 'same']);
  must(c, ['lane', 'b']);
  must(c, ['init', 'same']);
  const files = existsSync(c.archive) ? readdirSync(c.archive) : [];
  eq(files.length, 2, 'two archived ledgers (none overwritten)');
});

test('location: without FLEET_DIR the ledger is <primary>/.claude/state/fleet/ledger.jsonl, even from a worktree', () => {
  const { primary } = makeRepo();
  const wt = addWorktree(primary, 'lane-x');
  mkdirSync(join(wt, 'sub'), { recursive: true });
  const r = runNode(FLEET, ['init', 'located'], { cwd: join(wt, 'sub'), env: { FLEET_DIR: undefined } });
  eq(r.code, 0, `init exit (${r.err.slice(0, 200)})`);
  const want = join(primary, '.claude', 'state', 'fleet', 'ledger.jsonl');
  ok(existsSync(want), `ledger at ${want}`);
  ok(!existsSync(join(wt, '.claude', 'state', 'fleet', 'ledger.jsonl')), 'no ledger inside the worktree');
});

// ── lane ────────────────────────────────────────────────────────────────────
test('lane: defaults role=impl shape=ALL tier=T1 state=planned', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  const l = laneOf(show(c), 'a');
  eq([l.role, l.shape, l.tier, l.state], ['impl', 'ALL', 'T1', 'planned'], 'defaults');
  eq(lines(c)[1].op, 'lane', 'op');
});

test('lane: every flag is recorded', () => {
  const c = ctx();
  must(c, ['init', 'f']);
  must(c, ['lane', 'b']);
  must(c, ['lane', 'c']);
  must(c, ['lane', 'a', '--role', 'verifier', '--shape', 'BEST-OF-N', '--group', 'g1', '--deps', 'b,c', '--tier', 'T3',
    '--branch', 'feat/a', '--path', '/abs/wt', '--brief', 'briefs/a.md', '--note', 'hello world']);
  const l = laneOf(show(c), 'a');
  eq([l.role, l.shape, l.group, l.tier, l.branch, l.path, l.brief, l.note], ['verifier', 'BEST-OF-N', 'g1', 'T3', 'feat/a', '/abs/wt', 'briefs/a.md', 'hello world'], 'fields');
  eq(depsOf(l), ['b', 'c'], 'deps');
});

test('lane: each valid role/shape/tier accepted', () => {
  const c = ctx();
  must(c, ['init', 'f']);
  let i = 0;
  for (const r of ['impl', 'verifier', 'reviewer', 'judge', 'race', 'contract', 'spec', 'adjudicator']) must(c, ['lane', `r${i++}`, '--role', r]);
  for (const sh of ['ALL', 'FIRST-SUFFICIENT', 'BEST-OF-N']) must(c, ['lane', `s${i++}`, '--shape', sh]);
  for (const t of ['T0', 'T1', 'T2', 'T3']) must(c, ['lane', `t${i++}`, '--tier', t]);
});

test('lane: invalid role / shape / tier → 64, nothing appended', () => {
  const c = ctx();
  must(c, ['init', 'f']);
  expectCode(c, ['lane', 'a', '--role', 'boss'], 64, 'bad role');
  expectCode(c, ['lane', 'a', '--shape', 'SOME'], 64, 'bad shape');
  expectCode(c, ['lane', 'a', '--tier', 'T4'], 64, 'bad tier');
  expectCode(c, ['lane', 'a', '--tier', 't1'], 64, 'lower-case tier');
});

test('lane: duplicate slug → 1, nothing appended', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  expectCode(c, ['lane', 'a', '--role', 'judge'], 1, 'duplicate');
  eq(laneOf(show(c), 'a').role, 'impl', 'original lane untouched');
});

test('usage: unknown command / unknown flag / no command → 64', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  expectCode(c, ['frobnicate'], 64, 'unknown command');
  expectCode(c, ['lane', 'b', '--colour', 'red'], 64, 'unknown lane flag');
  expectCode(c, ['show', '--bogus'], 64, 'unknown show flag');
  expectCode(c, [], 64, 'no command');
});

// ── set ─────────────────────────────────────────────────────────────────────
test('set: several keys, last write wins, value may contain "="', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  must(c, ['set', 'a', 'state=running', 'agent=ag-1', 'sha=abc', 'note=x=y', 'round=1']);
  must(c, ['set', 'a', 'sha=def', 'round=2', 'report=reports/a.md', 'branch=feat/a', 'path=/p']);
  const l = laneOf(show(c), 'a');
  eq([l.state, l.agent, l.sha, l.note, l.report, l.branch, l.path], ['running', 'ag-1', 'def', 'x=y', 'reports/a.md', 'feat/a', '/p'], 'fields');
  eq(Number(l.round), 2, 'round');
  eq(lines(c).filter((x) => x.op === 'set').length, 2, 'set lines appended');
});

test('set: every state value accepted; integers for round/findings/confirmed/disputed', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  for (const st of ['planned', 'running', 'reported', 'checked', 'merged', 'retired', 'stopped', 'failed']) must(c, ['set', 'a', `state=${st}`]);
  must(c, ['set', 'a', 'round=0', 'findings=5', 'confirmed=3', 'disputed=1']);
  const l = laneOf(show(c), 'a');
  eq([Number(l.round), Number(l.findings), Number(l.confirmed), Number(l.disputed)], [0, 5, 3, 1], 'numbers');
  eq(l.state, 'failed', 'last state');
});

test('set: bad state / unknown key / bad integers → 64; unknown slug → 1; nothing appended', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  expectCode(c, ['set', 'a', 'state=done'], 64, 'bad state');
  expectCode(c, ['set', 'a', 'colour=red'], 64, 'unknown key');
  expectCode(c, ['set', 'a', 'round=-1'], 64, 'negative round');
  expectCode(c, ['set', 'a', 'round=1.5'], 64, 'fractional round');
  expectCode(c, ['set', 'a', 'findings=abc'], 64, 'non-numeric findings');
  expectCode(c, ['set', 'a', 'confirmed='], 64, 'empty confirmed');
  expectCode(c, ['set', 'a', 'state=running', 'disputed=x'], 64, 'one bad pair rejects the whole set');
  expectCode(c, ['set', 'nope', 'state=running'], 1, 'unknown slug');
  eq(laneOf(show(c), 'a').state, 'planned', 'state untouched');
});

// ── fact / decide / defect ──────────────────────────────────────────────────
test('fact: --evidence required (64); sequential ids F1, F2 with topic/from', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  expectCode(c, ['fact', 'no evidence here'], 64, 'missing --evidence');
  must(c, ['fact', 'first fact', '--evidence', 'log line 3', '--topic', 'db', '--from', 'a']);
  must(c, ['fact', 'second fact', '--evidence', 'test output']);
  const fl = lines(c).filter((x) => x.op === 'fact');
  eq(fl.map((x) => x.id), ['F1', 'F2'], 'ledger ids');
  eq([fl[0].evidence, fl[0].topic, fl[0].from], ['log line 3', 'db', 'a'], 'fact fields');
  ok(JSON.stringify(fl[0]).includes('first fact'), 'fact text recorded');
  const js = show(c);
  eq((js.facts ?? []).map((x) => x.id), ['F1', 'F2'], 'show --json facts');
});

test('decide: default kind plan; bad kind → 64; judge requires --lane (winner)', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a', '--shape', 'BEST-OF-N', '--group', 'g'], ['b', '--shape', 'BEST-OF-N', '--group', 'g']]);
  must(c, ['decide', 'use postgres']);
  expectCode(c, ['decide', 'x', '--kind', 'vibes'], 64, 'bad kind');
  expectCode(c, ['decide', 'b wins', '--kind', 'judge'], 64, 'judge without --lane');
  must(c, ['decide', 'b wins', '--kind', 'judge', '--lane', 'b']);
  for (const k of ['adjudication', 'merge', 'escalation', 'plan']) must(c, ['decide', `d ${k}`, '--kind', k]);
  const dl = lines(c).filter((x) => x.op === 'decide');
  eq(dl[0].kind, 'plan', 'default kind');
  eq([dl[1].kind, dl[1].lane], ['judge', 'b'], 'judge decision');
  eq((show(c).decisions ?? []).length, 6, 'decisions in show --json');
});

test('defect: appended and shown in show --json defects', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  must(c, ['set', 'a', 'state=merged']);
  must(c, ['defect', 'a', 'null deref in login']);
  const dl = lines(c).filter((x) => x.op === 'defect');
  eq(dl.length, 1, 'defect line');
  const js = show(c);
  eq((js.defects ?? []).length, 1, 'defects in show --json');
  ok(JSON.stringify(js.defects).includes('null deref in login') && JSON.stringify(js.defects).includes('"a"'), 'defect names lane and text');
});

// ── show ────────────────────────────────────────────────────────────────────
test('show --json: {name, goal, lanes, facts, decisions, defects}', () => {
  const c = ctx();
  must(c, ['init', 'fleet-x', '--goal', 'the goal']);
  must(c, ['lane', 'a']);
  const js = show(c);
  eq([js.name, js.goal], ['fleet-x', 'the goal'], 'name/goal');
  for (const k of ['lanes', 'facts', 'decisions', 'defects']) ok(Array.isArray(js[k]), `${k} is an array`);
  eq(js.lanes.length, 1, 'lanes');
});

test('show (text): a row per lane with role/shape/group/tier/state/deps/sha(12)/round/agent, then counts', () => {
  const c = ctx();
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  fleetOf(c, 'f', [['base1'], ['zeta', '--role', 'reviewer', '--shape', 'BEST-OF-N', '--group', 'grpq', '--tier', 'T2', '--deps', 'base1']]);
  must(c, ['set', 'zeta', 'state=running', `sha=${sha}`, 'round=4', 'agent=agent-77']);
  must(c, ['fact', 'f1', '--evidence', 'e']);
  must(c, ['fact', 'f2', '--evidence', 'e']);
  must(c, ['fact', 'f3', '--evidence', 'e']);
  must(c, ['decide', 'd1']);
  const r = must(c, ['show']);
  const row = r.out.split('\n').find((l) => /\bzeta\b/.test(l));
  ok(row, `a row for zeta in:\n${r.out}`);
  for (const [what, re] of [['role', /reviewer/], ['shape', /BEST-OF-N/], ['group', /grpq/], ['tier', /T2/], ['state', /running/], ['deps', /base1/], ['sha(12)', /abcdef012345(?![0-9a-f])/], ['round', /\b4\b/], ['agent', /agent-77/]]) {
    match(row, re, `row has ${what}`);
  }
  noMatch(row, /abcdef0123456/, 'sha is shortened to 12 characters');
  match(r.out, /facts?\D{0,20}\b3\b|\b3\b\D{0,20}facts?/i, 'fact count');
  match(r.out, /decisions?\D{0,20}\b1\b|\b1\b\D{0,20}decisions?/i, 'decision count');
});

// ── ready ───────────────────────────────────────────────────────────────────
function readyOf(c) {
  return outLines(must(c, ['ready']));
}
test('ready: planned lanes with merged deps, by transitive dependents desc, ties by declaration', () => {
  const c = ctx();
  // p q r s(q) t(r) u(s) v w(p): dependents p=1 q=2 (s,u — transitive) r=1 v=0
  fleetOf(c, 'f', [['p'], ['q'], ['r'], ['s', '--deps', 'q'], ['t', '--deps', 'r'], ['u', '--deps', 's'], ['v'], ['w', '--deps', 'p']]);
  eq(readyOf(c), ['q', 'p', 'r', 'v'], 'ready order');
  must(c, ['set', 'q', 'state=merged']);
  // now s (dependents u=1) is ready: p=1 r=1 s=1 v=0 → declaration order among ties
  eq(readyOf(c), ['p', 'r', 's', 'v'], 'ready order after q merged');
});

test('ready: transitive dependents are counted as distinct lanes (diamond), not paths', () => {
  const c = ctx();
  // k has 3 direct dependents; d has y,z,w (w depends on both y and z): 3 distinct, 4 paths.
  fleetOf(c, 'f', [['k'], ['d'], ['k1', '--deps', 'k'], ['k2', '--deps', 'k'], ['k3', '--deps', 'k'], ['y', '--deps', 'd'], ['z', '--deps', 'd'], ['w', '--deps', 'y,z']]);
  eq(readyOf(c), ['k', 'd'], 'tie at 3 → declaration order');
});

test('ready: undeclared dep, unmerged dep, or non-planned lane → not ready', () => {
  const c = ctx();
  fleetOf(c, 'f', [['m'], ['a', '--deps', 'ghost'], ['b', '--deps', 'm,ghost'], ['c', '--deps', 'm'], ['e']]);
  must(c, ['set', 'm', 'state=checked']);
  must(c, ['set', 'e', 'state=running']);
  eq(readyOf(c), [], 'nothing ready (m is checked, not merged; e is running)');
  must(c, ['set', 'm', 'state=merged']);
  eq(readyOf(c), ['c'], 'only c (b still has an undeclared dep)');
});

// ── check ───────────────────────────────────────────────────────────────────
function checkOf(c, env) {
  const r = fleet(c, ['check'], env);
  return { ...r, errors: problems(r, 'ERROR'), warns: problems(r, 'WARN') };
}
test('check: clean fleet → exit 0, no ERROR/WARN', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a'], ['b', '--deps', 'a']]);
  must(c, ['set', 'a', 'state=running', 'agent=x']);
  const r = checkOf(c);
  eq(r.code, 0, 'exit');
  eq([...r.errors, ...r.warns], [], 'problems');
});

test('check: ERROR for a dep on an undeclared lane (named), exit 1', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a', '--deps', 'phantom']]);
  const r = checkOf(c);
  eq(r.code, 1, 'exit');
  ok(r.errors.some((l) => l.includes('phantom')), `an ERROR naming phantom in: ${r.out}`);
});

test('check: ERROR for a dependency cycle, naming its lanes; self-cycle too', () => {
  const c = ctx();
  must(c, ['init', 'f']);
  must(c, ['lane', 'a', '--deps', 'b']);
  must(c, ['lane', 'b', '--deps', 'a']);
  let r = checkOf(c);
  eq(r.code, 1, 'exit for a↔b');
  ok(r.errors.some((l) => /cycle/i.test(l) && /\ba\b/.test(l) && /\bb\b/.test(l)), `an ERROR "cycle" naming a and b in: ${r.out}`);
  const c2 = ctx();
  must(c2, ['init', 'f']);
  must(c2, ['lane', 'selfie', '--deps', 'selfie']);
  r = checkOf(c2);
  eq(r.code, 1, 'exit for a self-cycle');
  ok(r.errors.some((l) => /cycle/i.test(l) && l.includes('selfie')), `an ERROR "cycle" naming selfie in: ${r.out}`);
});

test('check: a diamond is not a cycle', () => {
  const c = ctx();
  fleetOf(c, 'f', [['d'], ['y', '--deps', 'd'], ['z', '--deps', 'd'], ['w', '--deps', 'y,z']]);
  const r = checkOf(c);
  eq(r.code, 0, 'exit');
  eq(r.errors, [], 'errors');
});

test('check: ERROR for two merged lanes of one BEST-OF-N group', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a1', '--shape', 'BEST-OF-N', '--group', 'g'], ['a2', '--shape', 'BEST-OF-N', '--group', 'g']]);
  must(c, ['decide', 'a1 wins', '--kind', 'judge', '--lane', 'a1']);
  must(c, ['decide', 'a2 wins', '--kind', 'judge', '--lane', 'a2']);
  must(c, ['set', 'a1', 'state=merged']);
  must(c, ['set', 'a2', 'state=merged']);
  const r = checkOf(c);
  eq(r.code, 1, 'exit');
  ok(r.errors.length >= 1, `an ERROR in: ${r.out}`);
});

test('check: no ERROR for one judged merge per BEST-OF-N group, or merged ALL lanes sharing a group', () => {
  const c = ctx();
  fleetOf(c, 'f', [
    ['a1', '--shape', 'BEST-OF-N', '--group', 'g1'], ['a2', '--shape', 'BEST-OF-N', '--group', 'g1'],
    ['b1', '--shape', 'BEST-OF-N', '--group', 'g2'], ['b2', '--shape', 'BEST-OF-N', '--group', 'g2'],
    ['c1', '--group', 'g3'], ['c2', '--group', 'g3'],
  ]);
  must(c, ['decide', 'a2 wins', '--kind', 'judge', '--lane', 'a2']);
  must(c, ['decide', 'b1 wins', '--kind', 'judge', '--lane', 'b1']);
  for (const x of ['a2', 'b1', 'c1', 'c2']) must(c, ['set', x, 'state=merged']);
  for (const x of ['a1', 'b2']) must(c, ['set', x, 'state=retired']);
  const r = checkOf(c);
  eq(r.code, 0, 'exit');
  eq(r.errors, [], 'errors');
});

test('check: ERROR for a merged BEST-OF-N lane without a judge decision naming it', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a1', '--shape', 'BEST-OF-N', '--group', 'g'], ['a2', '--shape', 'BEST-OF-N', '--group', 'g']]);
  must(c, ['set', 'a1', 'state=merged']);
  let r = checkOf(c);
  eq(r.code, 1, 'exit with no judge decision');
  ok(r.errors.some((l) => l.includes('a1')), `an ERROR naming a1 in: ${r.out}`);
  must(c, ['decide', 'a2 wins', '--kind', 'judge', '--lane', 'a2']);
  r = checkOf(c);
  eq(r.code, 1, 'exit when the judge named the other lane');
  must(c, ['decide', 'plan note', '--kind', 'plan', '--lane', 'a1']);
  r = checkOf(c);
  eq(r.code, 1, 'exit when only a non-judge decision names it');
});

test('check: WARN "escalate" at round ≥ FLEET_FIX_ROUNDS (default 3), exit 0', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a'], ['b']]);
  must(c, ['set', 'a', 'round=2']);
  let r = checkOf(c);
  eq(r.warns, [], 'no WARN at round 2');
  must(c, ['set', 'a', 'round=3']);
  r = checkOf(c);
  eq(r.code, 0, 'WARN only → exit 0');
  ok(r.warns.some((l) => /escalate/i.test(l) && /\ba\b/.test(l)), `WARN escalate for a in: ${r.out}`);
  must(c, ['set', 'b', 'round=4']);
  r = checkOf(c, { FLEET_FIX_ROUNDS: '5' });
  eq(r.warns.filter((l) => /escalate/i.test(l)), [], 'no WARN below FLEET_FIX_ROUNDS=5');
  must(c, ['set', 'b', 'round=5']);
  r = checkOf(c, { FLEET_FIX_ROUNDS: '5' });
  ok(r.warns.some((l) => /escalate/i.test(l) && /\bb\b/.test(l)), `WARN escalate for b at 5 in: ${r.out}`);
});

test('check: WARN "race ended with no win" for an ended FIRST-SUFFICIENT group, not when judged or still running', () => {
  const c = ctx();
  fleetOf(c, 'f', [['r1', '--shape', 'FIRST-SUFFICIENT', '--group', 'race'], ['r2', '--shape', 'FIRST-SUFFICIENT', '--group', 'race'], ['r3', '--shape', 'FIRST-SUFFICIENT', '--group', 'race']]);
  must(c, ['set', 'r1', 'state=stopped']);
  must(c, ['set', 'r2', 'state=failed']);
  must(c, ['set', 'r3', 'state=running', 'agent=x']);
  let r = checkOf(c);
  eq(r.warns.filter((l) => /race ended with no win/i.test(l)), [], 'no WARN while one is running');
  must(c, ['set', 'r3', 'state=retired']);
  r = checkOf(c);
  eq(r.code, 0, 'WARN only → exit 0');
  ok(r.warns.some((l) => /race ended with no win/i.test(l)), `WARN in: ${r.out}`);
  must(c, ['decide', 'r2 was good enough after all', '--kind', 'adjudication', '--lane', 'r2']);
  r = checkOf(c);
  eq(r.warns.filter((l) => /race ended with no win/i.test(l)), [], 'no WARN once a decide names one of them');
});

test('check: WARN for a running lane with no agent', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a'], ['b']]);
  must(c, ['set', 'a', 'state=running']);
  must(c, ['set', 'b', 'state=running', 'agent=ag']);
  const r = checkOf(c);
  eq(r.code, 0, 'exit');
  ok(r.warns.some((l) => /\ba\b/.test(l)), `WARN naming a in: ${r.out}`);
  ok(!r.warns.some((l) => /\bb\b/.test(l)), `no WARN naming b in: ${r.out}`);
});

// ── resume ──────────────────────────────────────────────────────────────────
function resumeFixture() {
  const repo = makeRepo();
  const c = { cwd: repo.primary, dir: join(tmp('fleet-'), 'fleet') };
  c.ledger = join(c.dir, 'ledger.jsonl');
  const w1 = addWorktree(repo.primary, 'f1');
  const s1 = commitFile(w1, 'f1.txt', 'one');
  git(w1, 'push', '-q', '-u', 'origin', 'f1');
  return { ...repo, c, w1, s1 };
}
const STATUS = /\b(MATCH|DIFFERS|NOT PUSHED)\b/g;

test('resume: pushed branch at the recorded sha → MATCH', () => {
  const { c, w1, s1 } = resumeFixture();
  must(c, ['init', 'f']);
  must(c, ['lane', 'l1', '--branch', 'f1', '--path', w1]);
  must(c, ['set', 'l1', 'state=running', 'agent=a', `sha=${s1}`]);
  const r = must(c, ['resume']);
  eq(r.out.match(STATUS), ['MATCH'], 'status');
});

test('resume: remote branch at another sha → DIFFERS', () => {
  const { c, w1, primary } = resumeFixture();
  must(c, ['init', 'f']);
  must(c, ['lane', 'l2', '--branch', 'f1', '--path', w1]);
  must(c, ['set', 'l2', 'state=reported', `sha=${git(primary, 'rev-parse', 'origin/main')}`]);
  const r = must(c, ['resume']);
  eq(r.out.match(STATUS), ['DIFFERS'], 'status');
});

test('resume: branch not on the remote → NOT PUSHED', () => {
  const { c, primary } = resumeFixture();
  const w3 = addWorktree(primary, 'f3');
  const s3 = commitFile(w3, 'f3.txt', 'three');
  must(c, ['init', 'f']);
  must(c, ['lane', 'l3', '--branch', 'f3', '--path', w3]);
  must(c, ['set', 'l3', 'state=checked', `sha=${s3}`]);
  const r = must(c, ['resume']);
  eq(r.out.match(STATUS), ['NOT PUSHED'], 'status');
});

test('resume: only running/reported/checked lanes are compared', () => {
  const { c, w1, s1 } = resumeFixture();
  must(c, ['init', 'f']);
  const states = ['planned', 'running', 'reported', 'checked', 'merged', 'retired', 'stopped', 'failed'];
  for (const st of states) {
    must(c, ['lane', `x-${st}`, '--branch', 'f1', '--path', w1]);
    must(c, ['set', `x-${st}`, `state=${st}`, 'agent=a', `sha=${s1}`]);
  }
  const r = must(c, ['resume']);
  eq((r.out.match(STATUS) ?? []).length, 3, 'three comparisons');
});

test('resume: reports the porcelain count and a missing path', () => {
  const { c, w1, s1 } = resumeFixture();
  for (let i = 0; i < 7; i++) writeFileSync(join(w1, `u${i}.txt`), 'x');
  must(c, ['init', 'f']);
  must(c, ['lane', 'l1', '--branch', 'f1', '--path', w1]);
  must(c, ['set', 'l1', 'state=running', 'agent=a', `sha=${s1}`]);
  must(c, ['lane', 'gone', '--path', '/nonexistent/acceptance/lane']);
  must(c, ['set', 'gone', 'state=running', 'agent=b']);
  const r = must(c, ['resume']);
  match(r.out, /\b7\b/, 'porcelain count 7');
  const goneLines = r.out.split('\n').filter((l) => l.includes('/nonexistent/acceptance/lane') || /\bgone\b/.test(l));
  ok(goneLines.some((l) => /missing|not found|no such|does ?n.t exist|not exist|absent|\bno\b|false|✗|GONE/i.test(l)), `missing path reported in:\n${r.out}`);
});

test('resume: never changes anything (ledger, refs incl. remote-tracking, worktree)', () => {
  const { c, w1, s1, primary, origin, root } = resumeFixture();
  // Move origin/f1 from elsewhere so a fetch would change the local tracking ref.
  const other = join(root, 'other');
  git(root, 'clone', '-q', origin, other);
  git(other, 'checkout', '-q', 'f1');
  commitFile(other, 'x.txt', 'x');
  git(other, 'push', '-q', 'origin', 'f1');
  writeFileSync(join(w1, 'dirty.txt'), 'x');
  must(c, ['init', 'f']);
  must(c, ['lane', 'l1', '--branch', 'f1', '--path', w1]);
  must(c, ['set', 'l1', 'state=running', 'agent=a', `sha=${s1}`]);
  const snap = () => [readLedger(c), git(primary, 'for-each-ref'), git(w1, 'status', '--porcelain'), git(primary, 'worktree', 'list', '--porcelain')].join('\n--\n');
  const before = snap();
  const r = must(c, ['resume']);
  eq(r.out.match(STATUS), ['DIFFERS'], 'remote moved → DIFFERS');
  eq(snap(), before, 'state after resume');
});

// ── metrics ─────────────────────────────────────────────────────────────────
function numbersIn(v, acc = []) {
  if (typeof v === 'number') acc.push(v);
  else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) acc.push(Number(v));
  else if (v && typeof v === 'object') for (const x of Object.values(v)) numbersIn(x, acc);
  return acc;
}
test('metrics: text and --json run; AMBIGUOUS (no JSON schema) sums/means present', () => {
  const c = ctx();
  must(c, ['init', 'm']);
  must(c, ['lane', 'r1', '--role', 'reviewer', '--tier', 'T2']);
  must(c, ['lane', 'r2', '--role', 'reviewer', '--tier', 'T2']);
  must(c, ['lane', 'v1', '--role', 'verifier', '--tier', 'T0']);
  must(c, ['lane', 'v2', '--role', 'verifier', '--tier', 'T0']);
  must(c, ['lane', 'i1', '--role', 'impl', '--tier', 'T3']);
  must(c, ['lane', 'g1a', '--shape', 'BEST-OF-N', '--group', 'G1']);
  must(c, ['lane', 'g1b', '--shape', 'BEST-OF-N', '--group', 'G1']);
  must(c, ['lane', 'g2a', '--shape', 'BEST-OF-N', '--group', 'G2']);
  must(c, ['lane', 'g2b', '--shape', 'BEST-OF-N', '--group', 'G2']);
  must(c, ['set', 'r1', 'findings=5', 'confirmed=3', 'round=1']);
  must(c, ['set', 'r2', 'findings=6', 'confirmed=4', 'round=4']);
  must(c, ['set', 'v1', 'disputed=4']);
  must(c, ['set', 'v2', 'disputed=5']);
  must(c, ['set', 'i1', 'findings=100', 'confirmed=100', 'disputed=100']);
  must(c, ['decide', 'g1b wins', '--kind', 'judge', '--lane', 'g1b']);
  must(c, ['decide', 'g2a wins', '--kind', 'judge', '--lane', 'g2a']);
  must(c, ['defect', 'r1', 'x']);
  must(c, ['defect', 'r2', 'y']);
  must(c, ['defect', 'i1', 'z']);
  const t = must(c, ['metrics']);
  ok(t.out.trim().length > 0, 'text metrics printed');
  const r = must(c, ['metrics', '--json']);
  let js;
  try {
    js = JSON.parse(r.out);
  } catch {
    throw new Error(`metrics --json is not JSON: ${r.out.slice(0, 200)}`);
  }
  const nums = numbersIn(js);
  for (const [what, n] of [['reviewer findings 11', 11], ['reviewer confirmed 7', 7], ['verifier disputed 9', 9], ['max round 4', 4], ['mean round 2.5', 2.5]]) {
    ok(nums.includes(n), `${what} somewhere in ${JSON.stringify(js).slice(0, 300)}`);
  }
  ok(!nums.includes(111) && !nums.includes(107) && !nums.includes(109), 'impl lane findings/confirmed/disputed not summed into reviewer/verifier metrics');
  const text = JSON.stringify(js);
  match(text, /T2/, 'per-tier breakdown');
  match(text, /reviewer/, 'per-role breakdown');
});

// ── round-2 amendments (A25–A34) ────────────────────────────────────────────
test('A25 append after a ledger with no trailing newline starts a new line', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  writeFileSync(c.ledger, readLedger(c).replace(/\n$/, ''));
  must(c, ['lane', 'b']);
  const ls = lines(c);
  eq(ls.map((l) => l.op), ['init', 'lane', 'lane'], 'every line is its own JSON record');
  eq(show(c).lanes.map((l) => l.slug), ['a', 'b'], 'both lanes in the fold');
});

test('A25 record after a torn (crashed) last line is not lost', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  writeFileSync(c.ledger, `${readLedger(c)}{"ts":"2026-01-01T00:00:00Z","op":"la`);
  fleet(c, ['lane', 'c']);
  const last = readLedger(c).split('\n').filter(Boolean).pop();
  let rec = null;
  try {
    rec = JSON.parse(last);
  } catch {
    /* fall through */
  }
  ok(rec && rec.op === 'lane' && rec.slug === 'c', `last line is the new lane record on its own line: ${JSON.stringify(last)}`);
});

test('A26 BEST-OF-N: the latest judge decision is the standing winner', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a1', '--shape', 'BEST-OF-N', '--group', 'g'], ['a2', '--shape', 'BEST-OF-N', '--group', 'g']]);
  must(c, ['set', 'a1', 'state=merged']);
  must(c, ['decide', 'a1 wins', '--kind', 'judge', '--lane', 'a1']);
  must(c, ['decide', 'on reflection a2 wins', '--kind', 'judge', '--lane', 'a2']);
  let r = checkOf(c);
  eq(r.code, 1, 'exit when the merged lane was overruled by a later judge');
  ok(r.errors.some((l) => l.includes('a1')), `an ERROR naming a1 in: ${r.out}`);
  must(c, ['decide', 'back to a1', '--kind', 'judge', '--lane', 'a1']);
  r = checkOf(c);
  eq(r.code, 0, `exit once the latest judge names the merged lane (${r.out.trim()})`);
});

function hangingRemote() {
  const fx = resumeFixture();
  const bin = tmp('bin-');
  const ssh = join(bin, 'hang-ssh');
  writeFileSync(ssh, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(ssh, 0o755);
  git(fx.primary, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/hangs.git');
  return { ...fx, ssh };
}
test('A27 resume: a hanging remote times out → push=UNKNOWN (timeout), never hangs', () => {
  const { c, w1, s1, ssh } = hangingRemote();
  must(c, ['init', 'f']);
  must(c, ['lane', 'l1', '--branch', 'f1', '--path', w1]);
  must(c, ['set', 'l1', 'state=running', 'agent=a', `sha=${s1}`]);
  const t0 = Date.now();
  const r = runNode(FLEET, ['resume'], { cwd: c.cwd, env: { FLEET_DIR: c.dir, FLEET_GIT_TIMEOUT_MS: '1500', GIT_SSH_COMMAND: ssh }, timeout: 40000 });
  const ms = Date.now() - t0;
  ok(r.signal === null, `resume finished by itself (killed by ${r.signal} after ${ms} ms)`);
  ok(ms < 20000, `resume returned within 20 s with FLEET_GIT_TIMEOUT_MS=1500 (took ${ms} ms)`);
  eq(r.code, 0, `exit (${r.err.slice(0, 200)})`);
  match(r.out, /push=UNKNOWN \(timeout\)/, 'timeout reported');
});

test('A28 resume: AHEAD n for unpushed local commits, without taking optional locks', () => {
  const { c, w1, s1 } = resumeFixture();
  commitFile(w1, 'l1.txt', '1');
  commitFile(w1, 'l2.txt', '2');
  must(c, ['init', 'f']);
  must(c, ['lane', 'l1', '--branch', 'f1', '--path', w1]);
  must(c, ['set', 'l1', 'state=running', 'agent=a', `sha=${s1}`]);
  const index = resolve(w1, git(w1, 'rev-parse', '--git-path', 'index'));
  const old = new Date(Date.now() - 60000);
  utimesSync(index, old, old); // index older than the work tree, so a refresh would rewrite it
  utimesSync(join(w1, 'README'), new Date(), new Date());
  const before = statSync(index).mtimeMs;
  const r = must(c, ['resume']);
  match(r.out, /\bAHEAD 2\b/, 'AHEAD 2 reported');
  match(r.out, /\bMATCH\b/, 'push value still reported');
  eq(statSync(index).mtimeMs, before, 'index not rewritten by resume (git --no-optional-locks)');
  git(w1, 'status', '--porcelain');
  ok(statSync(index).mtimeMs !== before, 'fixture check: a plain git status would have rewritten the index');
});

test('A29 decide --lane / fact --from with an unknown slug → exit 1, nothing appended', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  expectCode(c, ['decide', 'x', '--lane', 'ghost'], 1, 'decide --lane ghost');
  expectCode(c, ['decide', 'x', '--kind', 'judge', '--lane', 'ghost'], 1, 'judge --lane ghost');
  expectCode(c, ['fact', 't', '--evidence', 'e', '--from', 'ghost'], 1, 'fact --from ghost');
  must(c, ['decide', 'x', '--lane', 'a']);
  must(c, ['fact', 't', '--evidence', 'e', '--from', 'a']);
});

test('A30 check: WARN "blocked: dep X is <state>" for a planned lane', () => {
  const c = ctx();
  fleetOf(c, 'f', [['d1'], ['d2'], ['d3'], ['d4'], ['p1', '--deps', 'd1'], ['p2', '--deps', 'd2'], ['p3', '--deps', 'd3'], ['p4', '--deps', 'd4']]);
  must(c, ['set', 'd1', 'state=stopped']);
  must(c, ['set', 'd2', 'state=failed']);
  must(c, ['set', 'd3', 'state=retired']);
  must(c, ['set', 'd4', 'state=running', 'agent=x']);
  const r = checkOf(c);
  eq(r.code, 0, 'WARN only → exit 0');
  for (const [d, st] of [['d1', 'stopped'], ['d2', 'failed'], ['d3', 'retired']]) {
    ok(r.warns.some((l) => l.includes(`blocked: dep ${d} is ${st}`)), `WARN blocked: dep ${d} is ${st} in: ${r.out}`);
  }
  ok(!r.warns.some((l) => /blocked/.test(l) && l.includes('d4')), 'no blocked WARN for a running dep');
});

test('A31 check: WARN for a group mixing shapes', () => {
  const c = ctx();
  fleetOf(c, 'f', [['x1', '--shape', 'BEST-OF-N', '--group', 'mixgrp'], ['x2', '--shape', 'ALL', '--group', 'mixgrp'], ['y1', '--shape', 'ALL', '--group', 'puregrp'], ['y2', '--shape', 'ALL', '--group', 'puregrp']]);
  const r = checkOf(c);
  eq(r.code, 0, 'WARN only → exit 0');
  ok(r.warns.some((l) => l.includes('mixgrp')), `WARN naming mixgrp in: ${r.out}`);
  ok(!r.warns.some((l) => l.includes('puregrp')), `no WARN for a single-shape group in: ${r.out}`);
});

test('A32 a repeated flag → 64 (every command)', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  expectCode(c, ['lane', 'b', '--role', 'impl', '--role', 'judge'], 64, 'lane --role twice');
  expectCode(c, ['lane', 'b', '--deps', 'a', '--deps', 'a'], 64, 'lane --deps twice');
  expectCode(c, ['init', 'n', '--goal', 'x', '--goal', 'y'], 64, 'init --goal twice');
  expectCode(c, ['fact', 't', '--evidence', 'a', '--evidence', 'b'], 64, 'fact --evidence twice');
  expectCode(c, ['decide', 't', '--kind', 'plan', '--kind', 'merge'], 64, 'decide --kind twice');
  expectCode(c, ['show', '--json', '--json'], 64, 'show --json twice');
  expectCode(c, ['metrics', '--json', '--json'], 64, 'metrics --json twice');
});

test('A33 slugs and group names must match [A-Za-z0-9._-]+ → else 64', () => {
  const c = ctx();
  must(c, ['init', 'f']);
  for (const bad of ['a b', 'a/b', 'a:b', 'ä', '', 'a\tb']) expectCode(c, ['lane', bad], 64, `slug ${JSON.stringify(bad)}`);
  for (const bad of ['g h', 'g/h', '']) expectCode(c, ['lane', 'ok1', '--group', bad], 64, `group ${JSON.stringify(bad)}`);
  must(c, ['lane', 'a.b_C-1', '--group', 'G.1_x-y']);
});

test('A34 concurrent writers: no duplicate fact ids, a slug declared once', async () => {
  const c = ctx();
  must(c, ['init', 'f']);
  const env = { FLEET_DIR: c.dir };
  for (let round = 0; round < 3; round++) {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => runNodeAsync(FLEET, ['fact', `r${round} f${i}`, '--evidence', 'e'], { cwd: c.cwd, env })));
    eq(rs.map((r) => r.code), Array(10).fill(0), `round ${round}: every concurrent fact succeeded`);
    const slug = `same${round}`;
    const ls = await Promise.all(Array.from({ length: 8 }, () => runNodeAsync(FLEET, ['lane', slug], { cwd: c.cwd, env })));
    eq(ls.filter((r) => r.code === 0).length, 1, `round ${round}: exactly one concurrent lane ${slug} succeeded`);
    eq(ls.filter((r) => r.code === 1).length, 7, `round ${round}: the others exit 1`);
  }
  const ids = lines(c).filter((x) => x.op === 'fact').map((x) => x.id);
  eq(ids.length, 30, 'facts recorded');
  eq(new Set(ids).size, 30, `distinct fact ids (${ids.join(',')})`);
  eq(lines(c).filter((x) => x.op === 'lane').length, 3, 'one lane line per slug');
});

// ── round-4 amendments (A65–A73) ────────────────────────────────────────────
test('A65 resume prints AHEAD ? when the distance cannot be determined', () => {
  const { c, primary } = resumeFixture();
  const w3 = addWorktree(primary, 'f3');
  const s3 = commitFile(w3, 'f3.txt', 'three'); // never pushed: no origin/f3 to count from
  must(c, ['init', 'f']);
  must(c, ['lane', 'l3', '--branch', 'f3', '--path', w3]);
  must(c, ['set', 'l3', 'state=running', 'agent=a', `sha=${s3}`]);
  const r = must(c, ['resume']);
  match(r.out, /AHEAD \?/, 'AHEAD ? reported');
});

test('A66 resume reports path=NOT-A-WORKTREE when the path is not a worktree toplevel', () => {
  const { c, w1, s1 } = resumeFixture();
  mkdirSync(join(w1, 'sub'));
  must(c, ['init', 'f']);
  must(c, ['lane', 'l1', '--branch', 'f1', '--path', join(w1, 'sub')]);
  must(c, ['set', 'l1', 'state=running', 'agent=a', `sha=${s1}`]);
  const r = must(c, ['resume']);
  match(r.out, /path=NOT-A-WORKTREE/, 'subdirectory of a worktree');
});

test('A67 --path and set path= are stored absolute, relative to the primary checkout', () => {
  const { primary } = makeRepo();
  const wt = addWorktree(primary, 'lane-x');
  mkdirSync(join(wt, 'deep'), { recursive: true });
  const c = { cwd: join(wt, 'deep'), dir: join(tmp('fleet-'), 'fleet') };
  c.ledger = join(c.dir, 'ledger.jsonl');
  must(c, ['init', 'f']);
  must(c, ['lane', 'a', '--path', 'rel/x']);
  eq(laneOf(show(c), 'a').path, join(primary, 'rel', 'x'), '--path rel/x');
  must(c, ['set', 'a', 'path=../y']);
  eq(laneOf(show(c), 'a').path, resolve(primary, '..', 'y'), 'set path=../y');
  must(c, ['set', 'a', 'path=/abs/z']);
  eq(laneOf(show(c), 'a').path, '/abs/z', 'absolute path unchanged');
});

test('A68 an ungrouped lane never joins an explicit group of the same name', () => {
  const c = ctx();
  fleetOf(c, 'f', [['x', '--shape', 'BEST-OF-N'], ['y', '--shape', 'BEST-OF-N', '--group', 'x'], ['z', '--shape', 'ALL', '--group', 'w'], ['w', '--shape', 'BEST-OF-N']]);
  must(c, ['decide', 'x wins its own', '--kind', 'judge', '--lane', 'x']);
  must(c, ['decide', 'y wins group x', '--kind', 'judge', '--lane', 'y']);
  must(c, ['set', 'x', 'state=merged']);
  must(c, ['set', 'y', 'state=merged']);
  const r = checkOf(c);
  eq(r.errors, [], 'no BEST-OF-N ERROR from mixing implicit group x with explicit group x');
  ok(!r.warns.some((l) => /\bw\b/.test(l) && /shape/i.test(l)), `no mixed-shape WARN for explicit group w vs ungrouped lane w: ${r.out}`);
  ok(!r.warns.some((l) => /\bx\b/.test(l) && /shape/i.test(l)), `no mixed-shape WARN for group x: ${r.out}`);
  eq(r.code, 0, 'exit');
});

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
test('A69 a held ledger lock older than FLEET_LOCK_MAX_AGE_MS is reaped even though its pid is alive', async () => {
  const c = ctx();
  must(c, ['init', 'f']);
  must(c, ['fact', 'template', '--evidence', 'e']);
  const line = readLedger(c).split('\n').filter(Boolean).pop();
  appendFileSync(c.ledger, `${line}\n`.repeat(200000)); // make the locked section slow enough to catch
  const baseline = new Set(readdirSync(c.dir));
  let caught = null;
  let child = null;
  for (let attempt = 0; attempt < 5 && !caught; attempt++) {
    child = spawn(process.execPath, [FLEET, 'fact', `probe${attempt}`, '--evidence', 'e'], { cwd: c.cwd, env: { ...baseEnv, FLEET_DIR: c.dir }, stdio: 'ignore' });
    let exited = false;
    child.on('exit', () => (exited = true));
    const t0 = Date.now();
    while (!exited && Date.now() - t0 < 20000) {
      const extra = readdirSync(c.dir).filter((n) => !baseline.has(n));
      if (extra.length) {
        process.kill(child.pid, 'SIGSTOP');
        caught = extra;
        break;
      }
      await sleep(2);
    }
    if (!caught) child.kill('SIGKILL');
  }
  try {
    ok(caught, 'fixture: observed a lock entry in the ledger directory while a writer held it');
    await sleep(1500);
    const r = await runNodeAsync(FLEET, ['fact', 'after', '--evidence', 'e'], { cwd: c.cwd, env: { FLEET_DIR: c.dir, FLEET_LOCK_MAX_AGE_MS: '1000' }, timeout: 30000 });
    ok(r.signal === null, `writer finished (killed after 30 s; lock ${caught.join(',')} held by a stopped live pid was not reaped)`);
    eq(r.code, 0, `writer succeeds after reaping the old lock (${r.err.slice(0, 200)})`);
  } finally {
    if (child) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});

function chainReady(n) {
  const c = ctx();
  fleetOf(c, 'f', [['l0'], ['l1', '--deps', 'l0']]);
  const tpl = lines(c).find((l) => l.op === 'lane' && l.slug === 'l1');
  const out = [];
  for (let i = 2; i < n; i++) {
    out.push(JSON.stringify({ ...tpl, slug: `l${i}`, deps: Array.isArray(tpl.deps) ? [`l${i - 1}`] : `l${i - 1}` }));
  }
  appendFileSync(c.ledger, `${out.join('\n')}\n`);
  const t0 = Date.now();
  const r = runNode(FLEET, ['ready'], { cwd: c.cwd, env: { FLEET_DIR: c.dir }, timeout: 60000 });
  const ms = Date.now() - t0;
  ok(r.signal === null, `ready on a ${n}-lane chain finished (killed after 60 s)`);
  eq(outLines(r), ['l0'], `only the head of the ${n}-lane chain is ready`);
  return ms;
}
test('A71 ready on a 10,000-lane chain: < 5 s, or (slow machine) < 15 s with linear scaling from 5,000', () => {
  const t5 = chainReady(5000);
  const t10 = chainReady(10000);
  ok(t10 < 5000 || (t10 < 15000 && t10 / Math.max(t5, 1) < 2.5), `ready took ${t10} ms for 10,000 lanes, ${t5} ms for 5,000 (ratio ${(t10 / Math.max(t5, 1)).toFixed(2)})`);
});

test('A72 set with a repeated key → 64', () => {
  const c = ctx();
  fleetOf(c, 'f', [['a']]);
  expectCode(c, ['set', 'a', 'state=running', 'state=merged'], 64, 'state twice');
  expectCode(c, ['set', 'a', 'note=x', 'agent=q', 'note=y'], 64, 'note twice');
});

test('A73 ready never lists a planned lane of a BEST-OF-N / FIRST-SUFFICIENT group once another is merged', () => {
  const c = ctx();
  fleetOf(c, 'f', [
    ['b1', '--shape', 'BEST-OF-N', '--group', 'gb'], ['b2', '--shape', 'BEST-OF-N', '--group', 'gb'],
    ['f1', '--shape', 'FIRST-SUFFICIENT', '--group', 'gf'], ['f2', '--shape', 'FIRST-SUFFICIENT', '--group', 'gf'],
    ['a1', '--shape', 'ALL', '--group', 'ga'], ['a2', '--shape', 'ALL', '--group', 'ga'],
  ]);
  must(c, ['decide', 'b1 wins', '--kind', 'judge', '--lane', 'b1']);
  for (const x of ['b1', 'f1', 'a1']) must(c, ['set', x, 'state=merged']);
  eq(readyOf(c), ['a2'], 'ready');
});

await s.run();
