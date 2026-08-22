import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, derivedPort, devPort, previewPort } from '../port.mjs';

// Playwright reuses a dev server it finds already listening, so two checkouts
// on one port means one session's e2e run can test the other session's code
// with no warning. The port therefore has to be a function of the checkout —
// and has to be the same function for vite, Playwright and drive.mjs, which
// is why there is exactly one and these tests pin its contract.

// Fixture checkouts. A primary checkout has a .git DIRECTORY; a linked
// worktree has a .git FILE pointing back at it (what `git worktree add` writes).
const scratch = mkdtempSync(join(tmpdir(), 'apex-port-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function checkout(name: string, kind: 'primary' | 'worktree' | 'no-git'): string {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  if (kind === 'primary') mkdirSync(join(root, '.git'));
  if (kind === 'worktree') writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  return root;
}

const none = {};

describe('devPort', () => {
  it('lets APEX_PORT override everything', () => {
    const env = { APEX_PORT: '6100' };
    expect(devPort({ env, root: checkout('override-primary', 'primary') })).toBe(6100);
    expect(devPort({ env, root: checkout('override-worktree', 'worktree') })).toBe(6100);
  });

  it('refuses an APEX_PORT that is not a usable port', () => {
    const root = checkout('bad-override', 'worktree');
    for (const bad of ['abc', '80', '1023', '65536', '5173.5', '-5173', ' 5173', '0x1435']) {
      expect(() => devPort({ env: { APEX_PORT: bad }, root }), bad).toThrow(/APEX_PORT/);
    }
  });

  it('treats an empty APEX_PORT as unset', () => {
    expect(devPort({ env: { APEX_PORT: '' }, root: checkout('empty-override', 'primary') })).toBe(DEFAULT_PORT);
  });

  it('keeps 5173 in the primary checkout, so the README stays true', () => {
    expect(DEFAULT_PORT).toBe(5173);
    expect(devPort({ env: none, root: checkout('primary', 'primary') })).toBe(5173);
    // Not a worktree either: a tarball or CI artifact with no .git at all.
    expect(devPort({ env: none, root: checkout('plain', 'no-git') })).toBe(5173);
  });

  it('gives a worktree a port derived from its directory name, the same every time', () => {
    const root = checkout('chore-worktree-port-isolation', 'worktree');
    const port = devPort({ env: none, root });
    expect(port).toBe(derivedPort('chore-worktree-port-isolation'));
    expect(devPort({ env: none, root })).toBe(port);
    expect(port).not.toBe(DEFAULT_PORT);
  });

  it('gives two worktrees two ports', () => {
    const a = devPort({ env: none, root: checkout('feat-coros-sync', 'worktree') });
    const b = devPort({ env: none, root: checkout('fix-stranded-event-dates', 'worktree') });
    expect(a).not.toBe(b);
  });

  it('resolves this checkout without arguments', () => {
    const port = devPort();
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe('derivedPort', () => {
  it('stays inside 5200–5999, clear of 5173 and the local Supabase stack', () => {
    const names = Array.from({ length: 100 }, (_, i) => `feat-branch-${i}`);
    const ports = names.map(derivedPort);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(5200);
      expect(port).toBeLessThanOrEqual(5999);
    }
    // Spread, not just range: a hash that piled everything onto a few slots
    // would pass the bounds and still let sessions collide.
    expect(new Set(ports).size).toBeGreaterThan(85);
  });

  it('is deterministic', () => {
    expect(derivedPort('fix-stranded-event-dates')).toBe(derivedPort('fix-stranded-event-dates'));
  });
});

describe('previewPort', () => {
  it("sits one thousand below the dev port, so the primary checkout keeps Vite's 4173", () => {
    expect(previewPort({ env: none, root: checkout('preview-primary', 'primary') })).toBe(4173);
    const root = checkout('preview-worktree', 'worktree');
    expect(previewPort({ env: none, root })).toBe(devPort({ env: none, root }) - 1000);
    expect(previewPort({ env: { APEX_PORT: '6100' }, root })).toBe(5100);
  });
});
