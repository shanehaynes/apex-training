// The RLS posture, asserted mechanically against the LOCAL Supabase stack.
//
// WHY THIS EXISTS
// Every policy in this database is SELECT-only and every public table has RLS
// on — and until now nothing checked it. phase42_phase32_quarantine_rls.sql
// records that this exact mistake already shipped: a table created with RLS
// off while `anon` held SELECT/INSERT/DELETE on it, sitting in production for
// weeks. REST cannot find that on its own, because an RLS-off table and an
// empty one both answer `200 []`, so scripts/prod-schema-check.mjs is blind to
// it by construction. The catalog is not blind, and the `full` CI job already
// has a database built from every migration — this is that check.
//
// Realtime makes the stakes concrete. realtime.apply_rls() evaluates the
// SELECT policy per WAL row as `authenticated`, so a published table with RLS
// OFF broadcasts every row of every user to every subscriber. (A published
// table with RLS on and no policy broadcasts to nobody — visible, not a leak.)
//
// WHAT IT ASSERTS
//   1. No policy in `public` grants anything but SELECT to anon/authenticated.
//   2. relrowsecurity is true for every base table in `public`.
//   3. Every table published to `supabase_realtime` has RLS on and at least
//      one FOR SELECT policy.
//   4. anon and authenticated hold no write grant in `public`, and anon holds
//      no grant at all — the posture supabase/config.toml's
//      `auto_expose_new_tables = false` exists to keep.
//
// Requires: supabase start + scripts/db-reset-local.sh, then
//   APEX_LOCAL_SUPABASE=1 vitest run api/__tests__/integration
// Skipped instantly when APEX_LOCAL_SUPABASE is unset.
//
// The catalog is read with psql inside the stack's own database container —
// PostgREST cannot reach pg_catalog, and there is no Postgres driver in
// package.json to add one to. The container is resolved through
// scripts/lib/project-id.sh so this can only ever read THIS project's stack,
// never a neighbouring project's (see that file's header).

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';

const RUN = !!process.env.APEX_LOCAL_SUPABASE;

/** Roles a browser or an iOS client can reach the database as. */
const CLIENT_ROLES = ['anon', 'authenticated'];

let container = '';

/**
 * Run one query and return its rows as `|`-joined fields.
 * -A -t -X: unaligned, tuples only, no ~/.psqlrc. ON_ERROR_STOP so a typo in
 * the SQL fails the test instead of yielding zero rows and "passing".
 */
function rows(sql: string): string[] {
  const out = execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-qAtX', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', sql],
    { encoding: 'utf8' },
  );
  return out.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * Base tables in `public` that the repo's own migrations own — the same
 * exclusion scripts/db-reset-local.sh uses when it drops them. Anything an
 * extension brought with it (btree_gist lives in public here) is not ours to
 * put RLS on.
 */
const OUR_TABLES = `
  SELECT c.relname, c.relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e', 'i'))
  ORDER BY c.relname`;

describe.skipIf(!RUN)('RLS posture of the local stack', () => {
  beforeAll(() => {
    // The canonical, project-scoped lookup, reused rather than reimplemented.
    container = execFileSync('bash', ['-c', '. scripts/lib/project-id.sh && apex_container db'], {
      encoding: 'utf8',
    }).trim();
    expect(
      container,
      'the local Supabase database container is not running — run `supabase start`',
    ).not.toBe('');
  });

  it('has tables to check at all', () => {
    // A guard on the guard: every assertion below is "no rows match", which a
    // database with no tables in it would pass.
    expect(rows(OUR_TABLES).length).toBeGreaterThan(20);
  });

  it('grants nothing but SELECT to anon or authenticated in any policy', () => {
    // `cmd` is ALL / SELECT / INSERT / UPDATE / DELETE. A policy with no TO
    // clause lands on the `public` role, which every client role inherits, so
    // it counts as reaching anon and authenticated.
    const offenders = rows(`
      SELECT tablename || '.' || policyname || ' FOR ' || cmd || ' TO ' || array_to_string(roles, ',')
      FROM pg_policies
      WHERE schemaname = 'public'
        AND cmd <> 'SELECT'
        AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
      ORDER BY 1`);
    expect(offenders, 'client roles may only ever be given SELECT; writes go through the API').toEqual([]);
  });

  it('has row level security enabled on every public table', () => {
    const off = rows(`SELECT relname FROM (${OUR_TABLES}) t WHERE NOT relrowsecurity`);
    expect(off, 'a public table with RLS off is readable by anyone holding the anon key').toEqual([]);
  });

  it('publishes to realtime only tables with RLS on and a SELECT policy', () => {
    // realtime.apply_rls() filters each WAL row through the SELECT policy as
    // `authenticated`; with RLS off there is nothing to filter through.
    const bad = rows(`
      SELECT pt.tablename || ': ' ||
             CASE WHEN NOT c.relrowsecurity THEN 'RLS off' ELSE 'no FOR SELECT policy' END
      FROM pg_publication_tables pt
      JOIN pg_class c ON c.relname = pt.tablename
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = pt.schemaname
      WHERE pt.pubname = 'supabase_realtime' AND pt.schemaname = 'public'
        AND (NOT c.relrowsecurity
             OR NOT EXISTS (SELECT 1 FROM pg_policies p
               WHERE p.schemaname = pt.schemaname AND p.tablename = pt.tablename
                 AND p.cmd IN ('SELECT', 'ALL')))
      ORDER BY 1`);
    expect(bad, 'every realtime-published table must filter its WAL rows through a SELECT policy').toEqual([]);
  });

  it('publishes nothing to realtime from outside public', () => {
    // A table added to the publication from another schema would bypass the
    // check above entirely. realtime's own messages publication is separate.
    const foreign = rows(`
      SELECT schemaname || '.' || tablename FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname <> 'public' ORDER BY 1`);
    expect(foreign).toEqual([]);
  });

  it('gives anon and authenticated no write grant, and anon no grant at all', () => {
    // RLS is the second lock, not the first. Writes are the API's job (it
    // holds the service-role key), and the anon role exists only to sign in.
    const grants = rows(`
      SELECT grantee || ' ' || privilege_type || ' ON ' || table_name
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND grantee IN (${CLIENT_ROLES.map(r => `'${r}'`).join(', ')})
        AND (grantee = 'anon' OR privilege_type <> 'SELECT')
      ORDER BY 1`);
    expect(grants, 'see the GRANT block in the latest migration; anon writes are how the phase42 leak happened').toEqual([]);
  });
});
