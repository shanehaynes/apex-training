import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The unattended grant is exactly two strings. A prefix or wildcard would also
// grant --no-check (the union proof skipped on the operator's word) and any
// flag added later; widening it is Shane's call, made here on purpose.
describe('.claude/settings.json grants exactly the two merge-loop invocations', () => {
  const settings = JSON.parse(readFileSync(new URL('../../.claude/settings.json', import.meta.url), 'utf8'));

  it('allow is exactly the two strings', () => {
    expect(settings.permissions?.allow).toEqual([
      'Bash(scripts/merge-babysit.sh --yes)',
      'Bash(scripts/merge-babysit.sh --fleet --yes)',
    ]);
  });

  it('no rule anywhere names the automation with a wildcard', () => {
    const rules = [...(settings.permissions?.allow ?? []), ...(settings.permissions?.ask ?? [])];
    for (const r of rules) expect(r, r).not.toMatch(/\*/);
  });
});
