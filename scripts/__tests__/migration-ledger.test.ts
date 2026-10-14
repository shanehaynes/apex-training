import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stampFor } from '../prod-schema-check.mjs';

// Production records which migrations ran in public.migration_ledger
// (phase56). Each migration stamps itself as its LAST statement, so a stamp
// means the whole file ran, and scripts/prod-schema-check.mjs names every
// migration on main that production has no stamp for. That only works while
// every migration carries its stamp — this is what makes forgetting it fail CI
// rather than read as "never applied" in production.

const DIR = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));
const LEDGER_PHASE = 56;
const LEDGER_FILE = 'phase56_migration_ledger.sql';

const migrations = readdirSync(DIR)
  .map((file) => ({ file, n: Number(/^phase(\d+)_.*\.sql$/.exec(file)?.[1]) }))
  .filter((m) => Number.isInteger(m.n));

/** The file with trailing blank lines and trailing `--` comment lines dropped. */
function tail(sql: string): string {
  const lines = sql.split('\n');
  while (lines.length > 0 && (lines.at(-1)!.trim() === '' || lines.at(-1)!.trim().startsWith('--'))) lines.pop();
  return lines.join('\n').trimEnd();
}

describe('migration ledger stamps', () => {
  it('every migration from the ledger on ends with its own stamp', () => {
    const later = migrations.filter((m) => m.n >= LEDGER_PHASE);
    // Proves the scan found the ledger migration: a rename would pass vacuously.
    expect(later.map((m) => m.file)).toContain(LEDGER_FILE);

    const unstamped = later
      .filter((m) => !tail(readFileSync(join(DIR, m.file), 'utf8')).endsWith(stampFor(m.file)))
      .map((m) => `  ${m.file} — end it with:\n    ${stampFor(m.file)}`);
    expect(
      unstamped.join('\n'),
      'a migration must end with its own ledger stamp, as its last statement, so production records that the whole '
        + 'file ran (CONTRIBUTING.md, "The schema types are generated, and checked")',
    ).toBe('');
  });

  it('the ledger migration backfills every migration that predates it', () => {
    const ledger = readFileSync(join(DIR, LEDGER_FILE), 'utf8');
    const earlier = migrations.filter((m) => m.n < LEDGER_PHASE);
    expect(earlier.length).toBeGreaterThan(50);
    const missing = earlier
      .map((m) => m.file.replace(/\.sql$/, ''))
      .filter((name) => !ledger.includes(`('${name}')`));
    expect(missing).toEqual([]);
  });

  it('stampFor names the file without .sql, in the exact statement the check reads', () => {
    expect(stampFor('phase57_example.sql')).toBe(
      "insert into public.migration_ledger (name) values ('phase57_example') on conflict do nothing;",
    );
  });
});
