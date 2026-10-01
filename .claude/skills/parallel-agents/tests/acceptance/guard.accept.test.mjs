// Acceptance tests for hooks/agent-guard.mjs (contract v2, section 4).
// Usage: SKILL_ROOT=<dir> node guard.accept.test.mjs
// KEPT = v1 behaviour the contract keeps (expected to pass on v1).
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SKILL_ROOT, addWorktree, eq, git, makeRepo, match, noMatch, ok, runNode, suite, tmp } from './harness.mjs';

const HOOK = join(SKILL_ROOT, 'hooks', 'agent-guard.mjs');
const s = suite('guard');
const test = s.test.bind(s);

let mod = {};
let importError = null;
try {
  mod = await import(pathToFileURL(HOOK).href);
} catch (err) {
  importError = err;
}
function need(name) {
  ok(!importError, `import ${HOOK}: ${importError?.message}`);
  ok(typeof mod[name] === 'function', `export ${name} is a function`);
  return mod[name];
}

// One repo with a linked worktree under .claude/worktrees, shared by the cases.
let fx = null;
function fixture() {
  if (!fx) {
    const repo = makeRepo();
    const wt = addWorktree(repo.primary, 'lane-a');
    const spaced = addWorktree(repo.primary, 'lane with space', { branch: 'spaced' });
    const home = tmp('home-');
    mkdirSync(join(home, '.claude'), { recursive: true });
    fx = { ...repo, wt, spaced, home };
  }
  return fx;
}
const SCHEMA = 'Report:\nSTATUS: done\nGATE TOUCHED: none\n';
function ev(prompt, extra = {}) {
  const f = fixture();
  return { tool_name: extra.tool ?? 'Agent', cwd: f.primary, tool_input: { prompt, ...(extra.input ?? {}) } };
}
function run(prompt, extra) {
  const f = fixture();
  return need('decide')(ev(prompt, extra), { tempDirs: [], projectDir: f.primary, home: f.home });
}
function cli(event, env = {}) {
  const f = fixture();
  return runNode(HOOK, [], {
    cwd: f.primary,
    input: typeof event === 'string' ? event : JSON.stringify(event),
    env: { PARALLEL_AGENTS_TEMP_DIRS: '', CLAUDE_PROJECT_DIR: f.primary, HOME: f.home, ...env },
  });
}
function slotsIn(list) {
  return (list ?? []).map((x) => String(x));
}
function hasName(list, name) {
  return slotsIn(list).some((x) => new RegExp(`(^|\\{\\{)${name}(\\}\\}|:|$)`).test(x));
}

// ── exports ─────────────────────────────────────────────────────────────────
test('exports: v1 functions kept and findPlaceholders added', () => {
  for (const n of ['parseLane', 'decide', 'checkoutRoot', 'isLinkedWorktree', 'primaryRootOf', 'canWrite', 'agentTools', 'findPlaceholders']) need(n);
});

// ── findPlaceholders ────────────────────────────────────────────────────────
test('findPlaceholders: {{NAME}} and {{NAME: description}} slots', () => {
  const f = need('findPlaceholders');
  const got = f('Lane: {{LANE_PATH}}\nBranch: {{BRANCH}}\nGoal: {{GOAL: one checkable sentence}}\nX{{A1_B}}Y {{Z}}');
  ok(Array.isArray(got), 'returns an array');
  for (const n of ['LANE_PATH', 'BRANCH', 'GOAL', 'A1_B', 'Z']) ok(hasName(got, n), `finds ${n} in ${JSON.stringify(got)}`);
  eq(new Set(slotsIn(got).map((x) => x.replace(/^\{\{|\}\}$/g, '').split(':')[0])).size, 5, 'five distinct slots');
});

test('findPlaceholders: no slots in plain text or empty input', () => {
  const f = need('findPlaceholders');
  eq(slotsIn(f('A normal brief with no slots. Lane: /abs/path')), [], 'plain');
  eq(slotsIn(f('')), [], 'empty');
});

const NOT_SLOTS = [
  ['JSX style object', "<div style={{ color: 'red' }}>hi</div>"],
  ['JSX style object, no spaces', "<div style={{color:'red'}}/>"],
  ['Handlebars lower-case', 'Hello {{name}}!'],
  ['Handlebars mixed case', 'Hello {{Name}}!'],
  ['Go template field', 'Hello {{.Name}} and {{ .Values.image }}'],
  ['spaced upper-case', 'cd {{ WT }} && make'],
  ['GitHub Actions expression', 'token: ${{ secrets.GITHUB_TOKEN }}'],
  ['Handlebars block helpers', '{{#each items}}{{this}}{{/each}} {{> partial}}'],
  ['leading digit / underscore', '{{1ST}} {{_PRIVATE}}'],
  ['hyphenated', '{{LANE-PATH}}'],
  ['single braces', 'fmt {NAME} and ${NAME}'],
];
test('findPlaceholders: code and templates that are not fill-in slots', () => {
  const f = need('findPlaceholders');
  const bad = [];
  for (const [what, text] of NOT_SLOTS) {
    const got = slotsIn(f(text));
    if (got.length) bad.push(`${what} → ${JSON.stringify(got)}`);
  }
  eq(bad, [], 'false positives');
});

// ── deny on placeholders ────────────────────────────────────────────────────
test('placeholders deny a writing launch with a valid lane, naming the slots', () => {
  const f = fixture();
  const v = run(`Lane: ${f.wt}\nFix {{THING_ONE}} in {{FILE: the file}}.\n${SCHEMA}`);
  eq(v.action, 'deny', 'action');
  match(v.reason, /THING_ONE/, 'reason names THING_ONE');
  match(v.reason, /FILE/, 'reason names FILE');
});

test('placeholders deny read-only, Explore, isolation and Task launches too', () => {
  const cases = [
    ['Lane: read-only', `Lane: read-only\nLook at {{TOPIC}}.`, {}],
    ['Explore (cannot write)', 'Find {{TOPIC}} in the repo.', { input: { subagent_type: 'Explore' } }],
    ['isolation: worktree', `Do {{TOPIC}}.\n${SCHEMA}`, { input: { isolation: 'worktree' } }],
    ['Task tool', `Lane: read-only\nLook at {{TOPIC}}.`, { tool: 'Task' }],
    ['Lane: none', `Lane: none — runs the merge loop from the primary\nMerge {{TOPIC}}.`, {}],
  ];
  const wrong = [];
  for (const [what, prompt, extra] of cases) {
    const v = run(prompt, extra);
    if (v.action !== 'deny' || !/TOPIC/.test(v.reason ?? '')) wrong.push(`${what}: ${v.action}`);
  }
  eq(wrong, [], 'launches not denied for {{TOPIC}}');
});

test('A1\u2032 deny lists at most 5 distinct slot NAMEs without braces, plus (and N more)', () => {
  const f = fixture();
  const names = ['SLOT_AA', 'SLOT_BB', 'SLOT_CC', 'SLOT_DD', 'SLOT_EE', 'SLOT_FF', 'SLOT_GG'];
  const v = run(`Lane: ${f.wt}\n${names.map((n) => `{{${n}}}`).join(' ')} {{SLOT_AA}} {{SLOT_AA: again}}\n${SCHEMA}`);
  eq(v.action, 'deny', 'action');
  const listed = names.filter((n) => (v.reason ?? '').includes(n));
  eq(listed.length, 5, `slots listed in: ${v.reason}`);
  match(v.reason, /\(and 2 more\)/, 'the remainder is counted');
  noMatch(v.reason, /\{\{SLOT_/, 'slot names are listed without braces');
  eq(names.slice(0, 5).every((n) => v.reason.includes(n)), true, 'the first five in order of appearance are the ones listed');
  const v2 = run(`Lane: ${f.wt}\n{{SLOT_AA}} {{SLOT_AA}} {{SLOT_BB}}\n${SCHEMA}`);
  eq(((v2.reason ?? '').match(/SLOT_AA/g) ?? []).length, 1, 'a repeated slot is listed once');
});

test('real code in a brief does not deny (JSX, Handlebars, Go, spaced)', () => {
  const f = fixture();
  const code = NOT_SLOTS.map(([, t]) => t).join('\n');
  const v = run(`Lane: ${f.wt}\nOwn src/ui.\n\`\`\`\n${code}\n\`\`\`\n${SCHEMA}`);
  eq(v.action, 'allow', `action (reason: ${v.reason})`);
});

test('CLI: placeholder → exit 2 with the slot on stderr', () => {
  const f = fixture();
  const r = cli(ev(`Lane: ${f.wt}\nFix {{MISSING_BIT}}.\n${SCHEMA}`));
  eq(r.code, 2, 'exit');
  match(r.err, /MISSING_BIT/, 'stderr names the slot');
});

test('launch with no prompt and isolation does not crash (allow)', () => {
  const f = fixture();
  const v = need('decide')({ tool_name: 'Agent', cwd: f.primary, tool_input: { isolation: 'worktree' } }, { tempDirs: [], projectDir: f.primary, home: f.home });
  eq(v.action, 'allow', 'action');
});

// ── parseLane ───────────────────────────────────────────────────────────────
test('parseLane: trailing parenthetical is not part of the path', () => {
  const p = need('parseLane');
  eq(p('Lane: /abs/wt   (detached at abc123)'), { kind: 'path', path: '/abs/wt' }, 'spaces + parenthetical');
  eq(p('Lane: /abs/wt (branch feat/x)'), { kind: 'path', path: '/abs/wt' }, 'one space');
  eq(p('Lane: `/abs/wt` (detached at abc123)'), { kind: 'path', path: '/abs/wt' }, 'backticks + parenthetical');
  eq(p('**Lane:** `/abs/wt`   (review)'), { kind: 'path', path: '/abs/wt' }, 'bold label + backticks + parenthetical');
});

test('parseLane: spaces and non-trailing parentheses stay in the path', () => {
  const p = need('parseLane');
  eq(p('Lane: /abs/my wt'), { kind: 'path', path: '/abs/my wt' }, 'space in path');
  eq(p('Lane: /abs/my wt (detached at abc)'), { kind: 'path', path: '/abs/my wt' }, 'space in path + parenthetical');
  eq(p('Lane: /abs/dir (copy)/wt'), { kind: 'path', path: '/abs/dir (copy)/wt' }, 'parentheses mid-path');
  eq(p('Lane: /abs/dir (copy)/wt (detached at abc)'), { kind: 'path', path: '/abs/dir (copy)/wt' }, 'mid-path parens + trailing parenthetical');
  eq(p('Lane: /abs/a(b)/c'), { kind: 'path', path: '/abs/a(b)/c' }, 'parens without spaces');
});

test('KEPT parseLane: backticks stripped, read-only, none', () => {
  const p = need('parseLane');
  eq(p('Lane: `/abs/wt`'), { kind: 'path', path: '/abs/wt' }, 'backticks');
  eq(p('Lane: read-only'), { kind: 'read-only' }, 'read-only');
  eq(p('Lane: none — orchestrator merge loop'), { kind: 'none', reason: 'orchestrator merge loop' }, 'none');
  eq(p('no lane here'), null, 'absent');
});

test('decide: lane path with a trailing parenthetical (and one with a space) is allowed', () => {
  const f = fixture();
  let v = run(`Lane: \`${f.wt}\`   (detached at abc123)\n${SCHEMA}`);
  eq(v.action, 'allow', `parenthetical (reason: ${v.reason})`);
  v = run(`Lane: ${f.spaced} (branch spaced)\n${SCHEMA}`);
  eq(v.action, 'allow', `path with a space + parenthetical (reason: ${v.reason})`);
});

// ── report schema warning ───────────────────────────────────────────────────
test('schema warning: path lane without GATE TOUCHED/FINDINGS: gets one extra context line, never a deny', () => {
  const f = fixture();
  const without = run(`Lane: ${f.wt}\nOwn src/a.`);
  const withGate = run(`Lane: ${f.wt}\nOwn src/a.\nGATE TOUCHED: none`);
  const withFindings = run(`Lane: ${f.wt}\nOwn src/a.\nFINDINGS:\n- none`);
  eq([without.action, withGate.action, withFindings.action], ['allow', 'allow', 'allow'], 'actions');
  const n = (v) => (v.context ?? '').split('\n').length;
  eq(n(without), n(withGate) + 1, `one extra line without a schema (without: ${JSON.stringify(without.context)})`);
  eq(n(withGate), n(withFindings), 'FINDINGS: suppresses it like GATE TOUCHED');
  const extra = (without.context ?? '').split('\n').filter((l) => !(withGate.context ?? '').split('\n').includes(l));
  ok(extra.some((l) => l.includes('references/briefs.md') && /schema/i.test(l)), `extra line points at references/briefs.md: ${JSON.stringify(extra)}`);
});

test('schema warning: not added for read-only, none, or isolation launches', () => {
  const pairs = [
    ['read-only', 'Lane: read-only\nLook.', {}],
    ['none', 'Lane: none — runs the merge loop from the primary\nMerge.', {}],
    ['isolation', 'Do it.', { input: { isolation: 'worktree' } }],
  ];
  const wrong = [];
  for (const [what, p, extra] of pairs) {
    const a = run(p, extra);
    const b = run(`${p}\nGATE TOUCHED: none`, extra);
    if (a.action !== 'allow' || a.context !== b.context) wrong.push(what);
  }
  eq(wrong, [], 'launch kinds whose context changes with a report schema');
});

test('context texts point at references/briefs.md', () => {
  const f = fixture();
  const wrong = [];
  for (const [what, p, extra] of [
    ['path lane', `Lane: ${f.wt}\n${SCHEMA}`, {}],
    ['read-only', 'Lane: read-only\nLook.', {}],
    ['isolation', 'Do it.', { input: { isolation: 'worktree' } }],
  ]) {
    const v = run(p, extra);
    if (!(v.context ?? '').includes('references/briefs.md')) wrong.push(what);
  }
  eq(wrong, [], 'contexts without references/briefs.md');
});

// ── kept behaviour ──────────────────────────────────────────────────────────
test('KEPT: writer with no lane → deny; Explore with no lane → allow', () => {
  eq(run('Do the thing.').action, 'deny', 'general-purpose without a lane');
  eq(run('Find the thing.', { input: { subagent_type: 'Explore' } }).action, 'allow', 'Explore');
});

test('KEPT: primary checkout / relative / missing lane path → deny', () => {
  const f = fixture();
  eq(run(`Lane: ${f.primary}\n${SCHEMA}`).action, 'deny', 'primary');
  eq(run(`Lane: relative/wt\n${SCHEMA}`).action, 'deny', 'relative');
  eq(run(`Lane: ${f.primary}/.claude/worktrees/nope\n${SCHEMA}`).action, 'deny', 'missing');
});

test('KEPT CLI: exit 2 on deny, 0 with JSON context on allow, guard off, fail-open on bad JSON', () => {
  const f = fixture();
  let r = cli(ev('Do the thing.'));
  eq(r.code, 2, 'deny exit');
  r = cli(ev(`Lane: ${f.wt}\n${SCHEMA}`));
  eq(r.code, 0, `allow exit (${r.err})`);
  let parsed;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    parsed = null;
  }
  ok(parsed?.hookSpecificOutput?.additionalContext, `additionalContext JSON on stdout: ${r.out.slice(0, 200)}`);
  r = cli(ev('Do the thing {{X}}.'), { PARALLEL_AGENTS_GUARD: 'off' });
  eq(r.code, 0, 'guard off');
  r = cli('not json');
  eq(r.code, 0, 'fail open');
});

// ── round-2 amendments (A35–A43) ────────────────────────────────────────────
test('A35 hook runs when invoked through a symlinked file or directory', () => {
  const f = fixture();
  const d = tmp('link-');
  symlinkSync(HOOK, join(d, 'guard-link.mjs'));
  symlinkSync(join(SKILL_ROOT, 'hooks'), join(d, 'hooks-link'));
  const deny = JSON.stringify(ev('Do the thing.'));
  const allow = JSON.stringify(ev(`Lane: ${f.wt}\n${SCHEMA}`));
  for (const script of [join(d, 'guard-link.mjs'), join(d, 'hooks-link', 'agent-guard.mjs')]) {
    let r = runNode(script, [], { cwd: f.primary, input: deny, env: { PARALLEL_AGENTS_TEMP_DIRS: '', CLAUDE_PROJECT_DIR: f.primary, HOME: f.home } });
    eq(r.code, 2, `deny via ${script}`);
    r = runNode(script, [], { cwd: f.primary, input: allow, env: { PARALLEL_AGENTS_TEMP_DIRS: '', CLAUDE_PROJECT_DIR: f.primary, HOME: f.home } });
    eq(r.code, 0, `allow via ${script}`);
    match(r.out, /additionalContext/, `allow context via ${script}`);
  }
});

test('A36 slot deny says how to keep a literal ({{ NAME }}); none of the hook\'s texts contain a slot (A1\u2032: names listed bare)', () => {
  const f = fixture();
  const fp = need('findPlaceholders');
  const slot = run(`Lane: ${f.wt}\nFix {{SLOT_ONE}}.\n${SCHEMA}`);
  eq(slot.action, 'deny', 'slot deny');
  match(slot.reason, /\{\{ [A-Z][A-Z0-9_]* \}\}/, 'deny shows the spaced {{ NAME }} form for literals');
  const texts = [
    ['slot deny', slot.reason, []],
    ['no-lane deny', run('Do the thing.').reason, []],
    ['bad path deny', run(`Lane: relative/x\n${SCHEMA}`).reason, []],
    ['short none deny', run('Lane: none — x').reason, []],
    ['path context', run(`Lane: ${f.wt}\nOwn src.`).context, []],
    ['read-only context', run('Lane: read-only\nLook.').context, []],
    ['isolation context', run('Do it.', { input: { isolation: 'worktree' } }).context, []],
    ['workflow context', run('x', { tool: 'Workflow' }).context, []],
  ];
  const bad = [];
  for (const [what, text, allowed] of texts) {
    const found = (fp(text ?? '') ?? []).map(String).filter((x) => !allowed.some((a) => x.includes(a)));
    if (found.length) bad.push(`${what}: ${JSON.stringify(found)}`);
  }
  eq(bad, [], 'hook texts that findPlaceholders matches');
});

test('A37 a declared lane is validated even with isolation: "worktree"', () => {
  const f = fixture();
  const iso = { input: { isolation: 'worktree' } };
  const wrong = [];
  for (const [what, lane] of [['primary', f.primary], ['missing', `${f.primary}/.claude/worktrees/nope`], ['relative', 'rel/wt']]) {
    const v = run(`Lane: ${lane}\n${SCHEMA}`, iso);
    if (v.action !== 'deny') wrong.push(what);
  }
  const t = need('decide')(ev(`Lane: ${f.wt}\n${SCHEMA}`, iso), { tempDirs: [f.root], projectDir: f.primary, home: f.home });
  if (t.action !== 'deny') wrong.push('temp');
  eq(wrong, [], 'isolation launches with an invalid lane not denied');
  eq(run(`Lane: ${f.wt}\n${SCHEMA}`, iso).action, 'allow', 'valid lane + isolation');
});

test('A38 a git submodule is not a lane', () => {
  const f = fixture();
  const sub = tmp('subrepo-');
  git(sub, 'init', '-q', '-b', 'main');
  git(sub, 'commit', '-q', '--allow-empty', '-m', 'sub');
  const repo = makeRepo();
  git(repo.primary, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  const v = need('decide')(ev(`Lane: ${join(repo.primary, 'vendor', 'sub')}\n${SCHEMA}`), { tempDirs: [], projectDir: repo.primary, home: f.home });
  eq(v.action, 'deny', `submodule as lane (context: ${v.context})`);
});

test('A39 Lane lines in fences and blockquotes are ignored', () => {
  const f = fixture();
  const cases = [
    ['``` fence only', 'Example:\n```\nLane: read-only\n```\nDo it.', 'deny'],
    ['~~~ fence only', 'Example:\n~~~md\nLane: read-only\n~~~\nDo it.', 'deny'],
    ['blockquote only', '> Lane: read-only\nDo it.', 'deny'],
    ['real lane + fenced other lane', `Lane: ${f.wt}\n\`\`\`\nLane: /somewhere/else\n\`\`\`\n${SCHEMA}`, 'allow'],
    ['real lane + quoted other lane', `Lane: ${f.wt}\n> Lane: read-only\n${SCHEMA}`, 'allow'],
    ['same lane twice', `Lane: ${f.wt}\nsteps…\nLane: ${f.wt}\n${SCHEMA}`, 'allow'],
  ];
  const wrong = [];
  for (const [what, p, want] of cases) {
    const v = run(p);
    if (v.action !== want) wrong.push(`${what}: ${v.action}`);
  }
  eq(wrong, [], 'wrong verdicts');
  eq(need('parseLane')('```\nLane: /x\n```'), null, 'parseLane ignores a fenced Lane line');
});

test('A39 two disagreeing Lane lines → deny naming both', () => {
  const f = fixture();
  const v = run(`Lane: ${f.wt}\n…\nLane: read-only\n${SCHEMA}`);
  eq(v.action, 'deny', 'action');
  ok((v.reason ?? '').includes(f.wt) && /read-only/.test(v.reason ?? ''), `reason names both: ${v.reason}`);
});

test('A40 temp-dir check compares realpaths on both sides', () => {
  const f = fixture();
  const links = tmp('links-');
  symlinkSync(f.root, join(links, 'fxlink'));
  const viaLink = join(links, 'fxlink', f.wt.slice(f.root.length + 1));
  const d = need('decide');
  let v = d(ev(`Lane: ${f.wt}\n${SCHEMA}`), { tempDirs: [join(links, 'fxlink')], projectDir: f.primary, home: f.home });
  eq(v.action, 'deny', 'temp dir given through a symlink');
  v = d(ev(`Lane: ${viaLink}\n${SCHEMA}`), { tempDirs: [f.root], projectDir: f.primary, home: f.home });
  eq(v.action, 'deny', 'lane path given through a symlink');
});

test('A41 tools: as a YAML block list is parsed', () => {
  const f = fixture();
  const dir = join(f.primary, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'blockwriter.md'), '---\nname: blockwriter\ndescription: x\ntools:\n  - Read\n  - Edit\n---\nbody\n');
  writeFileSync(join(dir, 'blockreader.md'), '---\nname: blockreader\ntools:\n  - Read\n  - Grep\n---\nbody\n');
  eq(need('canWrite')('blockwriter', f.primary, f.home), true, 'block list with Edit → writer');
  eq(run('Do it.', { input: { subagent_type: 'blockwriter' } }).action, 'deny', 'writer without a lane denied');
  eq(need('canWrite')('blockreader', f.primary, f.home), false, 'block list without a writing tool → not a writer');
});

test('A42 parseLane/findPlaceholders are linear: 200,000-char adversarial lines < 1000 ms (contract: 100 ms)', () => {
  const d = tmp('timing-');
  const script = join(d, 'time.mjs');
  writeFileSync(script, `
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(${JSON.stringify(HOOK)}).href);
const N = 200000;
const inputs = {
  'Lane + whitespace run + x': 'Lane: /a' + ' '.repeat(N) + 'x',
  'Lane + trailing whitespace': 'Lane: /a' + ' '.repeat(N),
  'Lane + whitespace + (': 'Lane: /a' + ' '.repeat(N) + '(',
  'Lane + many (': 'Lane: /a ' + '('.repeat(N),
  'line of *': '*'.repeat(N),
  'line of * then Lane': '*'.repeat(N) + 'Lane',
  'line of _': '_'.repeat(N),
  'Lane + * run': 'Lane: ' + '*'.repeat(N) + 'x',
  '{{ run': '{{'.repeat(N / 2),
  '{{A run': '{{A'.repeat(N / 3),
  '{{A: + spaces': '{{A:' + ' '.repeat(N),
};
const fns = ['parseLane', 'findPlaceholders'].filter((f) => typeof m[f] === 'function');
console.log('FNS ' + fns.length);
for (const f of fns) m[f]('Lane: /warm {{UP}}');
for (const [k, v] of Object.entries(inputs)) for (const f of fns) {
  console.log('START ' + f + ' / ' + k);
  const t0 = performance.now();
  try { m[f](v); } catch {}
  console.log('MS ' + Math.round(performance.now() - t0) + ' ' + f + ' / ' + k);
}
console.log('DONE');
`);
  const r = runNode(script, [], { cwd: d, timeout: 30000 });
  const out = r.out.split('\n');
  const started = out.filter((l) => l.startsWith('START ')).map((l) => l.slice(6));
  const timed = out.filter((l) => l.startsWith('MS ')).map((l) => l.slice(3));
  const hung = started.slice(timed.length);
  eq(hung, [], `inputs still running when killed after 30 s (${r.signal ?? 'no signal'})`);
  ok(out.includes('FNS 2'), `both functions exported (${r.err.slice(0, 200)})`);
  const slow = timed.filter((l) => Number(l.split(' ')[0]) >= 1000);
  eq(slow, [], 'inputs taking ≥ 1000 ms');
});

test('A43 headings, numbered items, NBSP parenthetical, balanced emphasis only', () => {
  const p = need('parseLane');
  const cases = [
    ['## Lane: /abs/wt', { kind: 'path', path: '/abs/wt' }],
    ['1. Lane: /abs/wt', { kind: 'path', path: '/abs/wt' }],
    ['### **Lane:** read-only', { kind: 'read-only' }],
    ['Lane: /abs/wt (detached at abc123)', { kind: 'path', path: '/abs/wt' }],
    ['Lane: /abs/wt\t(detached at abc123)', { kind: 'path', path: '/abs/wt' }],
    ['Lane: /abs/my_wt_', { kind: 'path', path: '/abs/my_wt_' }],
    ['Lane: /abs/wt_', { kind: 'path', path: '/abs/wt_' }],
    ['Lane: /abs/wt*', { kind: 'path', path: '/abs/wt*' }],
    ['Lane: _/abs/wt_', { kind: 'path', path: '/abs/wt' }],
    ['Lane: **/abs/wt**', { kind: 'path', path: '/abs/wt' }],
  ];
  const wrong = [];
  for (const [line, want] of cases) {
    const got = p(line);
    if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${JSON.stringify(line)} → ${JSON.stringify(got)}`);
  }
  eq(wrong, [], 'parseLane results');
  const f = fixture();
  eq(run(`## Lane: ${f.wt}\n${SCHEMA}`).action, 'allow', 'heading lane accepted by decide');
});

// ── round-5 amendments (A74–A83) ────────────────────────────────────────────
function agentDef(name, toolsBlock) {
  const f = fixture();
  const dir = join(f.primary, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: x\n${toolsBlock}\n---\nbody\n`);
  return need('canWrite')(name, f.primary, f.home);
}

test('A74 tools: * in any quoting makes a writer', () => {
  const wrong = [];
  for (const [n, t] of [['star-bare', 'tools: *'], ['star-dq', 'tools: "*"'], ['star-sq', "tools: '*'"]]) {
    if (agentDef(n, t) !== true) wrong.push(t);
  }
  eq(wrong, [], 'tools: values not treated as writers');
  eq(run('Do it.', { input: { subagent_type: 'star-dq' } }).action, 'deny', 'tools: "*" agent without a lane is denied');
});

test('A75 unparseable tools: fails closed; single-line flow lists parse', () => {
  const wrong = [];
  for (const [n, t] of [
    ['blk-lit', 'tools: |\n  Read\n  Grep'],
    ['blk-fold', 'tools: >\n  Read Grep'],
    ['blk-lit-strip', 'tools: |-\n  Read'],
    ['blk-fold-strip', 'tools: >-\n  Read'],
    ['flow-multiline', 'tools: [Read,\n  Grep]'],
    ['flow-unclosed', 'tools: [Read, Grep'],
  ]) {
    if (agentDef(n, t) !== true) wrong.push(JSON.stringify(t));
  }
  eq(wrong, [], 'unparseable tools: values not treated as writers');
  eq(agentDef('flow-ro', 'tools: [Read, Grep]'), false, 'single-line flow list without a writing tool');
  eq(agentDef('flow-rw', 'tools: [Read, Bash]'), true, 'single-line flow list with Bash');
});

// Every message the hook produces in these fixtures.
function allMessages() {
  const f = fixture();
  const d = need('decide');
  const other = otherRepo();
  const sub = submoduleRepo();
  const msgs = [];
  const add = (what, v) => {
    for (const t of [v.reason, v.context]) if (t) msgs.push([what, t]);
  };
  add('no lane', run('Do the thing.'));
  add('none without reason', run('Lane: none — x'));
  add('none with reason', run('Lane: none — runs the merge loop from the primary'));
  add('read-only', run('Lane: read-only\nLook.'));
  add('relative', run(`Lane: rel/wt\n${SCHEMA}`));
  add('missing', run(`Lane: ${f.primary}/.claude/worktrees/nope\n${SCHEMA}`));
  add('primary', run(`Lane: ${f.primary}\n${SCHEMA}`));
  add('temp', d(ev(`Lane: ${f.wt}\n${SCHEMA}`), { tempDirs: [f.root], projectDir: f.primary, home: f.home }));
  add('submodule', d(ev(`Lane: ${sub.path}\n${SCHEMA}`), { tempDirs: [], projectDir: sub.primary, home: f.home }));
  add('slots', run(`Lane: ${f.wt}\nFix {{AA}} {{BB}} {{CC}} {{DD}} {{EE}} {{FF}} {{GG}}.\n${SCHEMA}`));
  add('disagreement', run(`Lane: ${f.wt}\nLane: read-only\n${SCHEMA}`));
  add('path lane, schema warning', run(`Lane: ${f.wt}\nOwn src.`));
  add('path lane', run(`Lane: ${f.wt}\n${SCHEMA}`));
  add('outside canonical', run(`Lane: ${outsideLane()}\n${SCHEMA}`));
  add('other repository', run(`Lane: ${other.wt}\n${SCHEMA}`));
  add('isolation', run('Do it.', { input: { isolation: 'worktree' } }));
  add('workflow', run('x', { tool: 'Workflow' }));
  return msgs;
}
let otherFx = null;
function otherRepo() {
  if (!otherFx) {
    const r = makeRepo();
    otherFx = { ...r, wt: addWorktree(r.primary, 'foreign-lane') };
  }
  return otherFx;
}
let subFx = null;
function submoduleRepo() {
  if (!subFx) {
    const sub = tmp('subrepo-');
    git(sub, 'init', '-q', '-b', 'main');
    git(sub, 'commit', '-q', '--allow-empty', '-m', 'sub');
    const r = makeRepo();
    git(r.primary, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
    subFx = { ...r, path: join(r.primary, 'vendor', 'sub') };
  }
  return subFx;
}
let outsideFx = null;
function outsideLane() {
  if (!outsideFx) {
    const f = fixture();
    outsideFx = join(tmp('outside-'), 'wt');
    git(f.primary, 'worktree', 'add', '-q', '-b', 'outside-branch', outsideFx, 'origin/main');
  }
  return outsideFx;
}

test('A76 no hook message re-read as a declaration or slot: decide("Lane: <wt>\\n" + R + schema) allows', () => {
  const f = fixture();
  const bad = [];
  const msgs = allMessages();
  ok(msgs.length >= 15, `fixture: collected ${msgs.length} messages`);
  for (const [what, r] of msgs) {
    const v = run(`Lane: ${f.wt}\n${r}\n${SCHEMA}`);
    if (v.action !== 'allow') bad.push(`${what}: ${(v.reason ?? '').split('\n')[0]}`);
  }
  eq(bad, [], 'messages that change the verdict when pasted into a brief');
});

test('A77 worktrees of bare, .bare+.git-file and --separate-git-dir repos are lanes; submodule denied saying so', () => {
  const f = fixture();
  const d = need('decide');
  const root = tmp('a77-');
  const src = makeRepo();
  // bare repository with a worktree
  const bare = join(root, 'b.git');
  git(root, 'clone', '-q', '--bare', src.origin, bare);
  const bwt = join(root, 'bare-wt');
  git(bare, 'worktree', 'add', '-q', '-b', 'bw', bwt, 'main');
  // .bare + .git-file layout
  const proj = join(root, 'proj');
  mkdirSync(proj);
  git(root, 'clone', '-q', '--bare', src.origin, join(proj, '.bare'));
  writeFileSync(join(proj, '.git'), 'gitdir: ./.bare\n');
  const pwt = join(proj, 'feature');
  git(proj, 'worktree', 'add', '-q', '-b', 'pw', pwt, 'main');
  // --separate-git-dir repository and its linked worktree
  const sepMain = join(root, 'sep-main');
  git(root, 'init', '-q', '-b', 'main', '--separate-git-dir', join(root, 'sep.git'), sepMain);
  git(sepMain, 'commit', '-q', '--allow-empty', '-m', 'x');
  const swt = join(root, 'sep-wt');
  git(sepMain, 'worktree', 'add', '-q', '-b', 'sw', swt);
  const verdict = (p, projectDir) => d(ev(`Lane: ${p}\n${SCHEMA}`), { tempDirs: [], projectDir, home: f.home });
  const wrong = [];
  for (const [what, p, pd] of [['bare repo worktree', bwt, bare], ['.bare layout worktree', pwt, proj], ['separate-git-dir worktree', swt, sepMain]]) {
    const v = verdict(p, pd);
    if (v.action !== 'allow') wrong.push(`${what}: ${(v.reason ?? '').split('\n')[0]}`);
  }
  eq(wrong, [], 'valid lanes denied');
  eq(verdict(sepMain, sepMain).action, 'deny', 'the separate-git-dir main checkout is not a linked worktree');
  const sub = submoduleRepo();
  const v = d(ev(`Lane: ${sub.path}\n${SCHEMA}`), { tempDirs: [], projectDir: sub.primary, home: f.home });
  eq(v.action, 'deny', 'submodule');
  match(v.reason, /submodule/i, 'deny says submodule');
});

test('A78 Lane lines naming the same checkout agree (slash, ./, .., symlink, subdir)', () => {
  const f = fixture();
  const links = tmp('a78-');
  symlinkSync(f.wt, join(links, 'wt-link'));
  mkdirSync(join(f.wt, 'src'), { recursive: true });
  const same = [`${f.wt}/`, `${f.primary}/.claude/worktrees/./lane-a`, `${f.wt}/../lane-a`, join(links, 'wt-link'), join(f.wt, 'src')];
  const wrong = [];
  for (const other of same) {
    const v = run(`Lane: ${f.wt}\nsteps\nLane: ${other}\n${SCHEMA}`);
    if (v.action !== 'allow') wrong.push(`${other}: ${(v.reason ?? '').split('\n')[0]}`);
  }
  eq(wrong, [], 'spellings of the same checkout judged as disagreeing');
  eq(run(`Lane: ${f.wt}\nLane: ${f.spaced}\n${SCHEMA}`).action, 'deny', 'two different checkouts still disagree');
});

test('A79 linear: 200 KB distinct slots < 100 ms or linear scaling to 400 KB; 200 KB wrapper/parenthetical Lane lines < 1000 ms', () => {
  const d = tmp('timing5-');
  const script = join(d, 'time.mjs');
  writeFileSync(script, `
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(${JSON.stringify(HOOK)}).href);
const N = 200000;
let slots = ''; for (let i = 0; slots.length < N; i++) slots += '{{S' + i + '}} ';
let slots2x = ''; for (let i = 0; slots2x.length < 2 * N; i++) slots2x += '{{S' + i + '}} ';
const inputs = {
  'distinct slots': slots,
  'distinct slots x2': slots2x,
  'distinct slots with descriptions': slots.replace(/\\}\\}/g, ': d}}'),
  'Lane + ** run': 'Lane: ' + '**'.repeat(N / 2) + '/wt',
  'Lane + backtick/underscore/star mix': 'Lane: ' + '\`_*'.repeat(N / 3) + '/wt',
  'Lane + wrappers around path': 'Lane: ' + '*_\`'.repeat(N / 6) + '/wt' + '\`_*'.repeat(N / 6),
  'Lane + repeated parentheticals': 'Lane: /wt' + ' (x)'.repeat(N / 4),
  'Lane + nested parens': 'Lane: /wt ' + '('.repeat(N / 2) + ')'.repeat(N / 2),
  'Lane + repeated em-dash commentary': 'Lane: /wt' + ' — c'.repeat(N / 4),
  'heading hashes': '#'.repeat(N) + ' Lane: /wt',
};
const fns = ['parseLane', 'findPlaceholders'].filter((f) => typeof m[f] === 'function');
console.log('FNS ' + fns.length);
for (const f of fns) m[f]('Lane: /warm {{UP}}');
for (const [k, v] of Object.entries(inputs)) for (const f of fns) {
  console.log('START ' + f + ' / ' + k);
  const t0 = performance.now();
  try { m[f](v); } catch {}
  console.log('MS ' + Math.round(performance.now() - t0) + ' ' + f + ' / ' + k);
}
console.log('DONE');
`);
  const r = runNode(script, [], { cwd: d, timeout: 30000 });
  const out = r.out.split('\n');
  const started = out.filter((l) => l.startsWith('START ')).map((l) => l.slice(6));
  const timed = out.filter((l) => l.startsWith('MS ')).map((l) => l.slice(3));
  eq(started.slice(timed.length), [], `inputs still running when killed after 30 s (${r.signal ?? 'no signal'})`);
  ok(out.includes('FNS 2'), `both functions exported (${r.err.slice(0, 200)})`);
  const ms = (name) => Number((timed.find((l) => l.endsWith(`findPlaceholders / ${name}`)) ?? 'NaN').split(' ')[0]);
  const t1 = ms('distinct slots');
  const t2 = ms('distinct slots x2');
  ok(t1 < 100 || (t1 < 1000 && t2 / Math.max(t1, 1) < 2.5), `findPlaceholders on distinct slots: ${t1} ms for 200 KB, ${t2} ms for 400 KB (ratio ${(t2 / Math.max(t1, 1)).toFixed(2)})`);
  eq(timed.filter((l) => !l.includes('distinct slots x2') && Number(l.split(' ')[0]) >= 1000), [], 'inputs taking ≥ 1000 ms');
});

test('A80 inline triple-backtick code on one line does not open a fence', () => {
  const f = fixture();
  const p = '``` npm test ```\n';
  eq(run(`${p}Lane: ${f.wt}\n${SCHEMA}`).action, 'allow', 'lane after an inline ``` line is still read');
  eq(need('parseLane')(`${p}Lane: /abs/wt`), { kind: 'path', path: '/abs/wt' }, 'parseLane');
  eq(run(`${p}Do it.`).action, 'deny', 'control: writer with no lane still denied');
});

test('A81 a .git file pointing at a missing gitdir is denied', () => {
  const f = fixture();
  const fake = join(f.primary, '.claude', 'worktrees', 'hand-made');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, '.git'), `gitdir: ${join(f.primary, '.git', 'worktrees', 'hand-made')}\n`);
  const v = run(`Lane: ${fake}\n${SCHEMA}`);
  eq(v.action, 'deny', `stale .git file (context: ${v.context})`);
});

test('A82 a worktree of a different repository gets an extra context line (allow)', () => {
  const f = fixture();
  const other = otherRepo();
  const mine = run(`Lane: ${f.wt}\n${SCHEMA}`);
  const theirs = run(`Lane: ${other.wt}\n${SCHEMA}`);
  eq(theirs.action, 'allow', `different repository is allowed (${theirs.reason})`);
  const n = (v) => (v.context ?? '').split('\n').length;
  eq(n(theirs), n(mine) + 1, `one extra line (context: ${JSON.stringify(theirs.context)})`);
  match(theirs.context, /differ|another|other|not the project/i, 'says the repository differs');
});

test('A83 spellings parse to the intended kind', () => {
  const p = need('parseLane');
  const cases = [
    ['**Lane: /wt**', { kind: 'path', path: '/wt' }],
    ['_Lane: /wt_', { kind: 'path', path: '/wt' }],
    ['## Lane: /wt ##', { kind: 'path', path: '/wt' }],
    ['Lane: /wt.', { kind: 'path', path: '/wt' }],
    ['Lane: `read-only` (reviews)', { kind: 'read-only' }],
    ['Lane: **read-only** — no edits', { kind: 'read-only' }],
    ['Lane: /wt — the feature lane', { kind: 'path', path: '/wt' }],
    ['Lane: /wt -- the feature lane', { kind: 'path', path: '/wt' }],
  ];
  const wrong = [];
  for (const [line, want] of cases) {
    const got = p(line);
    if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${JSON.stringify(line)} → ${JSON.stringify(got)}`);
  }
  const none = p('Lane: `none` — reviewer only');
  if (none?.kind !== 'none' || !/reviewer only/.test(none?.reason ?? '')) wrong.push(`"Lane: \`none\` — reviewer only" → ${JSON.stringify(none)}`);
  eq(wrong, [], 'parseLane results');
});

await s.run();
