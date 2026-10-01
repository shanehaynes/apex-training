// Tests for scripts/fleet.mjs — run with `node --test tests/fleet.test.mjs`.
// Needs Node >= 18.8 (node:test describe/after); the script itself is 18.0-safe.
// Every test gets its own FLEET_DIR from mkdtemp; fixture git repos live in
// their own mkdtemp dirs and are removed at the end.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as F from '../scripts/fleet.mjs';
import {
  fold, parseLedger, readyLanes, findCycles, checkState, computeMetrics,
  parseArgs, parseSetPairs, transitiveDependents,
} from '../scripts/fleet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET = resolve(HERE, '..', 'scripts', 'fleet.mjs');
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix = 'fleet-test-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

/** A CLI runner bound to one fresh FLEET_DIR. */
function fleet(extraEnv = {}) {
  const dir = tmp();
  const base = { FLEET_DIR: dir, FLEET_NOW: '2026-09-26T12:00:00.000Z', ...extraEnv };
  const run = (args, opts = {}) => {
    const env = { ...process.env, ...base, ...(opts.env ?? {}) };
    delete env.FLEET_FIX_ROUNDS;
    if (base.FLEET_FIX_ROUNDS) env.FLEET_FIX_ROUNDS = base.FLEET_FIX_ROUNDS;
    if (opts.env?.FLEET_FIX_ROUNDS) env.FLEET_FIX_ROUNDS = opts.env.FLEET_FIX_ROUNDS;
    const r = spawnSync(process.execPath, [FLEET, ...args], { env, cwd: opts.cwd ?? dir, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const ok = (args, opts) => {
    const r = run(args, opts);
    assert.equal(r.code, 0, `fleet ${args.join(' ')} failed (${r.code}): ${r.err}`);
    return r;
  };
  const ledger = () => readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  const events = () => ledger().trim().split('\n').map((l) => JSON.parse(l));
  const json = () => JSON.parse(ok(['show', '--json']).out);
  return { dir, run, ok, ledger, events, json };
}

/** Build a folded state from compact lane specs, without touching disk. */
function stateOf(lanes, decisions = [], defects = []) {
  const ev = [{ op: 'init', name: 't', ts: 'x' }];
  for (const l of lanes) {
    const { sets, ...decl } = l;
    ev.push({ op: 'lane', ts: 'x', ...decl });
    if (sets) ev.push({ op: 'set', ts: 'x', slug: l.slug, values: sets });
  }
  for (const d of decisions) ev.push({ op: 'decide', ts: 'x', ...d });
  for (const d of defects) ev.push({ op: 'defect', ts: 'x', ...d });
  return fold(ev);
}

const messages = (state, opts) => checkState(state, opts).map((p) => `${p.level} ${p.message}`);
const has = (list, level, re) => list.some((m) => m.startsWith(level) && re.test(m));

// ─── init ────────────────────────────────────────────────────────────────────

describe('init', () => {
  test('appends an init line with name, goal and injected ts', () => {
    const f = fleet();
    f.ok(['init', 'alpha', '--goal', 'ship it']);
    assert.deepEqual(f.events(), [{ ts: '2026-09-26T12:00:00.000Z', op: 'init', name: 'alpha', goal: 'ship it' }]);
    const s = f.json();
    assert.equal(s.name, 'alpha');
    assert.equal(s.goal, 'ship it');
  });

  test('archives a non-empty ledger under a filesystem-safe name first', () => {
    const f = fleet();
    f.ok(['init', 'alpha']);
    f.ok(['lane', 'a']);
    f.ok(['init', 'beta'], { env: { FLEET_NOW: '2026-09-27T01:02:03.456Z' } });
    const files = readdirSync(join(f.dir, 'archive'));
    assert.deepEqual(files, ['2026-09-27T01-02-03.456Z-alpha.jsonl']);
    assert.ok(!files[0].includes(':'));
    const archived = readFileSync(join(f.dir, 'archive', files[0]), 'utf8');
    assert.match(archived, /"name":"alpha"/);
    assert.match(archived, /"slug":"a"/);
    assert.equal(f.events().length, 1);
    assert.equal(f.json().name, 'beta');
    assert.deepEqual(f.json().lanes, []);
  });

  test('an empty ledger is not archived; repeated archives do not collide', () => {
    const f = fleet();
    writeFileSync(join(f.dir, 'ledger.jsonl'), '');
    f.ok(['init', 'a']);
    assert.ok(!existsSync(join(f.dir, 'archive')));
    f.ok(['init', 'a']);
    f.ok(['init', 'a']);
    assert.equal(readdirSync(join(f.dir, 'archive')).length, 2);
  });

  test('missing name is a usage error', () => {
    assert.equal(fleet().run(['init']).code, 64);
  });
});

// ─── lane ────────────────────────────────────────────────────────────────────

describe('lane', () => {
  test('defaults and all flags are recorded; state planned', () => {
    const f = fleet();
    f.ok(['init', 'x']);
    f.ok(['lane', 'a']);
    f.ok(['lane', 'b', '--role', 'verifier', '--shape', 'BEST-OF-N', '--group', 'g', '--deps', 'a, c',
      '--tier', 'T3', '--branch', 'feat/b', '--path', '/p/b', '--brief', 'briefs/b.md', '--note', 'hi']);
    const [a, b] = f.json().lanes;
    assert.equal(a.role, 'impl');
    assert.equal(a.shape, 'ALL');
    assert.equal(a.tier, 'T1');
    assert.equal(a.state, 'planned');
    assert.deepEqual(a.deps, []);
    assert.equal(b.role, 'verifier');
    assert.equal(b.shape, 'BEST-OF-N');
    assert.equal(b.group, 'g');
    assert.deepEqual(b.deps, ['a', 'c']);
    assert.equal(b.tier, 'T3');
    assert.equal(b.branch, 'feat/b');
    assert.equal(b.path, '/p/b');
    assert.equal(b.brief, 'briefs/b.md');
    assert.equal(b.note, 'hi');
  });

  test('duplicate slug → exit 1 and nothing appended', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    const before = f.ledger();
    const r = f.run(['lane', 'a', '--role', 'judge']);
    assert.equal(r.code, 1);
    assert.equal(f.ledger(), before);
  });

  for (const [flag, value] of [['--role', 'boss'], ['--shape', 'SOME'], ['--tier', 'T9']]) {
    test(`invalid ${flag} → exit 64, nothing written`, () => {
      const f = fleet();
      assert.equal(f.run(['lane', 'a', flag, value]).code, 64);
      assert.ok(!existsSync(join(f.dir, 'ledger.jsonl')));
    });
  }

  test('unknown flag, missing flag value, missing slug → 64', () => {
    const f = fleet();
    assert.equal(f.run(['lane', 'a', '--colour', 'red']).code, 64);
    assert.equal(f.run(['lane', 'a', '--role']).code, 64);
    assert.equal(f.run(['lane']).code, 64);
    assert.equal(f.run(['lane', 'a', 'b']).code, 64);
  });

  test('--flag=value form works', () => {
    const f = fleet();
    f.ok(['lane', 'a', '--role=judge']);
    assert.equal(f.json().lanes[0].role, 'judge');
  });
});

// ─── set ─────────────────────────────────────────────────────────────────────

describe('set', () => {
  test('applies every key; later sets win; integers stored as numbers', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    f.ok(['set', 'a', 'state=running', 'agent=ag1', 'sha=0123456789abcdef', 'branch=feat/a', 'path=/w/a',
      'report=r.md', 'round=1', 'note=n=1', 'findings=4', 'confirmed=2', 'disputed=0']);
    f.ok(['set', 'a', 'state=reported', 'round=2']);
    const a = f.json().lanes[0];
    assert.equal(a.state, 'reported');
    assert.equal(a.agent, 'ag1');
    assert.equal(a.sha, '0123456789abcdef');
    assert.equal(a.branch, 'feat/a');
    assert.equal(a.path, '/w/a');
    assert.equal(a.report, 'r.md');
    assert.equal(a.round, 2);
    assert.equal(a.note, 'n=1');
    assert.equal(a.findings, 4);
    assert.equal(a.confirmed, 2);
    assert.equal(a.disputed, 0);
    // ledger lines are appended, never rewritten
    assert.equal(f.events().length, 3);
  });

  test('unknown slug → 1', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    assert.equal(f.run(['set', 'zz', 'state=running']).code, 1);
  });

  for (const bad of ['colour=red', 'state=done', 'round=-1', 'round=1.5', 'findings=x', 'noequals', '=x']) {
    test(`bad pair ${bad} → 64`, () => {
      const f = fleet();
      f.ok(['lane', 'a']);
      const before = f.ledger();
      assert.equal(f.run(['set', 'a', bad]).code, 64);
      assert.equal(f.ledger(), before);
    });
  }

  test('no pairs → 64', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    assert.equal(f.run(['set', 'a']).code, 64);
  });
});

// ─── fact / decide / defect ─────────────────────────────────────────────────

describe('fact, decide, defect', () => {
  test('facts get sequential ids and keep topic/from', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    assert.equal(f.ok(['fact', 'node is 22', '--evidence', 'node -v']).out.trim(), 'F1');
    assert.equal(f.ok(['fact', 'gate', 'passes', '--evidence', 'ran it', '--topic', 'ci', '--from', 'a']).out.trim(), 'F2');
    const { facts } = f.json();
    assert.deepEqual(facts.map((x) => x.id), ['F1', 'F2']);
    assert.equal(facts[1].text, 'gate passes');
    assert.equal(facts[1].topic, 'ci');
    assert.equal(facts[1].from, 'a');
    assert.equal(facts[0].evidence, 'node -v');
  });

  test('fact without --evidence → 64; empty evidence → 64', () => {
    const f = fleet();
    assert.equal(f.run(['fact', 'x']).code, 64);
    assert.equal(f.run(['fact', 'x', '--evidence', '']).code, 64);
    assert.equal(f.run(['fact', '--evidence', 'e']).code, 64);
  });

  test('decide defaults to plan; judge needs --lane; bad kind → 64', () => {
    const f = fleet();
    f.ok(['lane', 'b']);
    f.ok(['decide', 'go wide']);
    f.ok(['decide', 'b wins', '--kind', 'judge', '--lane', 'b']);
    assert.equal(f.run(['decide', 'who?', '--kind', 'judge']).code, 64);
    assert.equal(f.run(['decide', 'x', '--kind', 'vibes']).code, 64);
    const { decisions } = f.json();
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].kind, 'plan');
    assert.deepEqual([decisions[1].kind, decisions[1].lane], ['judge', 'b']);
  });

  test('defect records against a known lane; unknown lane → 1; missing text → 64', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    f.ok(['defect', 'a', 'broke', 'login']);
    assert.equal(f.run(['defect', 'zz', 'x']).code, 1);
    assert.equal(f.run(['defect', 'a']).code, 64);
    assert.deepEqual(f.json().defects.map((d) => [d.lane, d.text]), [['a', 'broke login']]);
  });
});

// ─── show ────────────────────────────────────────────────────────────────────

describe('show', () => {
  test('--json shape', () => {
    const f = fleet();
    f.ok(['init', 'fl', '--goal', 'g']);
    f.ok(['lane', 'a', '--group', 'grp']);
    f.ok(['set', 'a', 'agent=x']);
    f.ok(['fact', 't', '--evidence', 'e']);
    f.ok(['decide', 'd']);
    f.ok(['defect', 'a', 'oops']);
    const s = f.json();
    assert.deepEqual(Object.keys(s).sort(), ['decisions', 'defects', 'facts', 'goal', 'lanes', 'name']);
    for (const k of ['lanes', 'facts', 'decisions', 'defects']) assert.ok(Array.isArray(s[k]), k);
    assert.equal(s.lanes.length, 1);
    const l = s.lanes[0];
    for (const k of ['slug', 'role', 'shape', 'tier', 'deps', 'state', 'group', 'agent']) assert.ok(k in l, k);
    assert.ok(!('sha' in l), 'unset fields are absent');
  });

  test('--json with no ledger: nulls and empty lists', () => {
    assert.deepEqual(fleet().json(), { name: null, goal: null, lanes: [], facts: [], decisions: [], defects: [] });
  });

  test('text: one row per lane with sha(12), then counts', () => {
    const f = fleet();
    f.ok(['init', 'fl']);
    f.ok(['lane', 'a', '--tier', 'T2', '--role', 'reviewer']);
    f.ok(['lane', 'b', '--deps', 'a', '--shape', 'BEST-OF-N', '--group', 'g1']);
    f.ok(['set', 'a', 'sha=0123456789abcdef0123', 'round=2', 'agent=ag7', 'state=running']);
    f.ok(['fact', 't', '--evidence', 'e']);
    const out = f.ok(['show']).out;
    const rowA = out.split('\n').find((l) => l.startsWith('a '));
    const rowB = out.split('\n').find((l) => l.startsWith('b '));
    assert.deepEqual(rowA.split(/\s+/), ['a', 'reviewer', 'ALL', '-', 'T2', 'running', '-', '0123456789ab', '2', 'ag7']);
    assert.deepEqual(rowB.split(/\s+/), ['b', 'impl', 'BEST-OF-N', 'g1', 'T1', 'planned', 'a', '-', '-', '-']);
    assert.match(out, /facts: 1\s+decisions: 0/);
  });

  test('extra positional or unknown flag → 64', () => {
    const f = fleet();
    assert.equal(f.run(['show', 'x']).code, 64);
    assert.equal(f.run(['show', '--yaml']).code, 64);
  });
});

// ─── ready ───────────────────────────────────────────────────────────────────

describe('ready', () => {
  test('orders by transitive dependents desc, ties by declaration order', () => {
    // c has 2 transitive dependents (d, e); a has 1 (b); x, y have none.
    const s = stateOf([
      { slug: 'x', deps: [] },
      { slug: 'a', deps: [] },
      { slug: 'b', deps: ['a'] },
      { slug: 'c', deps: [] },
      { slug: 'd', deps: ['c'] },
      { slug: 'e', deps: ['d'] },
      { slug: 'y', deps: [] },
    ]);
    assert.equal(transitiveDependents(s).get('c').size, 2);
    assert.deepEqual(readyLanes(s), ['c', 'a', 'x', 'y']);
  });

  test('only planned lanes whose deps are merged; undeclared dep blocks', () => {
    const s = stateOf([
      { slug: 'a', sets: { state: 'merged' } },
      { slug: 'b', deps: ['a'] },
      { slug: 'c', deps: ['a', 'ghost'] },
      { slug: 'd', deps: ['b'] },
      { slug: 'e', sets: { state: 'running' } },
    ]);
    assert.deepEqual(readyLanes(s), ['b']);
  });

  test('CLI prints one slug per line', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    f.ok(['lane', 'b']);
    f.ok(['lane', 'c', '--deps', 'b']);
    assert.equal(f.ok(['ready']).out, 'b\na\n');
    f.ok(['set', 'b', 'state=merged']);
    assert.equal(f.ok(['ready']).out, 'a\nc\n');
  });

  test('lanes in a cycle are never ready and do not hang', () => {
    const s = stateOf([{ slug: 'a', deps: ['b'] }, { slug: 'b', deps: ['a'] }, { slug: 'c' }]);
    assert.deepEqual(readyLanes(s), ['c']);
  });
});

// ─── check ───────────────────────────────────────────────────────────────────

describe('check', () => {
  test('ERROR undeclared dep — positive and negative', () => {
    assert.ok(has(messages(stateOf([{ slug: 'a', deps: ['ghost'] }])), 'ERROR', /a.*ghost.*not a declared lane/));
    assert.deepEqual(messages(stateOf([{ slug: 'a' }, { slug: 'b', deps: ['a'] }])), []);
  });

  test('ERROR 2-cycle is named', () => {
    const s = stateOf([{ slug: 'a', deps: ['b'] }, { slug: 'b', deps: ['a'] }]);
    assert.deepEqual(findCycles(s), [['a', 'b', 'a']]);
    assert.ok(has(messages(s), 'ERROR', /dependency cycle: a -> b -> a/));
  });

  test('ERROR 3-cycle is named once, along real edges', () => {
    // a depends on c, c on b, b on a: edges a→c→b→a
    const s = stateOf([{ slug: 'a', deps: ['c'] }, { slug: 'b', deps: ['a'] }, { slug: 'c', deps: ['b'] }, { slug: 'd', deps: ['a'] }]);
    assert.deepEqual(findCycles(s), [['a', 'c', 'b', 'a']]);
    const m = messages(s);
    assert.equal(m.filter((x) => /cycle/.test(x)).length, 1);
    assert.ok(has(m, 'ERROR', /dependency cycle: a -> c -> b -> a/));
  });

  test('self-dependency is a cycle; a diamond is not', () => {
    assert.deepEqual(findCycles(stateOf([{ slug: 'a', deps: ['a'] }])), [['a', 'a']]);
    const diamond = stateOf([{ slug: 'a' }, { slug: 'b', deps: ['a'] }, { slug: 'c', deps: ['a'] }, { slug: 'd', deps: ['b', 'c'] }]);
    assert.deepEqual(findCycles(diamond), []);
    assert.deepEqual(messages(diamond), []);
  });

  test('ERROR more than one BEST-OF-N lane merged in a group — positive and negative', () => {
    const lanes = (bState) => [
      { slug: 'a1', shape: 'BEST-OF-N', group: 'g', sets: { state: 'merged' } },
      { slug: 'a2', shape: 'BEST-OF-N', group: 'g', sets: { state: bState } },
    ];
    const judge = [{ kind: 'judge', lane: 'a1', text: 'a1' }];
    assert.ok(has(messages(stateOf(lanes('merged'), judge)), 'ERROR', /group g: 2 lanes merged/));
    assert.deepEqual(messages(stateOf(lanes('retired'), judge)), []);
    // different groups may each merge one
    const two = stateOf([
      { slug: 'a1', shape: 'BEST-OF-N', group: 'g', sets: { state: 'merged' } },
      { slug: 'b1', shape: 'BEST-OF-N', group: 'h', sets: { state: 'merged' } },
    ], [{ kind: 'judge', lane: 'a1', text: '' }, { kind: 'judge', lane: 'b1', text: '' }]);
    assert.deepEqual(messages(two), []);
  });

  test('ERROR BEST-OF-N merged without a judge decision naming it — positive and negative', () => {
    const lanes = [
      { slug: 'a1', shape: 'BEST-OF-N', group: 'g', sets: { state: 'merged' } },
      { slug: 'a2', shape: 'BEST-OF-N', group: 'g', sets: { state: 'retired' } },
    ];
    assert.ok(has(messages(stateOf(lanes)), 'ERROR', /a1 merged with no judge/));
    // a judge decision for the other lane, or a non-judge decision naming it, does not count
    assert.ok(has(messages(stateOf(lanes, [{ kind: 'judge', lane: 'a2', text: '' }])), 'ERROR', /a1 merged but the standing judge winner of group g is a2/));
    assert.ok(has(messages(stateOf(lanes, [{ kind: 'merge', lane: 'a1', text: '' }])), 'ERROR', /a1 merged with no judge/));
    assert.deepEqual(messages(stateOf(lanes, [{ kind: 'judge', lane: 'a1', text: '' }])), []);
  });

  test('WARN round ≥ FLEET_FIX_ROUNDS — positive, negative, env override', () => {
    const s = (round) => stateOf([{ slug: 'a', sets: { round } }]);
    assert.ok(has(messages(s(3), { fixRounds: 3 }), 'WARN', /a.*round 3.*escalate/));
    assert.deepEqual(messages(s(2), { fixRounds: 3 }), []);
    assert.deepEqual(messages(s(3), { fixRounds: 5 }), []);
    assert.ok(has(messages(s(1), { fixRounds: 1 }), 'WARN', /escalate/));

    const f = fleet();
    f.ok(['lane', 'a']);
    f.ok(['set', 'a', 'round=2']);
    assert.equal(f.ok(['check']).out, '');
    const r = f.ok(['check'], { env: { FLEET_FIX_ROUNDS: '2' } });
    assert.match(r.out, /^WARN .*escalate/m);
  });

  test('WARN FIRST-SUFFICIENT race ended with no win — positive and negatives', () => {
    const lanes = (s2) => [
      { slug: 'r1', shape: 'FIRST-SUFFICIENT', group: 'race', sets: { state: 'stopped' } },
      { slug: 'r2', shape: 'FIRST-SUFFICIENT', group: 'race', sets: { state: s2 } },
    ];
    assert.ok(has(messages(stateOf(lanes('failed'))), 'WARN', /group race.*race ended with no win/));
    assert.ok(has(messages(stateOf(lanes('retired'))), 'WARN', /race ended with no win/));
    // one lane still going → no warning
    assert.deepEqual(messages(stateOf(lanes('running'), [], [])).filter((m) => /race ended/.test(m)), []);
    // a decide naming a lane of the group → no warning
    assert.deepEqual(messages(stateOf(lanes('failed'), [{ kind: 'escalation', lane: 'r2', text: 'none good enough' }])), []);
  });

  test('WARN running with no agent — positive and negative', () => {
    assert.ok(has(messages(stateOf([{ slug: 'a', sets: { state: 'running' } }])), 'WARN', /a.*running with no agent/));
    assert.deepEqual(messages(stateOf([{ slug: 'a', sets: { state: 'running', agent: 'x' } }])), []);
    assert.deepEqual(messages(stateOf([{ slug: 'a', sets: { agent: '' } }])), []);
  });

  test('CLI exit codes: 1 on ERROR, 0 on WARN only, 0 clean', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    assert.deepEqual([f.run(['check']).code, f.run(['check']).out], [0, '']);
    f.ok(['set', 'a', 'state=running']);
    const w = f.run(['check']);
    assert.equal(w.code, 0);
    assert.match(w.out, /^WARN /m);
    f.ok(['lane', 'b', '--deps', 'nope']);
    const e = f.run(['check']);
    assert.equal(e.code, 1);
    assert.match(e.out, /^ERROR .*nope/m);
    assert.match(e.out, /^WARN /m);
  });
});

// ─── metrics ─────────────────────────────────────────────────────────────────

describe('metrics', () => {
  test('numbers on a hand-built ledger (JSON via CLI)', () => {
    const f = fleet();
    const lines = [
      { op: 'init', name: 'm' },
      { op: 'lane', slug: 'a', role: 'impl', shape: 'ALL', tier: 'T1', deps: [] },
      { op: 'lane', slug: 'b1', role: 'race', shape: 'BEST-OF-N', group: 'g', tier: 'T2', deps: [] },
      { op: 'lane', slug: 'b2', role: 'race', shape: 'BEST-OF-N', group: 'g', tier: 'T2', deps: [] },
      { op: 'lane', slug: 'c1', role: 'race', shape: 'BEST-OF-N', group: 'h', tier: 'T2', deps: [] },
      { op: 'lane', slug: 'c2', role: 'race', shape: 'BEST-OF-N', group: 'h', tier: 'T2', deps: [] },
      { op: 'lane', slug: 'd1', role: 'race', shape: 'BEST-OF-N', group: 'k', tier: 'T3', deps: [] },
      { op: 'lane', slug: 'r1', role: 'reviewer', tier: 'T0', deps: [] },
      { op: 'lane', slug: 'r2', role: 'reviewer', tier: 'T0', deps: [] },
      { op: 'lane', slug: 'v1', role: 'verifier', tier: 'T1', deps: [] },
      { op: 'set', slug: 'a', values: { round: 1 } },
      { op: 'set', slug: 'b1', values: { round: 4 } },
      { op: 'set', slug: 'r1', values: { findings: 5, confirmed: 3 } },
      { op: 'set', slug: 'r2', values: { findings: 2, confirmed: 2 } },
      { op: 'set', slug: 'v1', values: { disputed: 2, round: 1 } },
      { op: 'decide', kind: 'judge', lane: 'b2', text: 'b2 wins' },
      { op: 'decide', kind: 'judge', lane: 'c1', text: 'c1 wins' },
      { op: 'defect', lane: 'a', text: 'x' },
      { op: 'defect', lane: 'b2', text: 'y' },
      { op: 'defect', lane: 'b2', text: 'z' },
    ].map((e) => JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', ...e })).join('\n');
    writeFileSync(join(f.dir, 'ledger.jsonl'), `${lines}\n`);
    const m = JSON.parse(f.ok(['metrics', '--json']).out);
    assert.equal(m.lanes, 9);
    assert.deepEqual(m.lanesPerTier, { T0: 2, T1: 2, T2: 4, T3: 1 });
    assert.deepEqual(m.lanesPerRole, { impl: 1, verifier: 1, reviewer: 2, judge: 0, race: 5, contract: 0, spec: 0, adjudicator: 0 });
    assert.deepEqual(m.bestOfN, { groups: 3, judged: 2, winnerNotFirst: 1 });
    assert.deepEqual(m.reviewer, { lanes: 2, findings: 7, confirmed: 5 });
    assert.deepEqual(m.verifier, { lanes: 1, disputed: 2 });
    assert.deepEqual(m.fixRounds, { lanes: 3, max: 4, mean: 2 });
    assert.equal(m.defects, 3);
    assert.deepEqual(m.defectsPerTier, { T0: 0, T1: 1, T2: 2, T3: 0 });

    const text = f.ok(['metrics']).out;
    assert.match(text, /lanes per tier: T0=2 T1=2 T2=4 T3=1/);
    assert.match(text, /BEST-OF-N groups: 3\s+judged: 2\s+winner not first-declared: 1/);
    assert.match(text, /reviewer findings: 7\s+confirmed: 5/);
    assert.match(text, /verifier disputed tests: 2/);
    assert.match(text, /fix rounds: max=4 mean=2/);
    assert.match(text, /defects: 3\s+per tier: T0=0 T1=1 T2=2 T3=0/);
  });

  test('empty fleet: nulls for rounds, zeros elsewhere', () => {
    const m = computeMetrics(fold([]));
    assert.deepEqual(m.fixRounds, { lanes: 0, max: null, mean: null });
    assert.deepEqual(m.bestOfN, { groups: 0, judged: 0, winnerNotFirst: 0 });
  });

  test('the latest judge ruling in a group stands', () => {
    const s = stateOf(
      [{ slug: 'x1', shape: 'BEST-OF-N', group: 'g' }, { slug: 'x2', shape: 'BEST-OF-N', group: 'g' }],
      [{ kind: 'judge', lane: 'x2', text: '' }, { kind: 'judge', lane: 'x1', text: 'overturned' }],
    );
    assert.deepEqual(computeMetrics(s).bestOfN, { groups: 1, judged: 1, winnerNotFirst: 0 });
  });
});

// ─── parsing / validation ───────────────────────────────────────────────────

describe('usage and validation', () => {
  test('unknown command and no command → 64 with usage on stderr', () => {
    const f = fleet();
    for (const args of [['frobnicate'], []]) {
      const r = f.run(args);
      assert.equal(r.code, 64);
      assert.match(r.err, /usage: node fleet\.mjs/);
    }
  });

  test('--json on a command without it → 64', () => {
    const f = fleet();
    assert.equal(f.run(['ready', '--json']).code, 64);
    assert.equal(f.run(['check', 'extra']).code, 64);
    assert.equal(f.run(['metrics', '--json=1']).code, 64);
  });

  test('parseArgs and parseSetPairs are pure', () => {
    assert.deepEqual(parseArgs(['fact', 'a', 'b', '--evidence', 'e']), { cmd: 'fact', pos: ['a', 'b'], flags: { evidence: 'e' } });
    assert.deepEqual(parseArgs(['decide', '--', '--not-a-flag']).pos, ['--not-a-flag']);
    assert.deepEqual(parseSetPairs(['round=0', 'note=a=b']), { round: 0, note: 'a=b' });
    assert.throws(() => parseSetPairs(['round=x']), (e) => e.code === 64);
  });

  test('unparseable ledger lines are skipped with a warning; the rest still folds', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    writeFileSync(join(f.dir, 'ledger.jsonl'), `${f.ledger()}not json\n`);
    f.ok(['lane', 'b']);
    const r = f.ok(['show', '--json']);
    assert.match(r.err, /unparseable ledger line\(s\): 2/);
    assert.deepEqual(JSON.parse(r.out).lanes.map((l) => l.slug), ['a', 'b']);
    assert.equal(parseLedger('{"op":"x"}\n\n[1]\n').bad.length, 1);
  });

  test('without FLEET_DIR, the ledger lives under <primary>/.claude/state/fleet', () => {
    const repo = tmp('fleet-primary-');
    execFileSync('git', ['init', '-q', repo]);
    const sub = join(repo, 'sub');
    execFileSync('mkdir', ['-p', sub]);
    const env = { ...process.env, FLEET_NOW: '2026-09-26T12:00:00.000Z' };
    delete env.FLEET_DIR;
    const r = spawnSync(process.execPath, [FLEET, 'init', 'p'], { cwd: sub, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(repo, '.claude', 'state', 'fleet', 'ledger.jsonl')));
  });

  test('outside a git repository without FLEET_DIR → exit 1', () => {
    const dir = tmp('fleet-nogit-');
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) };
    delete env.FLEET_DIR;
    const r = spawnSync(process.execPath, [FLEET, 'show'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not inside a git repository/);
  });
});

// ─── resume ──────────────────────────────────────────────────────────────────

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture() {
  const root = tmp('fleet-resume-');
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  g(work, 'config', 'user.email', 'fleet@test.invalid');
  g(work, 'config', 'user.name', 'Fleet Test');
  g(work, 'config', 'commit.gpgsign', 'false');
  g(work, 'remote', 'add', 'origin', origin);
  writeFileSync(join(work, 'f.txt'), 'one\n');
  g(work, 'add', '.');
  g(work, 'commit', '-q', '-m', 'one');
  g(work, 'push', '-q', 'origin', 'main');
  // feat/match: pushed, recorded sha equals origin
  g(work, 'branch', 'feat/match');
  g(work, 'push', '-q', 'origin', 'feat/match');
  const matchSha = g(work, 'rev-parse', 'feat/match');
  // feat/differs: pushed, then a local commit recorded but not pushed
  g(work, 'checkout', '-q', '-b', 'feat/differs');
  g(work, 'push', '-q', 'origin', 'feat/differs');
  writeFileSync(join(work, 'f.txt'), 'two\n');
  g(work, 'commit', '-q', '-am', 'two');
  const differsSha = g(work, 'rev-parse', 'HEAD');
  // feat/local: never pushed
  g(work, 'checkout', '-q', '-b', 'feat/local');
  const localSha = g(work, 'rev-parse', 'HEAD');
  // leave two dirty files in the working tree
  writeFileSync(join(work, 'f.txt'), 'dirty\n');
  writeFileSync(join(work, 'new.txt'), 'x\n');
  return { root, origin, work, matchSha, differsSha, localSha };
}

describe('resume', () => {
  test('MATCH, DIFFERS, NOT PUSHED; dirty count; missing path; read-only', () => {
    const fx = fixture();
    const f = fleet();
    const at = { cwd: fx.work };
    f.ok(['init', 'r'], at);
    f.ok(['lane', 'm', '--branch', 'feat/match', '--path', fx.work], at);
    f.ok(['set', 'm', 'state=running', 'agent=a', `sha=${fx.matchSha}`], at);
    f.ok(['lane', 'd', '--branch', 'feat/differs', '--path', fx.work], at);
    f.ok(['set', 'd', 'state=reported', `sha=${fx.differsSha}`], at);
    f.ok(['lane', 'n', '--branch', 'feat/local', '--path', fx.work], at);
    f.ok(['set', 'n', 'state=checked', `sha=${fx.localSha.slice(0, 12)}`], at);
    f.ok(['lane', 'short', '--branch', 'feat/match', '--path', join(fx.root, 'gone')], at);
    f.ok(['set', 'short', 'state=running', `sha=${fx.matchSha.slice(0, 7)}`], at);
    f.ok(['lane', 'nobranch'], at);
    f.ok(['set', 'nobranch', 'state=running'], at);
    f.ok(['lane', 'idle', '--branch', 'feat/match'], at);
    f.ok(['set', 'idle', 'state=merged'], at);

    const before = f.ledger();
    const refsBefore = g(fx.origin, 'for-each-ref');
    const statusBefore = g(fx.work, 'status', '--porcelain');

    const r = f.ok(['resume'], at);
    const line = (slug) => r.out.split('\n').find((l) => l.startsWith(`${slug}  state=`));
    assert.match(r.out, /SLUG\s+ROLE/, 'resume starts with show');
    assert.match(line('m'), /path=ok .* dirty=2 .*push=MATCH/);
    assert.match(line('d'), /push=DIFFERS/);
    assert.match(line('n'), /push=NOT PUSHED .*AHEAD \?$/); // A65: no origin/<branch> to count from
    assert.match(line('short'), /path=MISSING .*dirty=- .*push=MATCH/);
    assert.match(line('nobranch'), /path=- .*push=- \(no branch\)/);
    assert.equal(line('idle'), undefined, 'merged lanes are not inspected');

    assert.equal(f.ledger(), before, 'ledger unchanged');
    assert.equal(g(fx.origin, 'for-each-ref'), refsBefore, 'origin unchanged');
    assert.equal(g(fx.work, 'status', '--porcelain'), statusBefore, 'worktree unchanged');
  });

  test('branch pushed but no sha recorded → DIFFERS', () => {
    const fx = fixture();
    const f = fleet();
    f.ok(['lane', 'x', '--branch', 'feat/match', '--path', fx.work], { cwd: fx.work });
    f.ok(['set', 'x', 'state=running'], { cwd: fx.work });
    assert.match(f.ok(['resume'], { cwd: fx.work }).out, /x {2}state=running .*push=DIFFERS \(.*no sha recorded\)/);
  });
});

// ─── contract amendments, round 2 (A25–A34) ─────────────────────────────────

/** Run the CLI asynchronously (for concurrency tests). */
function runAsync(args, env, cwd) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [FLEET, ...args], { env: { ...process.env, ...env }, cwd });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => res({ code, out, err }));
  });
}

describe('A25 append after a partial last line', () => {
  test('a crash-truncated last line does not swallow the next record', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    f.ok(['lane', 'b', '--deps', 'a']);
    writeFileSync(join(f.dir, 'ledger.jsonl'), `${f.ledger()}{"ts":"2026-09-26T12:00:00.000Z","op":"se`);
    f.ok(['set', 'a', 'state=merged']);
    const r = f.ok(['show', '--json']);
    assert.equal(JSON.parse(r.out).lanes[0].state, 'merged');
    assert.equal(f.ok(['ready']).out, 'b\n');
    assert.ok(f.ledger().endsWith('\n'));
  });

  test('a complete record missing only its newline is kept too', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    writeFileSync(join(f.dir, 'ledger.jsonl'), f.ledger().replace(/\n$/, ''));
    f.ok(['lane', 'b']);
    assert.deepEqual(f.json().lanes.map((l) => l.slug), ['a', 'b']);
  });
});

describe('A26 BEST-OF-N standing winner', () => {
  const lanes = (merged) => [
    { slug: 'a1', shape: 'BEST-OF-N', group: 'g', sets: { state: merged === 'a1' ? 'merged' : 'retired' } },
    { slug: 'a2', shape: 'BEST-OF-N', group: 'g', sets: { state: merged === 'a2' ? 'merged' : 'retired' } },
  ];
  const overturned = [{ kind: 'judge', lane: 'a1', text: 'a1' }, { kind: 'judge', lane: 'a2', text: 'overturned: a2' }];

  test('merging an overturned winner is an ERROR', () => {
    assert.ok(has(messages(stateOf(lanes('a1'), overturned)), 'ERROR', /a1 merged but the standing judge winner of group g is a2/));
  });

  test('merging the standing winner is clean; check and metrics agree', () => {
    const s = stateOf(lanes('a2'), overturned);
    assert.deepEqual(messages(s), []);
    assert.equal(F.standingWinner(s, s.lanes), 'a2');
    assert.equal(computeMetrics(s).bestOfN.winnerNotFirst, 1);
  });
});

describe('A27 resume never hangs', () => {
  test('gitEnv disables prompts and interactive ssh unless GIT_SSH_COMMAND is set', () => {
    const e = F.gitEnv({ PATH: '/bin' });
    assert.equal(e.GIT_TERMINAL_PROMPT, '0');
    assert.equal(e.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
    assert.equal(F.gitEnv({ GIT_SSH_COMMAND: 'my-ssh' }).GIT_SSH_COMMAND, 'my-ssh');
  });

  test('a remote that never answers → push=UNKNOWN (timeout) within FLEET_GIT_TIMEOUT_MS', () => {
    const fx = fixture();
    const hang = join(fx.root, 'hang.sh');
    writeFileSync(hang, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    g(fx.work, 'remote', 'set-url', 'origin', 'ssh://fleet.invalid/x.git');
    const f = fleet({ GIT_SSH_COMMAND: hang, FLEET_GIT_TIMEOUT_MS: '1000' });
    f.ok(['lane', 'x', '--branch', 'feat/match', '--path', fx.work], { cwd: fx.work });
    f.ok(['set', 'x', 'state=running', 'agent=a'], { cwd: fx.work });
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [FLEET, 'resume'], {
      cwd: fx.work, encoding: 'utf8', timeout: 12000,
      env: { ...process.env, FLEET_DIR: f.dir, GIT_SSH_COMMAND: hang, FLEET_GIT_TIMEOUT_MS: '1000' },
    });
    assert.equal(r.status, 0, `resume hung or failed: ${r.error ?? r.stderr}`);
    assert.ok(Date.now() - t0 < 10000);
    assert.match(r.stdout, /x {2}state=running .*push=UNKNOWN \(timeout\)/);
  });

  test('a blocking credential helper is never consulted', async () => {
    const fx = fixture();
    // An HTTP remote that always demands credentials, in a separate process.
    const server = spawn(process.execPath, ['-e', `
      const http = require('http');
      const s = http.createServer((q, r) => { r.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); r.end(); });
      s.listen(0, '127.0.0.1', () => console.log(s.address().port));
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const port = await new Promise((res) => server.stdout.once('data', (d) => res(String(d).trim())));
      g(fx.work, 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/x.git`);
      g(fx.work, 'config', 'credential.helper', '!sleep 30; true');
      const f = fleet();
      f.ok(['lane', 'x', '--branch', 'feat/match', '--path', fx.work], { cwd: fx.work });
      f.ok(['set', 'x', 'state=running', 'agent=a'], { cwd: fx.work });
      const env = { ...process.env, FLEET_DIR: f.dir, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
      for (const k of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete env[k];
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [FLEET, 'resume'], { cwd: fx.work, encoding: 'utf8', timeout: 12000, env });
      assert.equal(r.status, 0, `resume hung or failed: ${r.error ?? r.stderr}`);
      assert.ok(Date.now() - t0 < 10000, 'returned without waiting on the helper');
      assert.match(r.stdout, /push=UNKNOWN \(ls-remote failed/);
    } finally {
      server.kill();
    }
  });
});

describe('A28 resume AHEAD and --no-optional-locks', () => {
  test('local commits beyond the pushed sha → AHEAD n alongside MATCH', () => {
    const fx = fixture();
    const f = fleet();
    g(fx.work, 'checkout', '-q', '-f', 'feat/match');
    for (const n of ['a', 'b']) {
      writeFileSync(join(fx.work, `${n}.txt`), n);
      g(fx.work, 'add', `${n}.txt`);
      g(fx.work, 'commit', '-q', '-m', n);
    }
    f.ok(['lane', 'm', '--branch', 'feat/match', '--path', fx.work], { cwd: fx.work });
    f.ok(['set', 'm', 'state=running', 'agent=a', `sha=${fx.matchSha}`], { cwd: fx.work });
    const line = f.ok(['resume'], { cwd: fx.work }).out.split('\n').find((l) => l.startsWith('m  state='));
    assert.match(line, /push=MATCH .*AHEAD 2$/);
  });

  test('no AHEAD when HEAD is the pushed commit', () => {
    const fx = fixture();
    const f = fleet();
    g(fx.work, 'checkout', '-q', '-f', 'feat/match');
    f.ok(['lane', 'm', '--branch', 'feat/match', '--path', fx.work], { cwd: fx.work });
    f.ok(['set', 'm', 'state=running', 'agent=a', `sha=${fx.matchSha}`], { cwd: fx.work });
    const line = f.ok(['resume'], { cwd: fx.work }).out.split('\n').find((l) => l.startsWith('m  state='));
    assert.match(line, /push=MATCH/);
    assert.doesNotMatch(line, /AHEAD/);
  });

  test('every git call carries --no-optional-locks and an empty credential.helper', () => {
    const fx = fixture();
    const bin = tmp('fleet-bin-');
    const log = join(bin, 'git.log');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const f = fleet();
    f.ok(['lane', 'm', '--branch', 'feat/match', '--path', fx.work], { cwd: fx.work });
    f.ok(['set', 'm', 'state=running', 'agent=a', `sha=${fx.matchSha}`], { cwd: fx.work });
    const env = { PATH: `${bin}:${process.env.PATH}` };
    f.ok(['resume'], { cwd: fx.work, env });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.some((c) => /\bstatus\b/.test(c)) && calls.some((c) => /ls-remote/.test(c)), calls.join('\n'));
    for (const c of calls) assert.match(c, /^--no-optional-locks -c credential\.helper= /, c);
  });
});

describe('A29 decide --lane / fact --from must name a declared lane', () => {
  test('unknown → exit 1 and nothing written; known → 0', () => {
    const f = fleet();
    f.ok(['lane', 'a']);
    const before = f.ledger();
    assert.equal(f.run(['decide', 'x', '--kind', 'judge', '--lane', 'nosuch']).code, 1);
    assert.equal(f.run(['decide', 'x', '--lane', 'nosuch']).code, 1);
    assert.equal(f.run(['fact', 'x', '--evidence', 'e', '--from', 'nosuch']).code, 1);
    assert.equal(f.ledger(), before);
    f.ok(['decide', 'x', '--kind', 'judge', '--lane', 'a']);
    f.ok(['fact', 'x', '--evidence', 'e', '--from', 'a']);
  });
});

describe('A30 WARN planned lane blocked by an ended dep', () => {
  for (const st of ['stopped', 'failed', 'retired']) {
    test(`dep ${st} → WARN blocked`, () => {
      const s = stateOf([{ slug: 'a', sets: { state: st } }, { slug: 'b', deps: ['a'] }]);
      assert.ok(has(messages(s), 'WARN', new RegExp(`lane b: blocked: dep a is ${st}`)));
    });
  }
  test('dep merged, or the dependent not planned → no warning', () => {
    assert.deepEqual(messages(stateOf([{ slug: 'a', sets: { state: 'merged' } }, { slug: 'b', deps: ['a'] }])), []);
    assert.deepEqual(messages(stateOf([{ slug: 'a', sets: { state: 'retired' } }, { slug: 'b', deps: ['a'], sets: { state: 'merged' } }])), []);
  });
});

describe('A31 WARN group mixing shapes', () => {
  test('mixed → WARN; uniform → none', () => {
    const mixed = stateOf([{ slug: 'a', shape: 'BEST-OF-N', group: 'g' }, { slug: 'b', shape: 'ALL', group: 'g' }]);
    assert.ok(has(messages(mixed), 'WARN', /group g mixes shapes: a=BEST-OF-N, b=ALL/));
    const uniform = stateOf([{ slug: 'a', shape: 'BEST-OF-N', group: 'g' }, { slug: 'b', shape: 'BEST-OF-N', group: 'g' }]);
    assert.deepEqual(messages(uniform), []);
  });
});

describe('A32 repeated flag → 64', () => {
  for (const args of [
    ['lane', 'a', '--deps', 'x', '--deps', 'y'],
    ['lane', 'a', '--role=impl', '--role', 'judge'],
    ['init', 'n', '--goal', 'a', '--goal=b'],
    ['show', '--json', '--json'],
    ['metrics', '--json', '--json'],
    ['fact', 't', '--evidence', 'a', '--evidence', 'b'],
    ['decide', 't', '--kind', 'plan', '--kind', 'merge'],
  ]) {
    test(args.join(' '), () => {
      const f = fleet();
      f.ok(['lane', 'x']);
      const before = f.ledger();
      assert.equal(f.run(args).code, 64);
      assert.equal(f.ledger(), before);
    });
  }
});

describe('A33 slug and group names', () => {
  for (const args of [
    ['lane', 'a,b'], ['lane', 'a b'], ['lane', ''], ['lane', 'a/b'],
    ['lane', 'a', '--group', 'g h'], ['lane', 'a', '--group', ''], ['lane', 'a', '--deps', 'x y'],
    ['set', 'a b', 'state=running'], ['defect', 'a b', 'text'],
  ]) {
    test(`${JSON.stringify(args)} → 64`, () => {
      const f = fleet();
      assert.equal(f.run(args).code, 64);
      assert.ok(!existsSync(join(f.dir, 'ledger.jsonl')));
    });
  }
  test('names from the allowed alphabet work', () => {
    const f = fleet();
    f.ok(['lane', 'Feat.x_y-1', '--group', 'G.1_-']);
    f.ok(['lane', 'b', '--deps', 'Feat.x_y-1']);
    assert.deepEqual(f.json().lanes[1].deps, ['Feat.x_y-1']);
  });
});

describe('A34 concurrent writers', () => {
  // A large ledger widens the read→append window so an unlocked writer races.
  const bulk = (dir, n) => writeFileSync(join(dir, 'ledger.jsonl'), Array.from({ length: n },
    (_, i) => JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', op: 'lane', slug: `bulk${i}`, deps: [] })).join('\n') + '\n');

  test('16 concurrent facts get 16 distinct sequential ids', async () => {
    const f = fleet();
    bulk(f.dir, 20000);
    const n = 16;
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => runAsync(['fact', `f${i}`, '--evidence', 'e'], { FLEET_DIR: f.dir }, f.dir)));
    for (const r of rs) assert.equal(r.code, 0, r.err);
    const ids = f.events().filter((e) => e.op === 'fact').map((x) => x.id);
    assert.deepEqual([...ids].sort(), Array.from({ length: n }, (_, i) => `F${i + 1}`).sort());
    assert.deepEqual(rs.map((r) => r.out.trim()).sort(), [...ids].sort());
  });

  test('12 concurrent declarations of one slug: exactly one wins', async () => {
    const f = fleet();
    bulk(f.dir, 20000);
    const rs = await Promise.all(Array.from({ length: 12 }, () => runAsync(['lane', 'same'], { FLEET_DIR: f.dir }, f.dir)));
    assert.equal(rs.filter((r) => r.code === 0).length, 1);
    assert.equal(rs.filter((r) => r.code === 1).length, 11);
    assert.equal(f.events().filter((e) => e.op === 'lane' && e.slug === 'same').length, 1);
  });

  const plant = (dir, pid, ageMs = 0) => {
    const lock = join(dir, F.LOCK_NAME);
    execFileSync('mkdir', ['-p', lock]);
    if (pid !== null) writeFileSync(join(lock, 'pid'), String(pid));
    if (ageMs) { const t = (Date.now() - ageMs) / 1000; utimesSync(lock, t, t); }
    return lock;
  };

  test('a lock whose pid is dead is reaped', () => {
    const f = fleet();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    plant(f.dir, Number(dead));
    f.ok(['lane', 'a'], { env: { FLEET_LOCK_TIMEOUT_MS: '5000' } });
    assert.ok(!existsSync(join(f.dir, F.LOCK_NAME)));
  });

  test('a lock held by a live pid is respected (times out, exit 1, lock kept)', () => {
    const f = fleet();
    const lock = plant(f.dir, process.pid);
    const r = f.run(['lane', 'a'], { env: { FLEET_LOCK_TIMEOUT_MS: '300' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /ledger lock .* is held/);
    assert.ok(existsSync(join(lock, 'pid')));
    assert.ok(!existsSync(join(f.dir, 'ledger.jsonl')));
  });

  test('a pid-less lock is reaped only after the grace period', () => {
    const f = fleet();
    plant(f.dir, null);
    assert.equal(f.run(['lane', 'a'], { env: { FLEET_LOCK_TIMEOUT_MS: '300' } }).code, 1);
    rmSync(join(f.dir, F.LOCK_NAME), { recursive: true });
    plant(f.dir, null, 60000);
    f.ok(['lane', 'a'], { env: { FLEET_LOCK_TIMEOUT_MS: '5000' } });
  });
});

// ─── contract amendments, round 4 (A65–A73) ─────────────────────────────────

const resumeLine = (out, slug) => out.split('\n').find((l) => l.startsWith(`${slug}  state=`));

describe('A65 AHEAD ? when it cannot be determined', () => {
  test('tracking ref deleted and origin advanced: unpushed commit is not hidden', () => {
    const fx = fixture();
    g(fx.work, 'checkout', '-q', '-f', 'feat/match');
    writeFileSync(join(fx.work, 'local.txt'), 'l');
    g(fx.work, 'add', 'local.txt');
    g(fx.work, 'commit', '-q', '-m', 'local only');
    g(fx.work, 'update-ref', '-d', 'refs/remotes/origin/feat/match');
    const other = join(fx.root, 'other');
    execFileSync('git', ['clone', '-q', '-b', 'feat/match', fx.origin, other]);
    g(other, 'config', 'user.email', 'o@test.invalid');
    g(other, 'config', 'user.name', 'O');
    g(other, 'commit', '-q', '--allow-empty', '-m', 'remote advance');
    g(other, 'push', '-q', 'origin', 'feat/match');
    const f = fleet();
    f.ok(['lane', 'm', '--branch', 'feat/match', '--path', fx.work], { cwd: fx.work });
    f.ok(['set', 'm', 'state=running', 'agent=a', `sha=${fx.matchSha}`], { cwd: fx.work });
    const line = resumeLine(f.ok(['resume'], { cwd: fx.work }).out, 'm');
    assert.match(line, /push=DIFFERS .*AHEAD \?$/);
  });

  test('origin unreachable and no tracking ref → AHEAD ?; tracking ref present → a number', () => {
    const fx = fixture();
    g(fx.work, 'checkout', '-q', '-f', 'feat/match');
    g(fx.work, 'commit', '-q', '--allow-empty', '-m', 'x');
    g(fx.work, 'remote', 'set-url', 'origin', join(fx.root, 'nonexistent.git'));
    const f = fleet();
    f.ok(['lane', 'm', '--branch', 'feat/match', '--path', fx.work], { cwd: fx.work });
    f.ok(['set', 'm', 'state=running', 'agent=a'], { cwd: fx.work });
    assert.match(resumeLine(f.ok(['resume'], { cwd: fx.work }).out, 'm'), /push=UNKNOWN .*AHEAD 1$/);
    g(fx.work, 'update-ref', '-d', 'refs/remotes/origin/feat/match');
    assert.match(resumeLine(f.ok(['resume'], { cwd: fx.work }).out, 'm'), /push=UNKNOWN .*AHEAD \?$/);
  });
});

describe('A66 path=NOT-A-WORKTREE', () => {
  test('a plain directory inside the primary is not the lane worktree', () => {
    const fx = fixture();
    const plain = join(fx.work, 'plain');
    execFileSync('mkdir', ['-p', plain]);
    const outside = tmp('fleet-plain-');
    const f = fleet();
    f.ok(['lane', 'p', '--branch', 'feat/match', '--path', plain], { cwd: fx.work });
    f.ok(['set', 'p', 'state=running', 'agent=a', `sha=${fx.matchSha}`], { cwd: fx.work });
    f.ok(['lane', 'o', '--path', outside], { cwd: fx.work });
    f.ok(['set', 'o', 'state=running', 'agent=a'], { cwd: fx.work });
    const out = f.ok(['resume'], { cwd: fx.work }).out;
    assert.match(resumeLine(out, 'p'), /path=NOT-A-WORKTREE .* dirty=- .*push=MATCH .*AHEAD \?$/);
    assert.match(resumeLine(out, 'o'), /path=NOT-A-WORKTREE .* dirty=-/);
  });

  test('the worktree root itself is ok (via a symlinked path too)', () => {
    const fx = fixture();
    const link = join(fx.root, 'link');
    execFileSync('ln', ['-s', fx.work, link]);
    const f = fleet();
    f.ok(['lane', 'w', '--path', link], { cwd: fx.work });
    f.ok(['set', 'w', 'state=running', 'agent=a'], { cwd: fx.work });
    assert.match(resumeLine(f.ok(['resume'], { cwd: fx.work }).out, 'w'), /path=ok .* dirty=2/);
  });
});

describe('A67 lane paths are stored absolute', () => {
  test('relative --path and set path= resolve against the primary checkout', () => {
    const fx = fixture();
    const sub = join(fx.work, 'sub');
    execFileSync('mkdir', ['-p', sub]);
    const primary = realpathSync(fx.work);
    const f = fleet();
    f.ok(['lane', 'a', '--path', 'rel/x'], { cwd: sub });
    assert.equal(f.json().lanes[0].path, join(primary, 'rel', 'x'));
    f.ok(['set', 'a', 'path=../y'], { cwd: sub });
    assert.equal(f.json().lanes[0].path, join(dirname(primary), 'y'));
    f.ok(['lane', 'w', '--path', '.'], { cwd: sub });
    f.ok(['set', 'w', 'state=running', 'agent=a'], { cwd: sub });
    // resume from an unrelated cwd still finds it
    const env = { ...process.env, FLEET_DIR: f.dir };
    const r = spawnSync(process.execPath, [FLEET, 'resume'], { cwd: tmp('fleet-elsewhere-'), env, encoding: 'utf8' });
    assert.match(resumeLine(r.stdout, 'w'), new RegExp(`path=ok ${primary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
  });

  test('absolute paths are normalized; outside a repository relative resolves against cwd', () => {
    const f = fleet();
    f.ok(['lane', 'a', '--path', '/x/./y/../z']);
    f.ok(['lane', 'b', '--path', 'rel']);
    const [a, b] = f.json().lanes;
    assert.equal(a.path, '/x/z');
    assert.equal(b.path, join(f.dir, 'rel'));
  });
});

describe('A86 set brief= is accepted and stored absolute', () => {
  test('relative brief resolves against the primary; absolute is normalized; lane --brief unchanged', () => {
    const fx = fixture();
    const sub = join(fx.work, 'sub');
    execFileSync('mkdir', ['-p', sub]);
    const primary = realpathSync(fx.work);
    const f = fleet();
    f.ok(['lane', 'a', '--brief', 'briefs/raw.md'], { cwd: sub });
    assert.equal(f.json().lanes[0].brief, 'briefs/raw.md');
    f.ok(['set', 'a', 'brief=briefs/a.md'], { cwd: sub });
    assert.equal(f.json().lanes[0].brief, join(primary, 'briefs', 'a.md'));
    f.ok(['set', 'a', 'brief=/x/./b.md'], { cwd: sub });
    assert.equal(f.json().lanes[0].brief, '/x/b.md');
    assert.equal(f.run(['set', 'a', 'brief=a', 'brief=b'], { cwd: sub }).code, 64);
  });
});

describe('A68 implicit groups never merge with explicit ones', () => {
  const lanes = [
    { slug: 'api', shape: 'BEST-OF-N', sets: { state: 'merged' } },
    { slug: 'x1', shape: 'BEST-OF-N', group: 'api', sets: { state: 'merged' } },
    { slug: 'x2', shape: 'BEST-OF-N', group: 'api' },
  ];
  const judged = [{ kind: 'judge', lane: 'api', text: '' }, { kind: 'judge', lane: 'x1', text: '' }];

  test('check: no false ERRORs; metrics count two groups', () => {
    const s = stateOf(lanes, judged);
    assert.deepEqual(messages(s), []);
    assert.deepEqual(computeMetrics(s).bestOfN, { groups: 2, judged: 2, winnerNotFirst: 0 });
  });

  test('A31 looks only at explicit groups', () => {
    const s = stateOf([{ slug: 'api', shape: 'ALL' }, { slug: 'y', shape: 'BEST-OF-N', group: 'api' }]);
    assert.deepEqual(messages(s), []);
  });

  test('ready: merging ungrouped api does not retire members of group api', () => {
    const s = stateOf([{ slug: 'api', shape: 'BEST-OF-N', sets: { state: 'merged' } }, { slug: 'x2', shape: 'BEST-OF-N', group: 'api' }]);
    assert.deepEqual(readyLanes(s), ['x2']);
    assert.notEqual(F.groupKey({ slug: 'api' }), F.groupKey({ slug: 'z', group: 'api' }));
  });
});

describe('A69 lock max age, rename-then-inspect, actionable timeout', () => {
  const plantAged = (dir, pid, ageMs) => {
    const lock = join(dir, F.LOCK_NAME ?? 'ledger.lock.d');
    execFileSync('mkdir', ['-p', lock]);
    writeFileSync(join(lock, 'pid'), String(pid));
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(lock, t, t);
    return lock;
  };

  test('a lock older than 60 s is reaped even though its pid (1) is alive', () => {
    const f = fleet();
    plantAged(f.dir, 1, 120000);
    f.ok(['lane', 'a'], { env: { FLEET_LOCK_TIMEOUT_MS: '3000' } });
    assert.deepEqual(readdirSync(f.dir).filter((n) => n.startsWith('ledger.lock')), []);
  });

  test('FLEET_LOCK_MAX_AGE_MS overrides the age', () => {
    const f = fleet();
    plantAged(f.dir, process.pid, 2000);
    f.ok(['lane', 'a'], { env: { FLEET_LOCK_TIMEOUT_MS: '3000', FLEET_LOCK_MAX_AGE_MS: '500' } });
  });

  test('timeout message names the lock path and how to clear it', () => {
    const f = fleet();
    const lock = plantAged(f.dir, process.pid, 0);
    const r = f.run(['lane', 'a'], { env: { FLEET_LOCK_TIMEOUT_MS: '200' } });
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(lock), r.err);
    assert.ok(r.err.includes(`rm -rf '${lock}'`), r.err);
  });

  test('reapStaleLock removes a stale instance and leaves a live one untouched', () => {
    const d1 = tmp();
    plantAged(d1, 1, 120000);
    assert.equal(F.reapStaleLock(d1, {}), true);
    assert.deepEqual(readdirSync(d1), []);
    const d2 = tmp();
    const lock = plantAged(d2, process.pid, 0);
    assert.equal(F.reapStaleLock(d2, {}), false);
    assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.pid));
    assert.deepEqual(readdirSync(d2), [F.LOCK_NAME]);
  });
});

describe('A70 empty env values mean the default', () => {
  test('envInt', () => {
    assert.equal(F.envInt({ X: '' }, 'X', 30000), 30000);
    assert.equal(F.envInt({ X: '  ' }, 'X', 7), 7);
    assert.equal(F.envInt({}, 'X', 7), 7);
    assert.equal(F.envInt({ X: '0' }, 'X', 7), 0);
    assert.equal(F.envInt({ X: '0' }, 'X', 7, 1), 7);
    assert.equal(F.envInt({ X: 'abc' }, 'X', 7), 7);
  });

  test('FLEET_LOCK_TIMEOUT_MS= waits (default), not 0 ms', () => {
    const f = fleet();
    const lock = join(f.dir, 'ledger.lock.d');
    execFileSync('mkdir', ['-p', lock]);
    writeFileSync(join(lock, 'pid'), String(process.pid));
    const releaser = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}, { recursive: true, force: true }), 700)`], { stdio: 'ignore' });
    try {
      const r = f.run(['lane', 'a'], { env: { FLEET_LOCK_TIMEOUT_MS: '' } });
      assert.equal(r.code, 0, r.err);
    } finally {
      releaser.kill();
    }
  });

  test('FLEET_FIX_ROUNDS= and FLEET_GIT_TIMEOUT_MS= use defaults', () => {
    assert.equal(F.fixRoundsThreshold({ FLEET_FIX_ROUNDS: '' }), 3);
    assert.equal(F.gitTimeoutMs({ FLEET_GIT_TIMEOUT_MS: '' }), 15000);
    const f = fleet();
    f.ok(['lane', 'a']);
    f.ok(['set', 'a', 'round=3']);
    assert.match(f.ok(['check'], { env: { FLEET_FIX_ROUNDS: '' } }).out, /escalate/);
  });

  test('FLEET_DIR= falls back to the primary checkout', () => {
    const repo = tmp('fleet-emptydir-');
    execFileSync('git', ['init', '-q', repo]);
    const env = { ...process.env, FLEET_DIR: '' };
    const r = spawnSync(process.execPath, [FLEET, 'init', 'p'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(repo, '.claude', 'state', 'fleet', 'ledger.jsonl')));
  });
});

describe('A71 ready is linear', () => {
  test('a 10,000-lane dependency chain answers in under 5 s', () => {
    const f = fleet();
    const n = 10000;
    const lines = [];
    for (let i = 0; i < n; i++) {
      lines.push(JSON.stringify({ ts: 't', op: 'lane', slug: `l${i}`, role: 'impl', shape: 'ALL', tier: 'T1', deps: i ? [`l${i - 1}`] : [], state: 'planned' }));
    }
    writeFileSync(join(f.dir, 'ledger.jsonl'), `${lines.join('\n')}\n`);
    const t0 = Date.now();
    const r = f.ok(['ready']);
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.equal(r.out, 'l0\n');
  });
});

describe('A72 set with a repeated key → 64', () => {
  for (const pairs of [['state=merged', 'state=planned'], ['round=1', 'round=2'], ['note=a', 'agent=x', 'note=b']]) {
    test(pairs.join(' '), () => {
      const f = fleet();
      f.ok(['lane', 'a']);
      const before = f.ledger();
      assert.equal(f.run(['set', 'a', ...pairs]).code, 64);
      assert.equal(f.ledger(), before);
    });
  }
});

describe('A73 ready drops rivals once their group has merged', () => {
  for (const shape of ['BEST-OF-N', 'FIRST-SUFFICIENT']) {
    test(`${shape}: losing rival not ready after the winner merged`, () => {
      const s = stateOf([
        { slug: 'a1', shape, group: 'g', sets: { state: 'merged' } },
        { slug: 'a2', shape, group: 'g' },
        { slug: 'other' },
      ], [{ kind: 'judge', lane: 'a1', text: '' }]);
      assert.deepEqual(readyLanes(s), ['other']);
    });
    test(`${shape}: rival still ready while no sibling has merged`, () => {
      const s = stateOf([
        { slug: 'a1', shape, group: 'g', sets: { state: 'running' } },
        { slug: 'a2', shape, group: 'g' },
      ]);
      assert.deepEqual(readyLanes(s), ['a2']);
    });
  }
  test('ALL-shape siblings are unaffected', () => {
    const s = stateOf([{ slug: 'a1', group: 'g', sets: { state: 'merged' } }, { slug: 'a2', group: 'g' }]);
    assert.deepEqual(readyLanes(s), ['a2']);
  });
});
