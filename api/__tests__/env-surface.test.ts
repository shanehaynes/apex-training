import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, normalize, relative } from 'node:path';
import { ENV_KEYS } from '../_lib/env';

// Every environment variable the API reads used to be a bare process.env.X
// at its point of use — a dozen sites, each with its own missing/empty
// handling, and nothing that said which variables a deployment needs.
// .env.example drifted from the code because nothing compared them.
//
// api/_lib/env.ts is now the one place that reads process.env, and ENV_KEYS
// in it is the inventory. This test pins both halves: no runtime file under
// api/ may read process.env directly (so a new variable has to be added to
// the inventory to be read at all), and the inventory must agree with
// .env.example in both directions (so a variable the code needs is
// documented, and a documented server variable is one the code still reads).
// It is a source walk rather than a runtime check because the failure it
// guards — a deploy missing a variable nobody wrote down — never shows up in
// a test environment that happens to have it set.

const ROOT = normalize(join(__dirname, '..', '..'));
const API = join(ROOT, 'api');
const ENV_MODULE = join(API, '_lib', 'env.ts');
const ENV_EXAMPLE = join(ROOT, '.env.example');

// Keys the API reads that deliberately do not appear in .env.example. Add
// to this only for a variable that genuinely must not be suggested to a
// local developer, and say why.
const NOT_IN_ENV_EXAMPLE = new Set<string>([
  // Injected by Vercel on every deployment, never set by hand; a .env.example
  // line would invite a local value that makes /api/version lie.
  'VERCEL_GIT_COMMIT_SHA',
]);

function runtimeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : runtimeFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

/** `KEY=` lines in .env.example, including commented-out ones (`# KEY=`). */
function documentedKeys(): string[] {
  return readFileSync(ENV_EXAMPLE, 'utf8')
    .split('\n')
    .map(line => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((k): k is string => k !== undefined);
}

describe('api environment surface', () => {
  const files = runtimeFiles(API).filter(f => f !== ENV_MODULE);

  it('reads process.env only through api/_lib/env.ts', () => {
    const offenders = files
      .filter(f => readFileSync(f, 'utf8').includes('process.env'))
      .map(f => relative(ROOT, f));
    // Sanity: the walk found the runtime tree (not an empty or wrong dir).
    expect(files.length).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('documents every key the API reads in .env.example', () => {
    const documented = new Set(documentedKeys());
    const missing = ENV_KEYS.filter(k => !documented.has(k) && !NOT_IN_ENV_EXAMPLE.has(k));
    expect(missing).toEqual([]);
  });

  it('reads every server-side key that .env.example documents', () => {
    // VITE_-prefixed keys may be client-only config (the anon key is), so
    // only unprefixed ones are required to have a reader in api/.
    const known = new Set<string>(ENV_KEYS);
    const stale = documentedKeys().filter(k => !k.startsWith('VITE_') && !known.has(k));
    expect(stale).toEqual([]);
  });

  it('has a reader for every key in ENV_KEYS', () => {
    // The inventory is only an inventory while each entry is still read
    // somewhere; a key nobody reads is a documented variable that does nothing.
    const sources = files.map(f => readFileSync(f, 'utf8')).join('\n');
    const unread = ENV_KEYS.filter(k => !sources.includes(`'${k}'`));
    expect(unread).toEqual([]);
  });
});
