import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain JS hook, run with bare node; no .d.mts on purpose (builtins only, like bash-guard)
import { changedSpecSlugs, decide, parseMilestones, parseProofs, sessionPaths, specProofGaps } from '../stop-gate.mjs';

// Check 3 of the Stop hook: a milestone checked off in docs/specs/<slug>/plan.md
// must have every requirement it delivers proven in validation.md. Its own
// file, with the same fixture shape as stop-gate.test.ts (bare origin, primary
// clone, one linked worktree) but none of its state, so the two can change
// independently.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'stop-gate-specs-')));
const origin = join(base, 'origin.git');
const primary = join(base, 'primary');
const lane = join(primary, '.claude', 'worktrees', 'feat-spec');
const sid = 'sess-spec';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
Object.assign(process.env, gitEnv);

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

beforeAll(() => {
  writeFileSync(join(base, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  git(base, 'init', '--bare', '-b', 'main', origin);
  const seed = join(base, 'seed');
  git(base, 'init', '-b', 'main', seed);
  writeFileSync(join(seed, 'README'), 'seed\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', origin, 'main');
  git(base, 'clone', '-q', origin, primary);
  mkdirSync(join(primary, '.claude', 'worktrees'), { recursive: true });
  git(primary, 'worktree', 'add', '-q', lane, '-b', 'feat/spec', 'origin/main');
  mkdirSync(dirname(sessionPaths(primary, sid).binding), { recursive: true });
  writeFileSync(sessionPaths(primary, sid).binding, lane + '\n');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

// Each case commits its files, so the proof check reads a fresh HEAD and the
// gate (always green here) is never cached from an earlier case.
function commit(files: Record<string, string | null>, msg: string) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(lane, rel);
    if (body === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
  }
  git(lane, 'add', '-A');
  git(lane, 'commit', '-q', '--allow-empty', '-m', msg);
}

type Gate = { ok: boolean; timedOut?: boolean; tail: string; cmd: string };
async function stop() {
  const calls: string[] = [];
  const run = async (wt: string): Promise<Gate> => {
    calls.push(wt);
    return { ok: true, timedOut: false, tail: 'all green', cmd: 'fake-gate' };
  };
  const v = await decide({ session_id: sid, cwd: primary, hook_event_name: 'Stop' }, { primary, run });
  return { ...v, gateRan: calls.length > 0 };
}

const plan = (m1: string, m2 = '- [ ] later') => `# Thing — plan

## Milestones

### M1 — first
Delivers: R1, R2
${m1}

### M2 — second
Delivers: R3
${m2}

## Decisions
- [x] not a milestone box: this list is under another heading
`;
const row = (id: string, status: string) => `| ${id} | some test | unit | ${status} |`;
const validation = (...rows: string[]) => `# Thing — validation

## Requirement proofs

| Req | Proof | Kind | Status |
|---|---|---|---|
${rows.join('\n')}

## Done means
`;

describe('reading the two documents', () => {
  it('parseMilestones: ids from the Delivers line, boxes until the next heading, template punctuation accepted', () => {
    const ms = parseMilestones(plan('- [x] a\n- [X] b\n  - [ ] nested', '**Delivers:** R4\n* [x] star'));
    expect(ms).toEqual([
      { id: 'M1', name: 'first', delivers: ['R1', 'R2'], boxes: 3, checked: 2 },
      { id: 'M2', name: 'second', delivers: ['R3', 'R4'], boxes: 1, checked: 1 },
    ]);
    expect(parseMilestones('### M3\n- [x] bare heading, no name\n')).toEqual([{ id: 'M3', name: '', delivers: [], boxes: 1, checked: 1 }]);
  });

  it('parseProofs: the Status cell per id; the template placeholder and "not proven" are unproven, "proven (PR #n)" is proven', () => {
    const { rows, malformed } = parseProofs(validation(row('R1', 'proven (PR #517)'), row('R2', 'not proven · proven (PR #)'), row('R3', 'Not proven')));
    expect(malformed).toBeNull();
    expect([...rows.entries()]).toEqual([
      ['R1', 'proven (PR #517)'],
      ['R2', 'not proven · proven (PR #)'],
      ['R3', 'Not proven'],
    ]);
    const g = specProofGaps({ plan: plan('- [x] done', '- [x] done'), validation: validation(row('R1', 'proven (PR #517)'), row('R2', 'not proven')) });
    expect(g.gaps).toEqual([
      { milestone: 'M1', name: 'first', unproven: ['R2'] },
      { milestone: 'M2', name: 'second', unproven: ['R3'] }, // no row at all
    ]);
  });

  it('a table without Req and Status columns is malformed; a prose file has no table at all', () => {
    expect(parseProofs('| Requirement | Proof | Status |\n|---|---|---|\n| R1 | t | proven |\n').rows.get('R1')).toBe('proven');
    expect(parseProofs('| Name | Proof | Done |\n|---|---|---|\n| R1 | t | yes |\n').malformed).toMatch(/Req and Status/);
    expect(parseProofs('R1 is proven, trust me\n').malformed).toMatch(/Req and Status/);
  });

  it('review probes: sub-headings, CRLF, fences, numbered and list-form lines, a parenthetical on Delivers', () => {
    const m = parseMilestones(
      ['### M1 — one', '- **Delivers:** R1, R2 (R3 moves to M2)', '#### Acceptance', '```', '- [ ] an example, not a box', '```', '1. [x] a', '2. [X] b', '### M2 — two', 'Delivers: R3', '- [x] c'].join('\r\n') + '\r\n',
    );
    expect(m).toEqual([
      { id: 'M1', name: 'one', delivers: ['R1', 'R2'], boxes: 2, checked: 2 },
      { id: 'M2', name: 'two', delivers: ['R3'], boxes: 1, checked: 1 },
    ]);
  });

  it('review probes: escaped pipes, no outer pipes, bold header, short delimiter, Status suffix, bold status, two tables', () => {
    const file = [
      '**Req** | Proof | Status (PR)',
      '-|-|-',
      'R1 | `lsof -i \\| grep` | **proven** (PR #1)',
      '',
      '| Req | Proof | Kind | Status |',
      '|---|---|---|---|',
      '| R2 | t | unit | not proven |',
      '',
    ].join('\n');
    const { rows, malformed } = parseProofs(file);
    expect(malformed).toBeNull();
    expect(rows.get('R1')).toBe('**proven** (PR #1)');
    expect(rows.get('R2')).toBe('not proven');
    expect(specProofGaps({ plan: '### M1\nDelivers: R1, R2\n- [x] a\n', validation: file }).gaps).toEqual([{ milestone: 'M1', name: '', unproven: ['R2'] }]);
  });

  it('a milestone with no boxes, or no Delivers line, claims nothing', () => {
    const none = validation(row('R9', 'not proven'));
    expect(specProofGaps({ plan: '### M1 — empty\nDelivers: R1\n', validation: none }).gaps).toEqual([]);
    expect(specProofGaps({ plan: '### M1 — undeclared\n- [x] done\n', validation: none }).gaps).toEqual([]);
  });
});

describe('in the stop decision', () => {
  it('no spec folder on the branch: the check never runs, the gate does', async () => {
    commit({ 'src/x.ts': 'export {};\n' }, 'code only');
    const v = await stop();
    expect(v.gateRan).toBe(true);
    expect(v.action).toBe('block');
    expect(v.reason).toMatch(/not on origin/); // the push check, nothing about proofs
    expect(v.reason).not.toMatch(/prove/);
    expect(v.notes).toEqual([]);
  });

  it('the template folder and an old single-file spec are not feature folders', async () => {
    commit({ 'docs/specs/_template/plan.md': plan('- [x] done'), 'docs/specs/_template/validation.md': validation(), 'docs/specs/old.md': '- [x] M1\n' }, 'template');
    expect(changedSpecSlugs(lane)).toEqual([]);
    const v = await stop();
    expect(v.gateRan).toBe(true);
    expect(v.reason).not.toMatch(/prove/);
  });

  it('a checked milestone with every row proven passes to the gate', async () => {
    commit(
      { 'docs/specs/thing/plan.md': plan('- [x] a\n- [x] b'), 'docs/specs/thing/validation.md': validation(row('R1', 'proven (PR #1)'), row('R2', 'proven (PR #1)')) },
      'm1 proven',
    );
    expect(changedSpecSlugs(lane)).toEqual(['thing']);
    const v = await stop();
    expect(v.gateRan).toBe(true);
    expect(v.reason).toMatch(/not on origin/);
    expect(v.notes).toEqual([]);
  });

  it('a checked milestone with one row not proven is refused before the gate, naming slug, milestone and ids', async () => {
    commit({ 'docs/specs/thing/validation.md': validation(row('R1', 'proven (PR #1)'), row('R2', 'not proven')) }, 'm1 half proven');
    const v = await stop();
    expect(v.gateRan).toBe(false);
    expect(v.action).toBe('block');
    expect(v.reason).toContain(`stop-gate (${lane})`);
    expect(v.reason).toContain('docs/specs/thing: M1 (first) has every box checked, but validation.md does not prove R2');
    expect(v.reason).not.toMatch(/prove R1\b/);
    expect(v.reason).toMatch(/Status begins with "proven"/);
  });

  it('an unchecked milestone claims nothing, whatever its rows say', async () => {
    commit({ 'docs/specs/thing/plan.md': plan('- [x] a\n- [ ] b') }, 'm1 half done');
    const v = await stop();
    expect(v.gateRan).toBe(true);
    expect(v.reason).not.toMatch(/prove/);
  });

  it('a malformed table stands aside with a note and lets the gate run', async () => {
    commit({ 'docs/specs/thing/plan.md': plan('- [x] a\n- [x] b'), 'docs/specs/thing/validation.md': '# Thing — validation\n\nR1 and R2 are proven, trust me.\n' }, 'malformed');
    const v = await stop();
    expect(v.gateRan).toBe(true);
    expect(v.reason).toMatch(/not on origin/);
    expect(v.notes).toEqual([`${lane}: docs/specs/thing/validation.md: no table with Req and Status columns; the proof check stood aside`]);
  });

  it('a missing validation.md proves nothing: refused, saying the file is missing', async () => {
    commit({ 'docs/specs/thing/validation.md': null }, 'no validation');
    const v = await stop();
    expect(v.gateRan).toBe(false);
    expect(v.reason).toContain('validation.md is missing, so nothing proves R1, R2');
  });

  it('a second feature folder on the same branch is judged too; a folder without plan.md is skipped', async () => {
    commit(
      {
        'docs/specs/thing/validation.md': validation(row('R1', 'proven (PR #1)'), row('R2', 'proven (PR #1)')),
        'docs/specs/other/plan.md': plan('- [ ] a', '- [x] b'),
        'docs/specs/other/validation.md': validation(row('R3', 'not proven')),
        'docs/specs/notes-only/notes.md': 'no plan here\n',
      },
      'two folders',
    );
    expect(changedSpecSlugs(lane)).toEqual(['notes-only', 'other', 'thing']);
    const v = await stop();
    expect(v.gateRan).toBe(false);
    expect(v.reason).toContain('docs/specs/other: M2 (second) has every box checked, but validation.md does not prove R3');
    expect(v.reason).not.toContain('docs/specs/thing');
  });

  it('`blocked` still lets one stop through past unproven rows', async () => {
    const sp = sessionPaths(primary, sid);
    mkdirSync(sp.dir, { recursive: true });
    writeFileSync(sp.blocked, 'needs Shane\n');
    expect((await stop()).action).toBe('allow');
    expect((await stop()).action).toBe('block');
  });
});
