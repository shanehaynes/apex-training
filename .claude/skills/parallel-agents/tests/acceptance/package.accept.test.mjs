// Acceptance: package-level properties (amendments A84–A88), written by the
// orchestrator. Usage: SKILL_ROOT=<dir> node package.accept.test.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_ROOT, baseEnv, commitFile, eq, git, makeRepo, match, noMatch, ok, runNode, suite, tmp } from './harness.mjs';

const s = suite('package');
const test = s.test.bind(s);

function gitMode(rel) {
  const r = spawnSync('git', ['-C', SKILL_ROOT, 'ls-files', '-s', '--', rel], { encoding: 'utf8', env: baseEnv });
  const line = (r.stdout || '').trim().split('\n')[0] || '';
  return line.split(/\s+/)[0] || '';
}

test('A84 scripts, hook and bash test files are executable (git mode 100755)', () => {
  const files = ['scripts/lane.sh', 'scripts/combine-check.sh', 'scripts/with-lock.sh', 'scripts/fleet.mjs', 'hooks/agent-guard.mjs', 'tests/lane.test.sh', 'tests/with-lock.test.sh', 'tests/combine-check.test.sh'];
  const bad = [];
  for (const f of files) {
    const p = join(SKILL_ROOT, f);
    if (!existsSync(p)) { bad.push(`${f}: missing`); continue; }
    const mode = gitMode(f);
    const fsExec = (statSync(p).mode & 0o111) !== 0;
    if (mode && mode !== '100755') bad.push(`${f}: git mode ${mode}`);
    if (!mode && !fsExec) bad.push(`${f}: not executable on disk`);
  }
  eq(bad.join('; '), '', 'every listed file is executable');
});

test('A85 every {{NAME slot in SKILL.md and references/briefs.md is detected by findPlaceholders', async () => {
  const { findPlaceholders } = await import(join(SKILL_ROOT, 'hooks', 'agent-guard.mjs'));
  const missed = [];
  for (const f of ['SKILL.md', 'references/briefs.md']) {
    const text = readFileSync(join(SKILL_ROOT, f), 'utf8');
    const openers = [...new Set([...text.matchAll(/\{\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))];
    const found = new Set(findPlaceholders(text).map((n) => n.replace(/^\{\{|\}\}$/g, '').split(':')[0].trim()));
    for (const n of openers) if (!found.has(n)) missed.push(`${f}: ${n}`);
  }
  eq(missed.join('; '), '', 'slots the hook would miss');
});

test('A86 fleet set accepts brief=<file>, stored absolute', () => {
  const repo = tmp('repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const dir = join(tmp('fleet-'), 'fleet');
  const FLEET = join(SKILL_ROOT, 'scripts', 'fleet.mjs');
  const run = (args) => runNode(FLEET, args, { cwd: repo, env: { FLEET_DIR: dir } });
  eq(run(['init', 't']).code, 0, 'init');
  eq(run(['lane', 'a']).code, 0, 'lane a');
  const r = run(['set', 'a', 'brief=briefs/a.md']);
  eq(r.code, 0, `set brief= exit (${(r.err || '').slice(0, 120)})`);
  const shown = JSON.parse(run(['show', '--json']).out);
  const lane = shown.lanes.find((l) => l.slug === 'a');
  ok(lane && typeof lane.brief === 'string' && lane.brief.startsWith('/') && lane.brief.endsWith('briefs/a.md'), `brief stored absolute (got ${lane && lane.brief})`);
});

test('A87 combine-check --baseline: the fold-failure line does not blame the lanes before the verdict', () => {
  const { primary } = makeRepo();
  commitFile(primary, 'x.txt', 'x');
  git(primary, 'push', '-q', 'origin', 'main');
  git(primary, 'checkout', '-q', '-b', 'feat/a');
  commitFile(primary, 'a.txt', 'a');
  git(primary, 'push', '-q', 'origin', 'feat/a');
  git(primary, 'checkout', '-q', 'main');
  const cc = join(SKILL_ROOT, 'scripts', 'combine-check.sh');
  const withB = spawnSync('bash', [cc, '--baseline', '--check', 'test -f nowhere.txt', 'feat/a'], { cwd: primary, encoding: 'utf8', env: baseEnv, timeout: 120000 });
  eq(withB.status, 3, 'fold and base both fail → exit 3');
  noMatch(withB.stdout + withB.stderr, /individually green but not together/, 'no blame before the baseline verdict');
  const noB = spawnSync('bash', [cc, '--check', 'test -f nowhere.txt', 'feat/a'], { cwd: primary, encoding: 'utf8', env: baseEnv, timeout: 120000 });
  eq(noB.status, 1, 'without --baseline → exit 1');
});

test('A88 hook: read-only context does not ask for a SHA/worktree check; header documents the event shape', async () => {
  const mod = await import(join(SKILL_ROOT, 'hooks', 'agent-guard.mjs'));
  const v = mod.decide({ tool_name: 'Agent', cwd: tmp('proj-'), tool_input: { prompt: 'Lane: read-only\nFind X.', subagent_type: 'general-purpose' } }, { tempDirs: [] });
  eq(v.action, 'allow', 'read-only launch allowed');
  noMatch(v.context || '', /SHA|worktree is clean/i, 'read-only context');
  const src = readFileSync(join(SKILL_ROOT, 'hooks', 'agent-guard.mjs'), 'utf8');
  const header = src.split('\n').filter((l) => l.startsWith('//')).join('\n');
  match(header, /tool_name/, 'header documents tool_name');
  match(header, /PARALLEL_AGENTS_TEMP_DIRS/, 'header documents PARALLEL_AGENTS_TEMP_DIRS');
});

await s.run();
