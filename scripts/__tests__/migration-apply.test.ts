import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCredentials, applyMigrations, existenceSql, fillInverse } from '../migration-apply.mjs';
import { stampFor } from '../prod-schema-check.mjs';

const REF = 'abcdefghijklmnopqrst';
const URL_ = `https://${REF}.supabase.co`;
const creds = { url: URL_, projectRef: REF, token: 'sbp_test' };
const mig = (file: string, body: string) => ({ file, sql: `${body}\n${stampFor(file, body)}\n` });

const ADD_COL = mig('phase60_add_col.sql', 'alter table profiles add column if not exists tz text;');
const REPLACE_CHECK = mig(
  'phase61_mode.sql',
  "alter table coach_runs drop constraint if exists coach_runs_mode_check;\nalter table coach_runs add constraint coach_runs_mode_check check (mode in ('a', 'b'));",
);

/** A Management API that answers probes with `found`, previous CHECKs with `previous`, and records every query. */
function fakeApi({ found = [] as unknown[], previous = [] as unknown[], fail = null as null | { status: number; body: unknown } } = {}) {
  const queries: string[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    expect(url).toBe(`https://api.supabase.com/v1/projects/${REF}/database/query`);
    expect(init.headers.authorization).toBe('Bearer sbp_test');
    const { query } = JSON.parse(init.body) as { query: string };
    queries.push(query);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (query.includes("as found where") || query.startsWith("select 'index") || query.startsWith("select 'column") || query.startsWith("select 'constraint")) return json(200, found);
    if (query.includes('pg_get_constraintdef')) return json(200, previous);
    if (fail) return json(fail.status, fail.body);
    return json(201, []);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, queries };
}

const run = async (files: { file: string; sql: string }[], api: ReturnType<typeof fakeApi>) => {
  const lines: string[] = [];
  const saved: Record<string, string> = {};
  const code = await applyMigrations({ files, creds, fetch: api.fetch, log: (l: string) => lines.push(l), saveInverse: (f: string, inv: string) => { saved[f] = inv; } });
  return { code, out: lines.join('\n'), saved };
};

describe('applyMigrations', () => {
  it('probes, applies the file as written, and keeps its inverse', async () => {
    const api = fakeApi();
    const r = await run([ADD_COL], api);
    expect(r.code).toBe(0);
    expect(api.queries.at(-1)).toBe(ADD_COL.sql);
    expect(r.out).toContain('APPLIED phase60_add_col.sql');
    expect(r.saved['phase60_add_col.sql']).toContain('alter table public.profiles drop column if exists tz;');
  });

  it('refuses a non-additive file before touching production', async () => {
    const api = fakeApi();
    const r = await run([ADD_COL, mig('phase61_bad.sql', 'drop table profiles;')], api);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/REFUSE phase61_bad\.sql — not additive/);
    expect(api.queries).toEqual([]);
  });

  it('refuses when an object it creates already exists, since the inverse would drop it', async () => {
    const api = fakeApi({ found: [{ found: 'column profiles.tz' }] });
    const r = await run([ADD_COL], api);
    expect(r.code).toBe(4);
    expect(r.out).toContain('already in production');
    expect(api.queries).toHaveLength(1);
  });

  it('fills a replaced CHECK from production before applying', async () => {
    const api = fakeApi({ previous: [{ tbl: 'coach_runs', name: 'coach_runs_mode_check', def: "CHECK ((mode = 'a'::text))" }] });
    const r = await run([REPLACE_CHECK], api);
    expect(r.code).toBe(0);
    expect(r.saved['phase61_mode.sql']).toContain("alter table public.coach_runs add constraint coach_runs_mode_check CHECK ((mode = 'a'::text));");
    expect(r.saved['phase61_mode.sql']).not.toContain('{previous:');
  });

  it('a failed file names what already applied, and stops', async () => {
    let n = 0;
    const api = fakeApi();
    const inner = api.fetch;
    api.fetch = (async (url: string, init: { body: string }) => {
      const { query } = JSON.parse(init.body) as { query: string };
      if (query.includes('migration_ledger') && n++ === 1) return new Response(JSON.stringify({ message: 'column "x" does not exist' }), { status: 400 });
      return inner(url as never, init as never);
    }) as unknown as typeof globalThis.fetch;
    const second = mig('phase62_more.sql', 'alter table profiles add column if not exists x int;');
    const r = await run([ADD_COL, second], api);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAILED phase62_more.sql — column "x" does not exist (already applied: phase60_add_col.sql)');
  });

  it('a refused token is a could-not-apply, not a SQL failure', async () => {
    const r = await run([ADD_COL], fakeApi({ fail: { status: 401, body: { message: 'no' } } }));
    expect(r.code).toBe(2);
  });
});

describe('applyCredentials', () => {
  const env = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-apply-'));
    writeFileSync(join(dir, 'prod.env'), text);
    return join(dir, 'prod.env');
  };

  it('no token is an opt-out, not an error', () => {
    expect(applyCredentials({ prodEnvFile: env(`VITE_SUPABASE_URL=${URL_}\n`), checkCreds: { url: URL_, key: 'k' } })).toHaveProperty('missing');
    expect(applyCredentials({ prodEnvFile: '/nonexistent/prod.env', checkCreds: null })).toHaveProperty('missing');
  });

  it('refuses a project the schema check did not read', () => {
    const r = applyCredentials({ prodEnvFile: env(`VITE_SUPABASE_URL=${URL_}\nSUPABASE_ACCESS_TOKEN=sbp_x\n`), checkCreds: { url: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co', key: 'k' } });
    expect(r).toHaveProperty('error');
  });

  it('reads the ref from the URL the check uses', () => {
    expect(applyCredentials({ prodEnvFile: env(`VITE_SUPABASE_URL=${URL_}/\nSUPABASE_ACCESS_TOKEN="sbp_x"\n`), checkCreds: { url: URL_, key: 'k' } }))
      .toEqual({ url: URL_, projectRef: REF, token: 'sbp_x' });
  });
});

describe('helpers', () => {
  it('existenceSql quotes names and has nothing to probe for policy-only files', () => {
    expect(existenceSql({ tables: [], columns: [], indexes: [], constraints: [] })).toBeNull();
    expect(existenceSql({ tables: ["o'dd"], columns: [], indexes: [], constraints: [] })).toContain(`'o''dd'`);
  });

  it('fillInverse says so when there was no previous CHECK', () => {
    expect(fillInverse('-- restore c: {previous:t.c}', [])).toBe('-- c did not exist before this migration; nothing to restore');
  });
});
