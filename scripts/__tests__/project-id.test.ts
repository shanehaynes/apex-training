import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// Container lookups must be scoped to THIS project. One Docker daemon serves
// every project on this machine, so an unscoped `grep '^supabase_db_'` can
// match a different project's database — and db-reset-local.sh would truncate
// it, with no error. These tests pin the scoping.

const lib = fileURLToPath(new URL('../lib/project-id.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'project-id-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A stand-in `docker` so the suite runs with no daemon (and in CI). It prints
// a two-project container list: ours, a neighbour, and a project whose id is a
// PREFIX of ours — the case a prefix match would get wrong.
const binDir = join(root, 'bin');
mkdirSync(binDir, { recursive: true });
writeFileSync(
  join(binDir, 'docker'),
  [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  if [ "$a" = "-a" ]; then',
    '    printf "%s\\n" \\',
    '      "supabase_db_apex-training running" \\',
    '      "supabase_edge_runtime_apex-training exited" \\',
    '      "supabase_db_scout exited" \\',
    '      "supabase_db_apex exited"',
    '    exit 0',
    '  fi',
    'done',
    'printf "%s\\n" \\',
    '  "supabase_db_apex-training" \\',
    '  "supabase_auth_apex-training" \\',
    '  "supabase_db_scout" \\',
    '  "supabase_db_apex"',
  ].join('\n') + '\n',
  { mode: 0o755 },
);
chmodSync(join(binDir, 'docker'), 0o755);

/** Source the lib in `cwd` and evaluate one expression. */
function sh(expr: string, cwd: string) {
  return spawnSync('bash', ['-c', `. "${lib}"; ${expr}`], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });
}

/** A project directory whose supabase/config.toml declares `id`. */
function project(name: string, id: string | null) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'supabase'), { recursive: true });
  writeFileSync(
    join(dir, 'supabase', 'config.toml'),
    id === null ? '# no project_id here\n' : `# a comment\nproject_id = "${id}"\n[api]\nport = 54321\n`,
  );
  return dir;
}

const ours = project('apex-training', 'apex-training');

describe('apex_project_id', () => {
  it('reads project_id out of supabase/config.toml', () => {
    expect(sh('apex_project_id', ours).stdout).toBe('apex-training');
  });

  it('fails loudly rather than guessing when project_id is absent', () => {
    const r = sh('apex_project_id', project('no-id', null));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing to guess/);
  });
});

describe('apex_container', () => {
  it('returns this project’s container', () => {
    expect(sh('apex_container db', ours).stdout.trim()).toBe('supabase_db_apex-training');
  });

  it('never returns another project’s container', () => {
    // The regression: `grep '^supabase_db_' | head -1` returned whichever
    // Docker listed first, so this is the assertion that matters.
    const out = sh('apex_container db', ours).stdout;
    expect(out).not.toMatch(/scout/);
    expect(out.trim().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('does not cross-match a project whose id is a prefix of ours', () => {
    // supabase_db_apex vs supabase_db_apex-training: an anchored prefix match
    // would accept both. `grep -x` is what makes this exact.
    expect(sh('apex_container db', project('apex', 'apex')).stdout.trim())
      .toBe('supabase_db_apex');
  });

  it('returns nothing, successfully, when the service is not running', () => {
    const r = sh('apex_container storage', ours);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});

describe('apex_stopped_containers', () => {
  it('lists only this project’s stopped containers', () => {
    const lines = sh('apex_stopped_containers', ours).stdout.trim().split('\n').filter(Boolean);
    expect(lines).toEqual(['supabase_edge_runtime_apex-training']);
  });

  it('does not offer to restart a neighbouring project’s containers', () => {
    expect(sh('apex_stopped_containers', ours).stdout).not.toMatch(/scout|_apex$/m);
  });
});
