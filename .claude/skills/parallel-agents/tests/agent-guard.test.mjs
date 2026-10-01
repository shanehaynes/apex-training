// Tests for hooks/agent-guard.mjs — `node --test tests/agent-guard.test.mjs`.
// Table-driven: one row per deny form and one per allowed neighbour. Fixture
// git repos and linked worktrees live in an mkdtemp dir removed at the end;
// `tempDirs: []` (or PARALLEL_AGENTS_TEMP_DIRS='' for the CLI) lets them count
// as real lanes, and the temp-dir row passes the fixture dir back in.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as guard from '../hooks/agent-guard.mjs';
import {
  BRIEFS_PATH,
  agentTools,
  canWrite,
  checkoutRoot,
  decide,
  findPlaceholders,
  isLinkedWorktree,
  parseLane,
  primaryRootOf,
} from '../hooks/agent-guard.mjs';

const DEFAULT_TEMP_DIRS = guard.DEFAULT_TEMP_DIRS ?? [];
const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'agent-guard.mjs');
const SCHEMA = 'GATE TOUCHED: none | <path, why>';

// ---------------------------------------------------------------------------
// Fixture: <base>/primary (a repo), linked worktrees under .claude/worktrees,
// one with a space in its path, one outside .claude/worktrees, and an empty
// HOME so the user's own agent definitions do not leak in.
// ---------------------------------------------------------------------------

const fx = {};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

before(() => {
  fx.base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-guard-test-')));
  fx.primary = join(fx.base, 'primary');
  fx.home = join(fx.base, 'home');
  mkdirSync(fx.primary);
  mkdirSync(fx.home);
  git(fx.primary, 'init', '-q', '-b', 'main');
  git(fx.primary, 'config', 'user.name', 'Agent Guard Test');
  git(fx.primary, 'config', 'user.email', 'agent-guard-test@example.invalid');
  git(fx.primary, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(fx.primary, 'README'), 'fixture\n');
  git(fx.primary, 'add', 'README');
  git(fx.primary, 'commit', '-q', '-m', 'init');

  mkdirSync(join(fx.primary, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(fx.primary, '.claude', 'agents', 'reader.md'), '---\nname: reader\ntools: Read, Grep, Glob\n---\nReads.\n');
  writeFileSync(join(fx.primary, '.claude', 'agents', 'fixer.md'), '---\nname: fixer\ntools: Read, Edit, Bash\n---\nFixes.\n');

  fx.wt = join(fx.primary, '.claude', 'worktrees', 'feat-a');
  fx.wtSpace = join(fx.primary, '.claude', 'worktrees', 'my lane');
  fx.wtOutside = join(fx.base, 'elsewhere-wt');
  git(fx.primary, 'worktree', 'add', '-q', '-b', 'feat/a', fx.wt);
  git(fx.primary, 'worktree', 'add', '-q', '-b', 'feat/space', fx.wtSpace);
  git(fx.primary, 'worktree', 'add', '-q', '--detach', fx.wtOutside, 'HEAD');
  mkdirSync(join(fx.wt, 'src', 'lib'), { recursive: true });
  mkdirSync(join(fx.primary, '.claude', 'agents', 'broken.md'));
  fx.missing = join(fx.primary, '.claude', 'worktrees', 'never-created');
  fx.notRepo = join(fx.base, 'plain-dir');
  mkdirSync(fx.notRepo);
});

after(() => {
  if (fx.base) rmSync(fx.base, { recursive: true, force: true });
});

const opts = () => ({ projectDir: fx.primary, home: fx.home, tempDirs: [] });
const agent = (prompt, extra = {}) => ({ tool_name: 'Agent', tool_input: { prompt, ...extra }, cwd: fx.primary });

// ---------------------------------------------------------------------------
// parseLane
// ---------------------------------------------------------------------------

describe('parseLane', () => {
  const rows = [
    ['plain path', 'Lane: /abs/wt', { kind: 'path', path: '/abs/wt' }],
    ['trailing parenthetical dropped', 'Lane: /abs/wt   (detached at abc123)', { kind: 'path', path: '/abs/wt' }],
    ['backticked path', 'Lane: `/abs/wt`', { kind: 'path', path: '/abs/wt' }],
    ['backticks plus parenthetical', 'Lane: `/abs/wt` (detached at abc123)', { kind: 'path', path: '/abs/wt' }],
    ['parenthetical inside backticks', 'Lane: `/abs/wt (detached at abc123)`', { kind: 'path', path: '/abs/wt' }],
    ['path with spaces', 'Lane: /abs/my lane', { kind: 'path', path: '/abs/my lane' }],
    ['path with spaces and parenthetical', 'Lane: /abs/my lane  (review)', { kind: 'path', path: '/abs/my lane' }],
    ['parens glued to the path stay', 'Lane: /abs/wt(2)', { kind: 'path', path: '/abs/wt(2)' }],
    ['bold label, list bullet', '- **Lane:** /abs/wt', { kind: 'path', path: '/abs/wt' }],
    ['read-only', 'Lane: read-only', { kind: 'read-only' }],
    ['read only with note', 'Lane: read only (reviewer)', { kind: 'read-only' }],
    ['none with reason', 'Lane: none — runs the merge loop', { kind: 'none', reason: 'runs the merge loop' }],
    ['none bare', 'Lane: none', { kind: 'none', reason: '' }],
    ['absent', 'no declaration here', null],
  ];
  for (const [name, prompt, want] of rows) {
    test(name, () => assert.deepEqual(parseLane(`Goal\n${prompt}\nMore`), want));
  }
});

// ---------------------------------------------------------------------------
// findPlaceholders
// ---------------------------------------------------------------------------

describe('findPlaceholders', () => {
  const rows = [
    ['bare slot', 'Lane: {{WT}}', ['WT']],
    ['slot with description', 'Goal: {{GOAL: one sentence}}', ['GOAL']],
    ['digits and underscores', '{{GATE_CMD2}}', ['GATE_CMD2']],
    ['distinct, in order', '{{B}} {{A}} {{B: again}}', ['B', 'A']],
    ['multi-line description does not match', '{{GOAL: one\nsentence}}', []],
    ['JSX style object', "<div style={{ color: 'red' }} />", []],
    ['JSX object, no spaces', "<div style={{color:'red'}} />", []],
    ['Handlebars lower-case', 'Hello {{name}}', []],
    ['spaced upper-case', 'Lane: {{ WT }}', []],
    ['Go template field', 'Hello {{.Name}}', []],
    ['Handlebars triple-stash', '{{{BODY}}}', []],
    ['GitHub Actions expression', '${{ secrets.TOKEN }}', []],
    ['mixed case NAME', '{{Wt}}', []],
    ['leading digit', '{{1WT}}', []],
    ['empty', '', []],
    ['undefined', undefined, []],
  ];
  for (const [name, prompt, want] of rows) {
    test(name, () => assert.deepEqual(findPlaceholders(prompt), want));
  }
});

// ---------------------------------------------------------------------------
// decide — one row per deny form and allowed neighbour
// ---------------------------------------------------------------------------

describe('decide', () => {
  // Each row: [name, () => event, expect]. expect.action, plus optional
  // reason / context regexes (all must match) and notContext regexes.
  const rows = [
    // Unfilled placeholders: denied everywhere, slot names in the reason.
    ['unfilled {{WT}} denied', () => agent(`Lane: {{WT}}\n${SCHEMA}`), { action: 'deny', reason: [/unfilled/, /\bWT\b/] }],
    [
      'unfilled {{GOAL: one sentence}} denied even with a valid lane',
      () => agent(`Goal: {{GOAL: one sentence}}\nLane: ${fx.wt}\n${SCHEMA}`),
      { action: 'deny', reason: [/\bGOAL\b/] },
    ],
    [
      'unfilled slot denied on a read-only type',
      () => agent('Find {{TOPIC}}', { subagent_type: 'Explore' }),
      { action: 'deny', reason: [/\bTOPIC\b/] },
    ],
    [
      'unfilled slot denied on Lane: read-only',
      () => agent('Lane: read-only\n{{GOAL: one sentence}}'),
      { action: 'deny', reason: [/\bGOAL\b/] },
    ],
    [
      'unfilled slot denied on an isolation launch',
      () => agent('Do {{WT}} and {{GOAL: x}}', { isolation: 'worktree' }),
      { action: 'deny', reason: [/\bWT\b/, /\bGOAL\b/] },
    ],
    [
      'unfilled slots listed up to 5',
      () => agent('{{SLOT_A}} {{SLOT_B}} {{SLOT_C}} {{SLOT_D}} {{SLOT_E}} {{SLOT_F}} {{SLOT_G}}'),
      { action: 'deny', reason: [/SLOT_E/, /and 2 more/], notReason: [/SLOT_F/] },
    ],
    [
      'unfilled slot reason points at briefs.md',
      () => agent('{{WT}}'),
      { action: 'deny', reason: [/references\/briefs\.md/] },
    ],
    // Code that looks like braces is not a slot.
    [
      'JSX style={{ color: \'red\' }} allowed',
      () => agent(`Lane: ${fx.wt}\nFix <p style={{ color: 'red' }}>\n${SCHEMA}`),
      { action: 'allow' },
    ],
    ['Handlebars {{name}} allowed', () => agent(`Lane: ${fx.wt}\nRender {{name}}\n${SCHEMA}`), { action: 'allow' }],
    ['spaced {{ WT }} allowed', () => agent(`Lane: ${fx.wt}\nsee {{ WT }}\n${SCHEMA}`), { action: 'allow' }],
    ['Go template {{.Name}} allowed', () => agent(`Lane: ${fx.wt}\nsee {{.Name}}\n${SCHEMA}`), { action: 'allow' }],

    // Lane declaration: missing, read-only, none.
    [
      'missing lane on a writing type denied',
      () => agent('Implement the thing.'),
      { action: 'deny', reason: [/does not say where it runs/, /Lane: </, /references\/briefs\.md/] },
    ],
    ['missing lane on a Task (legacy name) denied', () => ({ ...agent('Implement.'), tool_name: 'Task' }), { action: 'deny' }],
    [
      'missing lane on a project agent with Edit denied',
      () => agent('Fix it.', { subagent_type: 'fixer' }),
      { action: 'deny' },
    ],
    [
      'read-only built-in type passes without a lane',
      () => agent('Survey the repo.', { subagent_type: 'Explore' }),
      { action: 'allow', context: [/read-only lane/] },
    ],
    ['Plan type passes without a lane', () => agent('Plan it.', { subagent_type: 'Plan' }), { action: 'allow' }],
    [
      'project agent without writing tools passes',
      () => agent('Read it.', { subagent_type: 'reader' }),
      { action: 'allow', context: [/read-only lane/] },
    ],
    [
      'Lane: read-only passes',
      () => agent('Lane: read-only'),
      { action: 'allow', context: [/declared read-only/, /references\/briefs\.md/], notContext: [/no report schema/] },
    ],
    [
      'Lane: none with a reason passes',
      () => agent('Lane: none — runs the merge loop from the primary checkout'),
      { action: 'allow', context: [/no lane \(runs the merge loop/] },
    ],
    ['Lane: none without a reason denied', () => agent('Lane: none'), { action: 'deny', reason: [/needs a reason/] }],
    ['Lane: none with a too-short reason denied', () => agent('Lane: none — x'), { action: 'deny', reason: [/needs a reason/] }],
    [
      'isolation launch passes without a lane',
      () => agent('Implement.', { isolation: 'worktree' }),
      { action: 'allow', context: [/isolated worktree lane/], notContext: [/no report schema/] },
    ],

    // Lane paths.
    [
      'linked worktree lane allowed',
      () => agent(`Lane: ${fx.wt}\n${SCHEMA}`),
      { action: 'allow', context: [new RegExp(`lane ${fx.wt}`)], notContext: [/outside \.claude\/worktrees/] },
    ],
    [
      'trailing-parenthetical lane path allowed',
      () => agent(`Lane: ${fx.wtOutside}   (detached at abc123)\n${SCHEMA}`),
      { action: 'allow', context: [/outside \.claude\/worktrees/] },
    ],
    ['lane path with spaces allowed', () => agent(`Lane: ${fx.wtSpace}\n${SCHEMA}`), { action: 'allow', context: [/my lane/] }],
    ['backticked lane path allowed', () => agent(`Lane: \`${fx.wt}\`\n${SCHEMA}`), { action: 'allow' }],
    [
      'subdirectory of a worktree resolves to its root',
      () => agent(`Lane: ${join(fx.wt, 'src', 'lib')}\n${SCHEMA}`),
      { action: 'allow', context: [new RegExp(`lane ${fx.wt}\\b`)] },
    ],
    ['primary checkout denied', () => agent(`Lane: ${fx.primary}\n${SCHEMA}`), { action: 'deny', reason: [/primary checkout/] }],
    [
      'temp dir denied',
      () => agent(`Lane: ${fx.wt}\n${SCHEMA}`),
      { action: 'deny', reason: [/temp directory/] },
      { tempDirs: () => [fx.base] },
    ],
    ['non-existent path denied', () => agent(`Lane: ${fx.missing}\n${SCHEMA}`), { action: 'deny', reason: [/does not exist/] }],
    ['relative path denied', () => agent(`Lane: wt/feat-a\n${SCHEMA}`), { action: 'deny', reason: [/not an absolute path/] }],
    ['directory outside any checkout denied', () => agent(`Lane: ${fx.notRepo}\n${SCHEMA}`), { action: 'deny', reason: [/not inside a git checkout/] }],

    // Missing report schema: a warning line, never a deny.
    [
      'missing-schema warning present',
      () => agent(`Lane: ${fx.wt}\nImplement it.`),
      { action: 'allow', context: [/no report schema/, /references\/briefs\.md/] },
    ],
    [
      'missing-schema warning absent with GATE TOUCHED',
      () => agent(`Lane: ${fx.wt}\nGATE TOUCHED: none`),
      { action: 'allow', notContext: [/no report schema/] },
    ],
    [
      'missing-schema warning absent with FINDINGS:',
      () => agent(`Lane: ${fx.wt}\nFINDINGS: one per line`),
      { action: 'allow', notContext: [/no report schema/] },
    ],
    [
      'missing-schema warning on an isolation launch with a path lane',
      () => agent(`Lane: ${fx.wt}\nImplement.`, { isolation: 'worktree' }),
      { action: 'allow', context: [/no report schema/] },
    ],

    // Other tools.
    [
      'Workflow allowed with context',
      () => ({ tool_name: 'Workflow', tool_input: { script: 'x' }, cwd: fx.primary }),
      { action: 'allow', context: [/parallel-agents/, /Lane: <path>/, /references\/briefs\.md/] },
    ],
    [
      'other tools allowed silently',
      () => ({ tool_name: 'Bash', tool_input: { command: 'echo {{WT}}' }, cwd: fx.primary }),
      { action: 'allow', noContext: true },
    ],
  ];

  for (const [name, event, want, over = {}] of rows) {
    test(name, () => {
      const o = opts();
      if (over.tempDirs) o.tempDirs = over.tempDirs();
      const v = decide(event(), o);
      assert.equal(v.action, want.action, JSON.stringify(v));
      for (const re of want.reason ?? []) assert.match(v.reason, re);
      for (const re of want.notReason ?? []) assert.doesNotMatch(v.reason, re);
      for (const re of want.context ?? []) assert.match(v.context ?? '', re);
      for (const re of want.notContext ?? []) assert.doesNotMatch(v.context ?? '', re);
      if (want.noContext) assert.equal(v.context, undefined);
      if (v.action === 'deny') assert.equal(v.context, undefined);
    });
  }

  test('missing-schema warning is one additional context line (A4)', () => {
    const lines = (p) => decide(agent(p), opts()).context.split('\n');
    const without = lines(`Lane: ${fx.wt}\nImplement it.`);
    const withGate = lines(`Lane: ${fx.wt}\nGATE TOUCHED: none`);
    assert.equal(without.length, withGate.length + 1);
    const extra = without.filter((l) => !withGate.includes(l));
    assert.equal(extra.length, 1);
    assert.match(extra[0], /no report schema.*references\/briefs\.md/);
    assert.ok(without.some((l) => /^Brief templates: /.test(l)), 'generic templates line kept');
  });

  test('BRIEFS_PATH names references/briefs.md', () => assert.match(BRIEFS_PATH, /references\/briefs\.md$/));
});

// ---------------------------------------------------------------------------
// Topology helpers (kept exports)
// ---------------------------------------------------------------------------

describe('topology helpers', () => {
  test('checkoutRoot / isLinkedWorktree / primaryRootOf', () => {
    assert.equal(checkoutRoot(join(fx.wt, 'src', 'lib')), fx.wt);
    assert.equal(isLinkedWorktree(fx.wt), true);
    assert.equal(isLinkedWorktree(fx.primary), false);
    assert.equal(primaryRootOf(fx.wt), fx.primary);
    assert.equal(primaryRootOf(fx.primary), fx.primary);
    assert.equal(checkoutRoot(fx.notRepo), null);
  });
});

// ---------------------------------------------------------------------------
// CLI entry point, end to end
// ---------------------------------------------------------------------------

describe('CLI', () => {
  function run(stdin, env = {}) {
    const base = { ...process.env };
    delete base.CLAUDE_PROJECT_DIR;
    delete base.PARALLEL_AGENTS_GUARD;
    const e = { ...base, HOME: fx.home, PARALLEL_AGENTS_TEMP_DIRS: '', ...env };
    return spawnSync(process.execPath, [HOOK], { input: stdin, env: e, encoding: 'utf8', cwd: fx.base });
  }
  const json = (o) => JSON.stringify(o);

  test('deny: exit 2, reason on stderr, nothing on stdout', () => {
    const r = run(json(agent('Implement it.')));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /does not say where it runs/);
    assert.equal(r.stdout, '');
  });

  test('deny: unfilled slot names on stderr', () => {
    const r = run(json(agent(`Lane: ${fx.wt}\n{{GOAL: one sentence}} {{WT}}`)));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /\bGOAL\b/);
    assert.match(r.stderr, /\bWT\b/);
  });

  test('allow: exit 0, additionalContext JSON on stdout', () => {
    const r = run(json(agent(`Lane: ${fx.wt}   (detached at abc123)\n${SCHEMA}`)));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`lane ${fx.wt}`));
  });

  test('temp dirs from env deny', () => {
    const r = run(json(agent(`Lane: ${fx.wt}\n${SCHEMA}`)), { PARALLEL_AGENTS_TEMP_DIRS: fx.base });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /temp directory/);
  });

  test('allow without context: exit 0, empty stdout', () => {
    const r = run(json({ tool_name: 'Read', tool_input: { file_path: '/x' } }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('fail-open on invalid JSON input', () => {
    const r = run('{not json');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('fail-open on empty input', () => {
    const r = run('');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('fail-open on an internal error (unreadable agent definition)', () => {
    // .claude/agents/broken.md is a directory: reading it throws EISDIR.
    const r = run(json(agent('Implement it.', { subagent_type: 'broken' })));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /internal error, allowing/);
  });

  test('fail-open on a null event', () => {
    const r = run('null');
    assert.equal(r.status, 0);
    assert.match(r.stderr, /internal error, allowing/);
  });

  test('PARALLEL_AGENTS_GUARD=off allows everything', () => {
    const r = run(json(agent('{{WT}} no lane')), { PARALLEL_AGENTS_GUARD: 'off' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });
});

// ---------------------------------------------------------------------------
// Contract amendments, round 2 (A35–A43)
// ---------------------------------------------------------------------------

describe('round 2 amendments', () => {
  const r2 = {};
  before(() => {
    // A38: a submodule inside the primary checkout.
    r2.subSrc = join(fx.base, 'sub-src');
    mkdirSync(r2.subSrc);
    git(r2.subSrc, 'init', '-q', '-b', 'main');
    git(r2.subSrc, 'config', 'user.name', 'Agent Guard Test');
    git(r2.subSrc, 'config', 'user.email', 'agent-guard-test@example.invalid');
    writeFileSync(join(r2.subSrc, 'f'), 'x\n');
    git(r2.subSrc, 'add', 'f');
    git(r2.subSrc, 'commit', '-q', '-m', 'sub');
    git(fx.primary, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', r2.subSrc, 'vendor/sub');
    r2.sub = join(fx.primary, 'vendor', 'sub');
    // A35: the hook reached through a symlinked file and a symlinked directory.
    r2.linkFile = join(fx.base, 'guard-link.mjs');
    symlinkSync(HOOK, r2.linkFile);
    r2.linkDir = join(fx.base, 'hooks-link');
    symlinkSync(dirname(HOOK), r2.linkDir);
    // A40: a temp dir reached through a symlink.
    r2.tmpLink = join(fx.base, 'tmp-link');
    symlinkSync(fx.base, r2.tmpLink);
    // A41: YAML block-list tools.
    const agents = join(fx.primary, '.claude', 'agents');
    writeFileSync(join(agents, 'block-writer.md'), '---\nname: block-writer\ntools:\n  - Read\n  - Edit\n---\nx\n');
    writeFileSync(join(agents, 'block-reader.md'), '---\nname: block-reader\ntools:\n  - Read\n  - Grep\n---\nx\n');
  });

  function cli(hookPath, event, env = {}) {
    const base = { ...process.env };
    delete base.CLAUDE_PROJECT_DIR;
    delete base.PARALLEL_AGENTS_GUARD;
    return spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(event),
      env: { ...base, HOME: fx.home, PARALLEL_AGENTS_TEMP_DIRS: '', ...env },
      encoding: 'utf8',
      cwd: fx.base,
    });
  }

  // A35
  test('A35: runs through a symlinked file', () => {
    const r = cli(r2.linkFile, agent('Implement it.'));
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /does not say where it runs/);
  });
  test('A35: runs through a symlinked directory', () => {
    const r = cli(join(r2.linkDir, 'agent-guard.mjs'), agent('Implement it.'));
    assert.equal(r.status, 2, r.stderr);
  });

  // A36
  test('A36: slot deny explains the {{ NAME }} escape', () => {
    const v = decide(agent('Bearer {{API_KEY}}'), opts());
    assert.equal(v.action, 'deny');
    assert.ok(v.reason.includes('{{ NAME }}'), v.reason);
    assert.match(v.reason, /API_KEY/);
  });
  test('A36: no message of the hook contains a slot', () => {
    const events = [
      agent('{{A_SLOT}} {{B: b}} {{C}} {{D}} {{E}} {{F}} {{G}}'),
      agent('Implement it.'),
      agent('Lane: none'),
      agent(`Lane: ${fx.primary}`),
      agent(`Lane: ${fx.missing}`),
      agent('Lane: rel/path'),
      agent(`Lane: ${fx.notRepo}`),
      agent(`Lane: ${fx.wt}`),
      agent(`Lane: ${fx.wt}\nLane: read-only`),
      agent('Lane: read-only'),
      agent('x', { subagent_type: 'Explore' }),
      agent('x', { isolation: 'worktree' }),
      { tool_name: 'Workflow', tool_input: {}, cwd: fx.primary },
    ];
    const bad = [];
    for (const e of events) {
      const v = decide(e, opts());
      for (const text of [v.reason, v.context]) if (text && findPlaceholders(text).length) bad.push(text);
    }
    const tempDeny = decide(agent(`Lane: ${fx.wt}`), { ...opts(), tempDirs: [fx.base] });
    if (findPlaceholders(tempDeny.reason).length) bad.push(tempDeny.reason);
    assert.deepEqual(bad, []);
  });

  // A37
  const isoRows = [
    ['primary', () => fx.primary, /primary checkout/],
    ['missing', () => fx.missing, /does not exist/],
    ['temp', () => fx.wt, /temp directory/, () => [fx.base]],
  ];
  for (const [name, path, re, temps] of isoRows) {
    test(`A37: isolation launch with a ${name} lane denied`, () => {
      const v = decide(agent(`Lane: ${path()}\n${SCHEMA}`, { isolation: 'worktree' }), { ...opts(), tempDirs: temps ? temps() : [] });
      assert.equal(v.action, 'deny');
      assert.match(v.reason, re);
    });
  }
  test('A37: isolation launch with a valid lane allowed', () => {
    const v = decide(agent(`Lane: ${fx.wt}\n${SCHEMA}`, { isolation: 'worktree' }), opts());
    assert.equal(v.action, 'allow');
    assert.match(v.context, /isolated/);
  });

  // A38
  test('A38: a submodule is not a linked worktree', () => {
    assert.equal(isLinkedWorktree(r2.sub), false);
    assert.equal(primaryRootOf(r2.sub), null);
    const v = decide(agent(`Lane: ${r2.sub}\n${SCHEMA}`), opts());
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /not a linked worktree/);
  });
  test('A38: a real linked worktree still is one', () => {
    assert.equal(isLinkedWorktree(fx.wt), true);
    assert.equal(primaryRootOf(fx.wt), fx.primary);
  });

  // A39
  const fenceRows = [
    ['``` fence', (real) => `\`\`\`\nLane: read-only\n\`\`\`\nLane: ${real}`],
    ['~~~ fence', (real) => `~~~md\nLane: read-only\n~~~\nLane: ${real}`],
    ['indented ``` fence', (real) => `  \`\`\`\n  Lane: read-only\n  \`\`\`\nLane: ${real}`],
    ['blockquote', (real) => `> Lane: read-only\nLane: ${real}`],
    ['nested blockquote', (real) => `> > Lane: read-only\nLane: ${real}`],
  ];
  for (const [name, brief] of fenceRows) {
    test(`A39: Lane line in a ${name} is ignored`, () => {
      const v = decide(agent(`${brief(fx.primary)}\n${SCHEMA}`), opts());
      assert.equal(v.action, 'deny', JSON.stringify(v));
      assert.match(v.reason, /primary checkout/);
      assert.deepEqual(parseLane(brief('/abs/wt')), { kind: 'path', path: '/abs/wt' });
    });
  }
  test('A39: only a fenced Lane line → no lane (writer denied)', () => {
    const v = decide(agent('```\nLane: read-only\n```\nImplement.'), opts());
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /does not say where it runs/);
  });
  test('A39: disagreeing Lane lines deny, naming them', () => {
    const v = decide(agent(`Lane: read-only\nwork\nLane: ${fx.wt}\n${SCHEMA}`), opts());
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /Lane: read-only/);
    assert.ok(v.reason.includes(`Lane: ${fx.wt}`), v.reason);
  });
  test('A39: agreeing Lane lines allowed', () => {
    const v = decide(agent(`Lane: ${fx.wt}\n...\n**Lane:** \`${fx.wt}\` (again)\n${SCHEMA}`), opts());
    assert.equal(v.action, 'allow', JSON.stringify(v));
  });

  // A40
  test('A40: temp dir given through a symlink denies a lane under its target', () => {
    const v = decide(agent(`Lane: ${fx.wt}\n${SCHEMA}`), { ...opts(), tempDirs: [r2.tmpLink] });
    assert.equal(v.action, 'deny', JSON.stringify(v));
    assert.match(v.reason, /temp directory/);
  });
  test('A40: lane given through a symlink into a temp dir denied', () => {
    const viaLink = join(r2.tmpLink, 'primary', '.claude', 'worktrees', 'feat-a');
    const v = decide(agent(`Lane: ${viaLink}\n${SCHEMA}`), { ...opts(), tempDirs: [fx.base] });
    assert.equal(v.action, 'deny', JSON.stringify(v));
    assert.match(v.reason, /temp directory/);
  });
  test('A40: default temp list includes /private/tmp and /private/var/folders', () => {
    assert.ok(DEFAULT_TEMP_DIRS.includes('/private/tmp'));
    assert.ok(DEFAULT_TEMP_DIRS.includes('/private/var/folders'));
  });

  // A41
  test('A41: block-list tools with Edit is a writer', () => {
    assert.match(agentTools('block-writer', fx.primary, fx.home), /Edit/);
    assert.equal(canWrite('block-writer', fx.primary, fx.home), true);
    assert.equal(decide(agent('Fix it.', { subagent_type: 'block-writer' }), opts()).action, 'deny');
  });
  test('A41: block-list tools without writing tools is read-only', () => {
    assert.equal(canWrite('block-reader', fx.primary, fx.home), false);
    assert.equal(decide(agent('Read it.', { subagent_type: 'block-reader' }), opts()).action, 'allow');
  });

  // A42
  const N = 200_000;
  const slow = [
    ['long whitespace run', 'Lane: /abs/wt' + ' '.repeat(N) + 'x'],
    ['long whitespace run, unterminated', 'Lane:' + ' '.repeat(N)],
    ['whitespace then parenthetical', 'Lane: /abs/wt' + ' '.repeat(N) + '(x)'],
    ['NBSP run', 'Lane: /abs/wt' + ' '.repeat(N) + '(x)'],
    ['line of *', '*'.repeat(N)],
    ['* around Lane', '*'.repeat(N) + 'Lane: /a' + '*'.repeat(N)],
    ['many parentheticals', 'Lane: /abs/wt' + ' (a)'.repeat(N / 4)],
    ['many ( without )', 'Lane: /abs/wt' + ' ('.repeat(N / 2) + ')'],
    ['many - bullets', '- '.repeat(N / 2) + 'Lane: /a'],
    ['many fence markers', '```\n'.repeat(N / 4)],
    ['open slot', '{{A' + 'A'.repeat(N)],
    ['open described slot', '{{A: ' + 'x'.repeat(N)],
    ['many opens', '{{A'.repeat(N / 3)],
  ];
  for (const [name, text] of slow) {
    test(`A42: linear time — ${name}`, () => {
      const t0 = process.hrtime.bigint();
      parseLane(text);
      parseLane(`Goal\n${text}\nmore`);
      findPlaceholders(text);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
    });
  }

  // A43
  const a43 = [
    ['## heading', '## Lane: /abs/wt', { kind: 'path', path: '/abs/wt' }],
    ['### bold heading', '### **Lane:** /abs/wt', { kind: 'path', path: '/abs/wt' }],
    ['1. numbered', '1. Lane: /abs/wt', { kind: 'path', path: '/abs/wt' }],
    ['12) numbered', '12) Lane: read-only', { kind: 'read-only' }],
    ['NBSP before parenthetical', 'Lane: /abs/wt (detached at abc)', { kind: 'path', path: '/abs/wt' }],
    ['tab before parenthetical', 'Lane: /abs/wt\t(detached at abc)', { kind: 'path', path: '/abs/wt' }],
    ['trailing _ kept', 'Lane: /abs/wt_', { kind: 'path', path: '/abs/wt_' }],
    ['trailing * kept', 'Lane: /abs/wt*', { kind: 'path', path: '/abs/wt*' }],
    ['trailing __ kept', 'Lane: /abs/wt__', { kind: 'path', path: '/abs/wt__' }],
    ['balanced * stripped', 'Lane: */abs/wt*', { kind: 'path', path: '/abs/wt' }],
    ['balanced ** stripped', 'Lane: **/abs/wt**', { kind: 'path', path: '/abs/wt' }],
    ['balanced _ stripped', 'Lane: _/abs/wt_', { kind: 'path', path: '/abs/wt' }],
    ['bold read-only', 'Lane: **read-only**', { kind: 'read-only' }],
    ['#Lane is not a heading', '#Lane: /abs/wt', null],
    ['Lanes: is not Lane:', 'Lanes: /abs/wt', null],
  ];
  for (const [name, line, want] of a43) {
    test(`A43: ${name}`, () => assert.deepEqual(parseLane(`Goal\n${line}\nMore`), want));
  }
});

// ---------------------------------------------------------------------------
// Contract amendments, round 5 (A74–A83)
// ---------------------------------------------------------------------------

describe('round 5 amendments', () => {
  const r5 = {};
  const agentsDir = () => join(fx.primary, '.claude', 'agents');
  const defineAgent = (name, front) => writeFileSync(join(agentsDir(), `${name}.md`), `---\nname: ${name}\n${front}\n---\nbody\n`);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  before(() => {
    // A74 / A75 agent definitions.
    defineAgent('star', 'tools: *');
    defineAgent('star-dq', 'tools: "*"');
    defineAgent('star-sq', "tools: '*'");
    defineAgent('star-item', 'tools:\n  - "*"');
    defineAgent('folded', 'tools: >-\n  Read, Grep');
    defineAgent('literal', 'tools: |\n  Read');
    defineAgent('literal-strip', 'tools: |-\n  Read');
    defineAgent('flow-multiline', 'tools: [Read,\n  Grep]');
    defineAgent('plain-multiline', 'tools: Read,\n  Grep');
    defineAgent('malformed', 'tools: Read Grep');
    defineAgent('unclosed-flow', 'tools: [Read, Grep');
    defineAgent('flow-read', 'tools: [Read, Grep]');
    defineAgent('flow-bash', 'tools: [Read, Bash]');
    defineAgent('quoted-read', 'tools: "Read, Grep"');
    defineAgent('quoted-items', 'tools:\n  - "Read"\n  - \'Grep\'');
    defineAgent('scoped-bash', 'tools: Read, Bash(git status:*)');

    // A77 layouts, in their own dir.
    r5.dir = join(fx.base, 'layouts');
    mkdirSync(r5.dir);
    r5.src = join(r5.dir, 'src');
    mkdirSync(r5.src);
    g(r5.src, 'init', '-q', '-b', 'main');
    g(r5.src, 'commit', '-q', '--allow-empty', '-m', 'i');
    // bare repo + worktree
    g(r5.dir, 'clone', '-q', '--bare', r5.src, 'bare.git');
    r5.bareWt = join(r5.dir, 'bare-wt');
    g(join(r5.dir, 'bare.git'), 'worktree', 'add', '-q', r5.bareWt, 'main');
    // .bare + .git-file layout
    r5.proj = join(r5.dir, 'proj');
    mkdirSync(r5.proj);
    g(r5.proj, 'clone', '-q', '--bare', r5.src, '.bare');
    writeFileSync(join(r5.proj, '.git'), 'gitdir: ./.bare\n');
    r5.projWt = join(r5.proj, 'main-wt');
    g(r5.proj, 'worktree', 'add', '-q', r5.projWt, 'main');
    // --separate-git-dir
    r5.sepWork = join(r5.dir, 'sepwork');
    g(r5.dir, 'init', '-q', '-b', 'main', '--separate-git-dir', join(r5.dir, 'sep.git'), r5.sepWork);
    g(r5.sepWork, 'commit', '-q', '--allow-empty', '-m', 'i');
    r5.sepWt = join(r5.dir, 'sep-wt');
    g(r5.sepWork, 'worktree', 'add', '-q', '-b', 'x', r5.sepWt);
    // a worktree of the submodule from round 2 (vendor/sub in the primary)
    r5.subWt = join(r5.dir, 'sub-wt');
    g(join(fx.primary, 'vendor', 'sub'), 'worktree', 'add', '-q', '-b', 'subx', r5.subWt);
    // A81: .git file pointing at a gitdir that does not exist
    r5.ghost = join(r5.dir, 'ghost');
    mkdirSync(r5.ghost);
    writeFileSync(join(r5.ghost, '.git'), `gitdir: ${join(fx.primary, '.git', 'worktrees', 'ghost')}\n`);
    // A78: a symlink to the lane
    r5.wtLink = join(fx.base, 'wt-link');
    symlinkSync(fx.wt, r5.wtLink);
  });

  // A74
  for (const name of ['star', 'star-dq', 'star-sq', 'star-item']) {
    test(`A74: tools ${name} is a writer`, () => {
      assert.equal(canWrite(name, fx.primary, fx.home), true);
      assert.equal(decide(agent('Fix it.', { subagent_type: name }), opts()).action, 'deny');
    });
  }

  // A75
  for (const name of ['folded', 'literal', 'literal-strip', 'flow-multiline', 'plain-multiline', 'malformed', 'unclosed-flow']) {
    test(`A75: unparseable tools (${name}) fails closed as a writer`, () => {
      assert.equal(canWrite(name, fx.primary, fx.home), true);
    });
  }
  const parsed = [
    ['flow-read', false],
    ['flow-bash', true],
    ['quoted-read', false],
    ['quoted-items', false],
    ['scoped-bash', true],
  ];
  for (const [name, want] of parsed) {
    test(`A75: parseable tools (${name}) → writer=${want}`, () => assert.equal(canWrite(name, fx.primary, fx.home), want));
  }

  // A76
  test('A76: no message of the hook reads as a Lane line or slot when pasted into a brief', () => {
    const events = [
      agent('{{A_SLOT}} {{B: b}} {{C}} {{D}} {{E}} {{F}} {{G}}'),
      agent('Implement it.'),
      agent('Lane: none'),
      agent(`Lane: ${fx.primary}`),
      agent(`Lane: ${fx.missing}`),
      agent('Lane: rel/path'),
      agent(`Lane: ${fx.notRepo}`),
      agent(`Lane: ${fx.wt}`),
      agent(`Lane: ${fx.wt}\nLane: read-only\nLane: none — some reason here`),
      agent('Lane: read-only'),
      agent('Lane: none — runs the merge loop from the primary'),
      agent('x', { subagent_type: 'Explore' }),
      agent('x', { isolation: 'worktree' }),
      agent(`Lane: ${fx.wt}`, { isolation: 'worktree' }),
      agent(`Lane: ${join(fx.primary, 'vendor', 'sub')}`),
      agent(`Lane: ${r5.ghost}`),
      agent(`Lane: ${r5.bareWt}`),
      { tool_name: 'Workflow', tool_input: {}, cwd: fx.primary },
    ];
    const messages = [];
    for (const e of events) {
      const v = decide(e, opts());
      for (const text of [v.reason, v.context]) if (text) messages.push(text);
    }
    messages.push(decide(agent(`Lane: ${fx.wt}`), { ...opts(), tempDirs: [fx.base] }).reason);
    const bad = [];
    for (const R of messages) {
      const v = decide(agent(`Lane: ${fx.wt}\n${R}\n${SCHEMA}`), opts());
      if (v.action !== 'allow') bad.push(`${R.split('\n')[0]} → ${v.reason.split('\n')[0]}`);
    }
    assert.deepEqual(bad, []);
  });

  // A77
  for (const [name, path] of [
    ['bare repository', () => r5.bareWt],
    ['.bare + .git-file layout', () => r5.projWt],
    ['--separate-git-dir repository', () => r5.sepWt],
  ]) {
    test(`A77: worktree of a ${name} is a valid lane`, () => {
      assert.equal(isLinkedWorktree(path()), true);
      const v = decide(agent(`Lane: ${path()}\n${SCHEMA}`), opts());
      assert.equal(v.action, 'allow', JSON.stringify(v));
    });
  }
  test('A77: .bare layout primary (.git file → common dir) is the primary checkout', () => {
    const v = decide(agent(`Lane: ${r5.proj}\n${SCHEMA}`), opts());
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /primary checkout/);
  });
  test('A77: separate-git-dir main checkout is the primary checkout', () => {
    const v = decide(agent(`Lane: ${r5.sepWork}\n${SCHEMA}`), opts());
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /primary checkout/);
  });
  for (const [name, path] of [
    ['submodule', () => join(fx.primary, 'vendor', 'sub')],
    ['worktree of a submodule', () => r5.subWt],
  ]) {
    test(`A77: ${name} denied, saying "submodule"`, () => {
      assert.equal(isLinkedWorktree(path()), false);
      const v = decide(agent(`Lane: ${path()}\n${SCHEMA}`), opts());
      assert.equal(v.action, 'deny');
      assert.match(v.reason, /submodule/);
    });
  }

  // A78
  test('A78: Lane lines naming the same checkout agree', () => {
    const lines = [fx.wt, `${fx.wt}/`, `${fx.wt}/./`, `${fx.wt}/src/..`, r5.wtLink, join(fx.wt, 'src', 'lib')];
    const v = decide(agent(`${lines.map((l) => `Lane: ${l}`).join('\n')}\n${SCHEMA}`), opts());
    assert.equal(v.action, 'allow', JSON.stringify(v));
  });
  test('A78: relative spellings of one path agree (then denied as relative)', () => {
    const v = decide(agent('Lane: WT\nLane: WT/\nLane: ./WT\nLane: x/../WT'), opts());
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /not an absolute path/);
  });
  test('A78: different checkouts still disagree', () => {
    const v = decide(agent(`Lane: ${fx.wt}\nLane: ${fx.wtSpace}\n${SCHEMA}`), opts());
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /disagree/);
  });

  // A79 — each shape once; the old code is quadratic on all of them.
  const N = 200_000;
  const shapes = [
    ['200 KB of distinct slots', () => Array.from({ length: N / 8 }, (_, k) => `{{S${k}}}`).join(' ')],
    ['long leading backtick run', () => 'Lane: ' + '`'.repeat(N) + '/x`'],
    ['long leading * run', () => 'Lane: ' + '*'.repeat(N) + '/x*'],
    ['alternating wrappers', () => 'Lane: ' + '`*_'.repeat(N / 3) + '/x' + '_*`'.repeat(N / 3)],
    ['wrappers then parenthetical', () => 'Lane: ' + '`'.repeat(N / 2) + '/x (a)`'],
    ['many parentheticals in backticks', () => 'Lane: `/x' + ' (a)'.repeat(N / 4) + '`'],
    ['long ) run', () => 'Lane: /x ' + ')'.repeat(N)],
    ['dash commentary run', () => 'Lane: /x' + ' --'.repeat(N / 3)],
    ['long left run re-counted per parenthetical', () => 'Lane: ' + '`'.repeat(N / 2) + '/x' + ' (a)`'.repeat(N / 8)],
    ['long right run re-counted per left wrapper', () => 'Lane: ' + '` '.repeat(N / 4) + '/x' + '`'.repeat(N / 2)],
  ];
  for (const [name, make] of shapes) {
    test(`A79: linear — ${name}`, () => {
      const text = make();
      const t0 = process.hrtime.bigint();
      parseLane(text);
      findPlaceholders(text);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
    });
  }
  test('A79: 200 KB of distinct slots via decide is fast and lists 5', () => {
    const text = Array.from({ length: N / 8 }, (_, k) => `{{S${k}}}`).join(' ');
    const t0 = process.hrtime.bigint();
    const v = decide(agent(text), opts());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /S0, S1, S2, S3, S4 \(and \d+ more\)/);
    assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
  });

  // A80
  test('A80: an inline ``` line does not open a fence', () => {
    const v = decide(agent(`Run \`\`\` npm test \`\`\` first.\n\`\`\` npm test \`\`\`\nLane: ${fx.primary}\n${SCHEMA}`), opts());
    assert.equal(v.action, 'deny');
    assert.match(v.reason, /primary checkout/);
  });
  test('A80: a ``` fence with an info string still opens', () => {
    assert.equal(parseLane('```bash\nLane: read-only\n```\nLane: /abs/wt').kind, 'path');
  });
  test('A80: a ~~~ line with a backtick in its info string still opens', () => {
    assert.equal(parseLane('~~~ `x`\nLane: read-only\n~~~\nLane: /abs/wt').kind, 'path');
  });

  // A81
  test('A81: .git file pointing at a missing gitdir denied', () => {
    assert.equal(isLinkedWorktree(r5.ghost), false);
    const v = decide(agent(`Lane: ${r5.ghost}\n${SCHEMA}`), opts());
    assert.equal(v.action, 'deny', JSON.stringify(v));
    assert.match(v.reason, /does not exist/);
    assert.match(v.reason, /stale/);
  });

  // A82
  test('A82: worktree of another repository allowed with an extra line', () => {
    const v = decide(agent(`Lane: ${r5.bareWt}\n${SCHEMA}`), opts());
    assert.equal(v.action, 'allow');
    assert.match(v.context, /different repository/);
    const same = decide(agent(`Lane: ${fx.wt}\n${SCHEMA}`), opts());
    assert.doesNotMatch(same.context, /different repository/);
    const lines = (c) => c.split('\n').length;
    assert.equal(lines(v.context), lines(same.context) + 1);
  });
  test('A82: project dir inside a lane of the same repo is the same repository', () => {
    const v = decide(agent(`Lane: ${fx.wt}\n${SCHEMA}`), { ...opts(), projectDir: fx.wtSpace });
    assert.doesNotMatch(v.context, /different repository/);
  });

  // A83
  const spellings = [
    ['**Lane: /wt**', '**Lane: /wt**', { kind: 'path', path: '/wt' }],
    ['_Lane: /wt_', '_Lane: /wt_', { kind: 'path', path: '/wt' }],
    ['## Lane: /wt ##', '## Lane: /wt ##', { kind: 'path', path: '/wt' }],
    ['trailing period', 'Lane: /wt.', { kind: 'path', path: '/wt' }],
    ['`read-only` (reviews)', 'Lane: `read-only` (reviews)', { kind: 'read-only' }],
    ['`none` — reviewer only', 'Lane: `none` — reviewer only', { kind: 'none', reason: 'reviewer only' }],
    ['**read-only** — no edits', 'Lane: **read-only** — no edits', { kind: 'read-only' }],
    ['path — commentary', 'Lane: /wt — the feature lane', { kind: 'path', path: '/wt' }],
    ['path -- commentary', 'Lane: /wt -- the feature lane', { kind: 'path', path: '/wt' }],
    // neighbours that must not change
    ['/wt/.. keeps its dots', 'Lane: /a/wt/..', { kind: 'path', path: '/a/wt/..' }],
    ['hyphen inside a path', 'Lane: /a/my-wt', { kind: 'path', path: '/a/my-wt' }],
    ['trailing _ still kept', 'Lane: /wt_', { kind: 'path', path: '/wt_' }],
    ['**Lane:** /wt', '**Lane:** /wt', { kind: 'path', path: '/wt' }],
    ['none — x', 'Lane: none — runs the merge loop', { kind: 'none', reason: 'runs the merge loop' }],
  ];
  for (const [name, line, want] of spellings) {
    test(`A83: ${name}`, () => assert.deepEqual(parseLane(`Goal\n${line}\nMore`), want));
  }
});

// ---------------------------------------------------------------------------
// Contract amendment, round 6 (A88)
// ---------------------------------------------------------------------------

describe('round 6 amendment A88', () => {
  const noCheck = /SHA|worktree is clean/i;
  for (const [name, event] of [
    ['Lane: read-only', () => agent('Lane: read-only\nFind X.')],
    ['read-only type, no lane', () => agent('Find X.', { subagent_type: 'Explore' })],
    ['read-only project agent, no lane', () => agent('Find X.', { subagent_type: 'reader' })],
  ]) {
    test(`A88: ${name} context asks for no SHA or worktree check`, () => {
      const v = decide(event(), opts());
      assert.equal(v.action, 'allow');
      assert.doesNotMatch(v.context, noCheck);
      assert.match(v.context, /NOT VERIFIED/);
    });
  }
  test('A88: a path lane context still asks for the SHA and a clean worktree', () => {
    const v = decide(agent(`Lane: ${fx.wt}\n${SCHEMA}`), opts());
    assert.match(v.context, /SHA is on the remote/);
    assert.match(v.context, /worktree is clean/);
  });
  test('A88: header documents the stdin event shape and PARALLEL_AGENTS_TEMP_DIRS', async () => {
    const { readFileSync } = await import('node:fs');
    const header = readFileSync(HOOK, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('//'))
      .join('\n');
    for (const word of ['tool_name', 'tool_input', 'prompt', 'subagent_type', 'isolation', 'cwd', 'PARALLEL_AGENTS_TEMP_DIRS', 'CLAUDE_PROJECT_DIR']) {
      assert.match(header, new RegExp(word), word);
    }
  });
});
