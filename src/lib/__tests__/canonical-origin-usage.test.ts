import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// publicOrigin() exists because window.location.origin is wrong for any URL
// that leaves the browser, and the two are indistinguishable in local dev and
// e2e: VITE_PUBLIC_ORIGIN is unset there, so publicOrigin() returns exactly
// window.location.origin and a wrong call site looks correct everywhere it is
// cheap to test. It only diverges on a real deployment.
//
// ConnectorGuide shipped with the raw form for that reason — the e2e spec that
// compares its endpoint against the AI connector section's passed, because both
// sides agreed on the fallback. So guard the invariant at the source instead:
// src/lib/origin.ts is the one place allowed to read window.location.origin.

const SRC = new URL('../../', import.meta.url).pathname;
const ALLOWED = 'lib/origin.ts';

function tsFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') tsFiles(full, found);
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe('canonical origin', () => {
  it('is read from window.location.origin only inside lib/origin.ts', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.endsWith(ALLOWED))
      .filter((f) => /window\.location\.origin/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length));

    expect(
      offenders,
      'these read window.location.origin directly; use publicOrigin() from lib/origin.ts',
    ).toEqual([]);
  });
});
