import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fingerprint, parseStamp, stampFor, statements } from '../prod-schema-check.mjs';

// Production records which migrations ran, as written, in
// public.migration_ledger (phase56). Each migration stamps its name and a
// fingerprint of its SQL as its LAST statement, so a stamp means the whole
// file ran, and scripts/prod-schema-check.mjs names every migration on main
// production has not applied as written. That only works while every
// migration carries a true stamp — this is what makes a missing or stale one
// fail CI instead of reading as "never applied" in production.

const DIR = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));
const LEDGER_FILE = 'phase56_migration_ledger.sql';
const read = (file: string) => readFileSync(join(DIR, file), 'utf8');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
const stem = (file: string) => file.replace(/\.sql$/, '');

/** name → fingerprint from the ledger migration's backfill, parsed rather than grepped. */
function backfill(): Map<string, string> {
  const stmts = statements(read(LEDGER_FILE)).slice(0, -1); // the last is its own stamp
  const insert = stmts.filter((s: string) => /^insert\s+into\s+public\.migration_ledger\b/i.test(s));
  expect(insert, 'the ledger migration has exactly one backfill insert').toHaveLength(1);
  return new Map([...insert[0].matchAll(/\(\s*'([^']+)'\s*,\s*'([0-9a-f]{16})'\s*\)/g)].map((m) => [m[1], m[2]]));
}

describe('migration ledger stamps', () => {
  it('every migration the backfill does not cover ends with its own, current stamp', () => {
    const covered = backfill();
    const later = files.filter((f) => !covered.has(stem(f)));
    // Proves the scan found the ledger migration: a rename would pass vacuously.
    expect(later).toContain(LEDGER_FILE);

    const wrong = later.flatMap((file) => {
      const sql = read(file);
      const last = parseStamp(statements(sql).at(-1) ?? '');
      const ok = last?.name === stem(file) && last.fingerprint === fingerprint(sql);
      return ok ? [] : [`  ${file} — its last statement must be:\n    ${stampFor(file, sql)}`];
    });
    expect(
      wrong.join('\n'),
      'a migration must end with its own ledger stamp, and the fingerprint must match its SQL, so production records '
        + 'that the whole file ran as written (`node scripts/prod-schema-check.mjs --stamp <file>` prints the line; '
        + 'CONTRIBUTING.md, "The schema types are generated, and checked")',
    ).toBe('');
  });

  it('backfills every migration that predates the ledger, and none of those has been edited since', () => {
    const covered = backfill();
    expect(covered.size).toBeGreaterThan(50);
    const ledgerPhase = 56;
    const earlier = files.filter((f) => Number(/^phase(\d+)_/.exec(f)?.[1]) < ledgerPhase);
    const uncovered = earlier.filter((f) => !covered.has(stem(f)) && !parseStamp(statements(read(f)).at(-1) ?? ''));
    expect(uncovered, 'an old migration neither backfilled nor stamping itself').toEqual([]);

    const edited = [...covered]
      .filter(([name, fp]) => files.includes(`${name}.sql`) && fingerprint(read(`${name}.sql`)) !== fp)
      .map(([name, fp]) => `  ${name}.sql was applied as ${fp}; it is now ${fingerprint(read(`${name}.sql`))}`);
    expect(
      edited.join('\n'),
      'production already ran these migrations as backfilled: write a new migration instead of editing an applied one '
        + '(comments and whitespace are free; SQL is not)',
    ).toBe('');
  });

  it('a fingerprint ignores comments, whitespace and the trailing stamp, and nothing else', () => {
    const base = 'alter table t add column c int;\n';
    const fp = fingerprint(base);
    expect(fingerprint(`-- a comment\n${base}\n\n/* another */`)).toBe(fp);
    expect(fingerprint('alter  table t\n  add column c int;')).toBe(fp);
    expect(fingerprint(`${base}${stampFor('phase57_x.sql', base)}\n`)).toBe(fp);
    expect(fingerprint('alter table t add column c bigint;')).not.toBe(fp);
    // A stamp is only stripped when it is last: one mid-file is SQL like any other.
    expect(fingerprint(`${stampFor('phase57_x.sql', base)}\n${base}`)).not.toBe(fp);
    expect(stampFor('phase57_x.sql', base)).toBe(
      `insert into public.migration_ledger (name, fingerprint) values ('phase57_x', '${fp}') on conflict do nothing;`,
    );
  });
});
