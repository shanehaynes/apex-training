// The dev-server port for THIS checkout. vite.config.ts, playwright.config.ts
// and scripts/drive.mjs all read it, so the three can never disagree.
//
// Several sessions work in this repo at once, each in its own worktree, and
// Playwright reuses any dev server it finds already listening. With one fixed
// port, session B's e2e run could land on session A's server and test A's
// code — no error, no warning. Deriving the port from the worktree makes that
// collision impossible instead of merely documented.
//
// Resolution:
//   1. APEX_PORT, if set — an explicit override (1024–65535, anything else
//      throws rather than quietly falling through).
//   2. 5173 in the primary checkout, where .git is a directory, so the README,
//      .claude/launch.json and supabase/config.toml's site_url stay true there.
//   3. Otherwise a port in 5200–5999 hashed from the worktree's directory name:
//      the same every time for one worktree, almost certainly different for
//      two. Nowhere near the local Supabase stack (54321–54324).
//
// Plain JS because scripts/drive.mjs imports it at runtime; port.d.mts gives
// the TypeScript callers their types.

import { statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 5173;
const DERIVED_MIN = 5200;
const DERIVED_MAX = 5999;

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseOverride(value) {
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`APEX_PORT must be an integer from 1024 to 65535, got "${value}"`);
  }
  return n;
}

// `git worktree add` writes .git as a FILE ("gitdir: ...") pointing back at
// the primary checkout, where .git is a directory. No .git at all (a tarball,
// a CI artifact) is not a worktree either.
function isLinkedWorktree(root) {
  try {
    return statSync(resolve(root, '.git')).isFile();
  } catch {
    return false;
  }
}

// FNV-1a, 32-bit. Not cryptographic — it only has to spread names over ~800
// slots and give the same answer tomorrow.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function derivedPort(name) {
  return DERIVED_MIN + (hash(name) % (DERIVED_MAX - DERIVED_MIN + 1));
}

export function devPort({ env = process.env, root = REPO_ROOT } = {}) {
  const override = env.APEX_PORT;
  if (override !== undefined && override !== '') return parseOverride(override);
  if (!isLinkedWorktree(root)) return DEFAULT_PORT;
  return derivedPort(basename(resolve(root)));
}

// `vite preview` defaults to 4173 and is shared across worktrees the same
// way. One thousand below the dev port keeps the primary checkout on Vite's
// defaults for both and gives worktrees 4200–4999.
export function previewPort(options) {
  return devPort(options) - 1000;
}

// `npm run -s port` prints it, so the docs can say `lsof -i :$(npm run -s port)`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(devPort());
}
