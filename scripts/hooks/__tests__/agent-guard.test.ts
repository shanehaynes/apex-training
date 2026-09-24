import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain JS hook, run with bare node; no .d.mts on purpose (it is portable with the skill)
import { canWrite, decide, parseLane, primaryRootOf } from '../../../.claude/skills/parallel-agents/hooks/agent-guard.mjs';

const hook = fileURLToPath(new URL('../../../.claude/skills/parallel-agents/hooks/agent-guard.mjs', import.meta.url));

// A fake primary checkout with one canonical worktree, one project agent of
// each kind, and a fake home with no agents. The fixture itself lives in the
// OS temp dir, so decide() is given an explicit temp-dir list that excludes
// it; one test covers the temp-dir rule with a list that includes it.
const base = mkdtempSync(join(tmpdir(), 'agent-guard-'));
const primary = join(base, 'home', 'proj');
mkdirSync(join(primary, '.git', 'worktrees', 'feat-a'), { recursive: true });
const lane = join(primary, '.claude', 'worktrees', 'feat-a');
mkdirSync(lane, { recursive: true });
writeFileSync(join(lane, '.git'), `gitdir: ${join(primary, '.git', 'worktrees', 'feat-a')}\n`);
const agents = join(primary, '.claude', 'agents');
mkdirSync(agents, { recursive: true });
writeFileSync(join(agents, 'reader.md'), '---\nname: reader\ntools: Read, Grep, Glob\n---\nbody\n');
writeFileSync(join(agents, 'verifier.md'), '---\nname: verifier\ntools: Bash, Read\n---\nbody\n');
writeFileSync(join(agents, 'anything.md'), '---\nname: anything\n---\nno tools line\n');
const home = join(base, 'fakehome');
mkdirSync(home);

afterAll(() => rmSync(base, { recursive: true, force: true }));

const launch = (prompt: string, extra: Record<string, unknown> = {}) =>
  decide(
    { tool_name: 'Agent', tool_input: { description: 'x', prompt, ...extra }, cwd: primary },
    { projectDir: primary, home, tempDirs: [] },
  );

describe('parseLane', () => {
  it('reads the three forms, tolerating markdown', () => {
    expect(parseLane(`## Env\nLane: ${lane}\n`)).toEqual({ kind: 'path', path: lane });
    expect(parseLane(`**Lane:** \`${lane}\``)).toEqual({ kind: 'path', path: lane });
    expect(parseLane('- Lane: read-only')).toEqual({ kind: 'read-only' });
    expect(parseLane('Lane: READ ONLY')).toEqual({ kind: 'read-only' });
    expect(parseLane('Lane: none — runs the merge loop')).toEqual({ kind: 'none', reason: 'runs the merge loop' });
    expect(parseLane('Lane: none')).toEqual({ kind: 'none', reason: '' });
  });

  it('ignores a mention that is not its own line', () => {
    expect(parseLane('the Lane: field is described in the skill')).toBeNull();
    expect(parseLane('no declaration at all')).toBeNull();
  });
});

describe('which agent types can write', () => {
  it('built-in read-only types cannot', () => {
    expect(canWrite('Explore', primary, home)).toBe(false);
    expect(canWrite('Plan', primary, home)).toBe(false);
  });
  it('project agents are judged by their tools line', () => {
    expect(canWrite('reader', primary, home)).toBe(false);
    expect(canWrite('verifier', primary, home)).toBe(true);
    expect(canWrite('anything', primary, home)).toBe(true); // no tools line = every tool
  });
  it('unknown and general types can', () => {
    expect(canWrite('general-purpose', primary, home)).toBe(true);
    expect(canWrite('no-such-agent', primary, home)).toBe(true);
  });
});

describe('decide', () => {
  it('denies a writing subagent with no lane, and says how to comply', () => {
    const v = launch('Fix the bug in src/x.ts');
    expect(v.action).toBe('deny');
    expect(v.reason).toMatch(/SKILL\.md/);
    expect(v.reason).toMatch(/Lane: read-only/);
    expect(launch('fix it', { subagent_type: 'verifier' }).action).toBe('deny');
  });

  it('allows read-only agent types without a declaration', () => {
    expect(launch('find the auth code', { subagent_type: 'Explore' }).action).toBe('allow');
    expect(launch('summarize', { subagent_type: 'reader' }).action).toBe('allow');
  });

  it('allows declared read-only and reasoned opt-outs; denies a bare opt-out', () => {
    expect(launch('Lane: read-only\nresearch X').action).toBe('allow');
    expect(launch('Lane: none — shepherds merges from the primary checkout').action).toBe('allow');
    expect(launch('Lane: none').action).toBe('deny');
  });

  it('allows harness-isolated worktrees', () => {
    expect(launch('fix it', { isolation: 'worktree' }).action).toBe('allow');
  });

  it('allows a real linked worktree and reminds what comes next', () => {
    const v = launch(`Lane: ${lane}\nfix it`);
    expect(v.action).toBe('allow');
    expect(v.context).toMatch(/SHA/);
    const sub = launch(`Lane: ${join(lane)}/\nfix it`);
    expect(sub.action).toBe('allow');
  });

  it('denies lanes that are relative, missing, the primary, or not a checkout', () => {
    expect(launch('Lane: .claude/worktrees/feat-a').reason).toMatch(/not an absolute path/);
    expect(launch(`Lane: ${join(primary, '.claude', 'worktrees', 'nope')}`).reason).toMatch(/does not exist/);
    expect(launch(`Lane: ${primary}`).reason).toMatch(/primary checkout/);
    expect(launch(`Lane: ${home}`).reason).toMatch(/not inside a git checkout/);
  });

  it('denies a worktree under /tmp', () => {
    const v = decide(
      { tool_name: 'Agent', tool_input: { prompt: `Lane: ${lane}` } },
      { projectDir: primary, home, tempDirs: [base] },
    );
    expect(v.reason).toMatch(/temp directory/);
  });

  it('resolves the primary from a worktree', () => {
    expect(primaryRootOf(lane)).toBe(primary);
  });

  it('reminds on workflows and ignores other tools', () => {
    const wf = decide({ tool_name: 'Workflow', tool_input: {} }, { projectDir: primary, home });
    expect(wf.action).toBe('allow');
    expect(wf.context).toMatch(/worktree/);
    expect(decide({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { projectDir: primary, home })).toEqual({ action: 'allow' });
  });
});

describe('hook protocol', () => {
  const run = (event: unknown, env: Record<string, string> = {}) =>
    spawnSync('node', [hook], {
      input: typeof event === 'string' ? event : JSON.stringify(event),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: primary, HOME: home, PARALLEL_AGENTS_TEMP_DIRS: '', ...env },
    });

  it('exits 2 with the reason on stderr to deny', () => {
    const r = run({ tool_name: 'Agent', tool_input: { prompt: 'fix it' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Lane:/);
  });

  it('exits 0 with additionalContext JSON to allow', () => {
    const r = run({ tool_name: 'Agent', tool_input: { prompt: `Lane: ${lane}` } });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/parallel-agents/);
  });

  it('fails open on garbage and when switched off', () => {
    expect(run('not json').status).toBe(0);
    expect(run({ tool_name: 'Agent', tool_input: { prompt: 'fix it' } }, { PARALLEL_AGENTS_GUARD: 'off' }).status).toBe(0);
  });
});
