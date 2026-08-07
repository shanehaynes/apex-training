import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

// Every file reachable from api/ runs under REAL Node ESM resolution on
// Vercel (/var/task keeps the traced sources), where a relative import
// without a .js extension is ERR_MODULE_NOT_FOUND at cold start — killing
// every route the function serves. Nothing else catches this: tsc
// (moduleResolution bundler), vitest, tsx, and vite all resolve
// extensionless specifiers happily. This test walks the api import graph
// and pins the convention. (Client-only src/ files may stay extensionless —
// vite bundles them — which is why this walks reachability instead of
// grepping the whole tree.)

const IMPORT_RE =
  /^import\s+(?!type[\s{])[^;]*?from\s+['"]([^'"]+)['"]|^export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm;

const ROOT = normalize(join(__dirname, '..', '..'));

function resolveRelative(fromFile: string, spec: string): string | null {
  let p = normalize(join(dirname(fromFile), spec));
  if (p.endsWith('.js')) p = `${p.slice(0, -3)}.ts`;
  for (const cand of [p, `${p}.ts`, `${p}.tsx`, join(p, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function apiEntryFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : apiEntryFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

describe('api runtime import graph', () => {
  it('uses explicit .js extensions on every relative runtime import', () => {
    const seen = new Set<string>();
    const violations: string[] = [];
    const stack = apiEntryFiles(join(ROOT, 'api'));

    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec || !spec.startsWith('.')) continue;
        if (!spec.endsWith('.js') && !spec.endsWith('.json')) {
          violations.push(`${file.slice(ROOT.length + 1)} imports '${spec}' without a .js extension`);
        }
        const target = resolveRelative(file, spec);
        if (target) stack.push(target);
      }
    }

    // Sanity: the walk actually traversed into src/ (the graph the trap lives in).
    expect([...seen].some(f => f.includes(`${join('src', 'lib')}`))).toBe(true);
    expect(violations).toEqual([]);
  });
});
