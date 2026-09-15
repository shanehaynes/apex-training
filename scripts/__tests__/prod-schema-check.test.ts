import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSchema, migrationIndex, parseDatabaseTypes, sourceOf } from '../prod-schema-check.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));

// The shape `supabase gen types` writes, trimmed to what the parser must get
// right: Insert/Update/Relationships beside Row, a multi-line union, one-line
// Args, an object Returns, a second schema, and the __InternalSupabase marker.
const generated = (publicViews = '[_ in never]: never') => `export type Json =
  | string
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  graphql_public: {
    Tables: {
      not_public: {
        Row: { nope: string }
        Insert: { nope?: string }
        Update: { nope?: string }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: { operationName?: string; query?: string }
        Returns: Json
      }
    }
  }
  public: {
    Tables: {
      profiles: {
        Row: {
          coach_model: string | null
          id: string
          settings: Json
        }
        Insert: {
          coach_model?: string | null
          id: string
          insert_only?: string
        }
        Update: {
          update_only?: string
        }
        Relationships: []
      }
      provider_connections: {
        Row: {
          client: string | null
          status:
            | "pending"
            | "active"
          user_id: string
        }
        Insert: {
          user_id: string
        }
        Update: {
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_connections_user_id_fkey"
            columns: ["user_id"]
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ${publicViews}
    }
    Functions: {
      bump_rate_limit: {
        Args: { p_bucket: string; p_user_id: string; p_window_seconds: number }
        Returns: number
      }
      last_performed_by_name: {
        Args: { p_user_id?: string }
        Returns: {
          event_date: string
          exercise_name: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">
`;

describe('parseDatabaseTypes', () => {
  const parsed = parseDatabaseTypes(generated());

  it("reads each public table's Row columns, and only Row's", () => {
    expect(parsed.tables).toEqual([
      { name: 'profiles', columns: ['coach_model', 'id', 'settings'] },
      { name: 'provider_connections', columns: ['client', 'status', 'user_id'] },
    ]);
  });

  it('lists function names, not their argument or return fields', () => {
    expect(parsed.functions).toEqual(['bump_rate_limit', 'last_performed_by_name']);
  });

  it('reads only the public schema, and an empty Views section is no views', () => {
    expect(parsed.views).toEqual([]);
    expect(JSON.stringify(parsed)).not.toMatch(/not_public|nope|graphql|PostgrestVersion/);
  });

  it('reads a view like a table', () => {
    const src = generated(`weekly_volume: {
        Row: { user_id: string | null; volume: number | null }
        Relationships: []
      }`);
    expect(parseDatabaseTypes(src).views).toEqual([{ name: 'weekly_volume', columns: ['user_id', 'volume'] }]);
  });

  it('does not lean on formatting: quoted keys, comments with quotes and braces, one-line objects', () => {
    const src = `export type Database = {
  public: {
    Tables: {
      "odd table": {
        // the generator's comments may carry apostrophes; they open no string
        Row: { "Mixed Case": string; plain: number /* a } in a comment */ }
        Insert: {}
        Update: {}
        Relationships: []
      }
    }
    Views: {}
    Functions: {}
  }
}`;
    expect(parseDatabaseTypes(src)).toEqual({
      tables: [{ name: 'odd table', columns: ['Mixed Case', 'plain'] }],
      views: [],
      functions: [],
    });
  });

  it('throws rather than report an empty or unrecognised schema as in sync', () => {
    expect(() => parseDatabaseTypes('export const nothing = 1')).toThrow(/export type Database/);
    expect(() => parseDatabaseTypes('export type Database = { graphql_public: {} }')).toThrow(/no public/);
    expect(() => parseDatabaseTypes('export type Database = { public: { Views: {}; Functions: {} } }')).toThrow(/no Tables/);
    expect(() => parseDatabaseTypes('export type Database = { public: { Tables: {}; Views: {}; Functions: {} } }')).toThrow(/empty/);
    expect(() =>
      parseDatabaseTypes('export type Database = { public: { Tables: { t: { Insert: {} } }; Views: {}; Functions: {} } }'),
    ).toThrow(/no Row in public\.Tables\.t/);
  });

  it('understands the committed database.types.ts', () => {
    const real = parseDatabaseTypes(readFileSync(`${repo}src/lib/db/database.types.ts`, 'utf8'));
    const columnsOf = (table: string) => real.tables.find((t: { name: string }) => t.name === table)?.columns;
    // The three objects production was missing on 2026-09-15.
    expect(columnsOf('profiles')).toContain('coach_model');
    expect(columnsOf('provider_connections')).toContain('client');
    expect(columnsOf('phase32_quarantine')).toBeDefined();
    expect(real.functions).toEqual(expect.arrayContaining(['bump_rate_limit', 'last_performed_by_name']));
    expect(real.tables.length).toBeGreaterThanOrEqual(30);
    for (const { name, columns } of real.tables) {
      expect(columns.length, name).toBeGreaterThan(0);
      // A structural key among the columns means the walk escaped its Row.
      expect(columns.filter((c: string) => /^(Row|Insert|Update|Relationships|Args|Returns)$/.test(c)), name).toEqual([]);
    }
  });
});

describe('migrationIndex and sourceOf', () => {
  const dir = `${repo}supabase/migrations`;
  const index = migrationIndex(
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((file) => ({ file, sql: readFileSync(`${dir}/${file}`, 'utf8') })),
  );

  it('names the migration behind each object production was missing on 2026-09-15', () => {
    expect(sourceOf({ kind: 'table', name: 'phase32_quarantine' }, index)).toBe('created by phase32_event_date_backfill.sql');
    expect(sourceOf({ kind: 'column', table: 'profiles', name: 'coach_model' }, index)).toBe('added by phase38_coach_model.sql');
    expect(sourceOf({ kind: 'column', table: 'provider_connections', name: 'client' }, index)).toBe(
      'added by phase41_provider_client.sql',
    );
  });

  it('reads multi-column ALTERs, CREATE TABLE bodies, functions and dynamic SQL', () => {
    expect(sourceOf({ kind: 'column', table: 'recurring_exceptions', name: 'override_end_time' }, index)).toBe(
      'added by phase7_occurrence_overrides.sql',
    );
    expect(sourceOf({ kind: 'column', table: 'workout_sessions', name: 'score_reps' }, index)).toBe(
      'added by phase34_workout_scores.sql',
    );
    expect(sourceOf({ kind: 'column', table: 'provider_connections', name: 'provider' }, index)).toMatch(
      /^in phase27_provider_sync\.sql's CREATE TABLE/,
    );
    expect(sourceOf({ kind: 'function', name: 'bump_rate_limit' }, index)).toBe('defined in phase18_rate_limits.sql');
    expect(sourceOf({ kind: 'column', table: 'workout_events', name: 'user_id' }, index)).toMatch(
      /phase9_multi_user\.sql adds a user_id column through dynamic SQL$/,
    );
    expect(sourceOf({ kind: 'table', name: 'workout_completions' }, index)).toBe('no file in supabase/migrations creates it');
  });

  it('is not fooled by semicolons in strings and $$ bodies, constraints, comments or other schemas', () => {
    const tricky = migrationIndex([
      {
        file: 'phase90_tricky.sql',
        sql: `-- ALTER TABLE ghosts ADD COLUMN in_a_comment text;
CREATE TABLE public."Quoted" (id int PRIMARY KEY, note text DEFAULT 'a;b', CONSTRAINT q_check CHECK (id > 0));
COMMENT ON TABLE "Quoted" IS 'see; ALTER TABLE ghosts ADD COLUMN in_a_string text';
CREATE OR REPLACE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $fn$;
DO $$ BEGIN PERFORM 1; ALTER TABLE ghosts ADD COLUMN in_a_body text; END $$;
ALTER TABLE ONLY "Quoted" ADD CONSTRAINT uq UNIQUE (note), ADD extra jsonb;
ALTER TABLE "Quoted" RENAME COLUMN note TO body;
CREATE TABLE auth.not_ours (id int);`,
      },
    ]);
    const column = (table: string, name: string) => sourceOf({ kind: 'column', table, name }, tricky);
    expect(sourceOf({ kind: 'table', name: 'Quoted' }, tricky)).toBe('created by phase90_tricky.sql');
    expect(column('Quoted', 'id')).toMatch(/^in phase90_tricky\.sql's CREATE TABLE/);
    expect(column('Quoted', 'extra')).toBe('added by phase90_tricky.sql');
    expect(column('Quoted', 'body')).toBe('added by phase90_tricky.sql');
    expect(sourceOf({ kind: 'function', name: 'touch' }, tricky)).toBe('defined in phase90_tricky.sql');
    expect(column('Quoted', 'q_check')).toBe('no file in supabase/migrations adds it');
    expect(column('Quoted', 'uq')).toBe('no file in supabase/migrations adds it');
    expect(column('ghosts', 'in_a_comment')).toBe('no file in supabase/migrations adds it');
    // Inside a string or a DO body it is not a statement of its own — at most a lead.
    expect(column('ghosts', 'in_a_string')).not.toMatch(/^added by/);
    expect(column('ghosts', 'in_a_body')).toMatch(/through dynamic SQL$/);
    expect(sourceOf({ kind: 'table', name: 'not_ours' }, tricky)).toBe('no file in supabase/migrations creates it');
  });
});

/** A stand-in for PostgREST that answers the way the real one does, for a schema of table → columns. */
function fakePostgrest(tables: Record<string, string[]>, functions: string[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = async (input: string, init: { headers: Record<string, string> }) => {
    calls.push({ url: input, headers: init.headers });
    const url = new URL(input);
    const table = decodeURIComponent(url.pathname.replace(/^\/rest\/v1\/?/, ''));
    if (table === '') {
      const paths = ['/', ...Object.keys(tables).map((t) => `/${t}`), ...functions.map((f) => `/rpc/${f}`)];
      return json(200, { swagger: '2.0', paths: Object.fromEntries(paths.map((p) => [p, {}])) });
    }
    if (!(table in tables)) {
      return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
    }
    const select = (url.searchParams.get('select') ?? '').split(',').map((c) => c.replace(/^"|"$/g, ''));
    const absent = select.find((c) => c !== '*' && !tables[table].includes(c));
    if (absent) return json(400, { code: '42703', message: `column ${table}.${absent} does not exist` });
    return json(200, []);
  };
  return { fetch, calls };
}

describe('checkSchema', () => {
  const url = 'https://ref.supabase.co';
  const expected = {
    tables: [
      { name: 'profiles', columns: ['id', 'coach_model'] },
      { name: 'phase32_quarantine', columns: ['id'] },
      { name: 'provider_connections', columns: ['user_id', 'client', 'timezone'] },
    ],
    views: [],
    functions: ['bump_rate_limit', 'last_performed_by_name'],
  };

  it('in sync: the OpenAPI read plus one limit=0 probe per table, the key only ever in headers', async () => {
    const key = 'eyJhbGciOiJIUzI1NiJ9.service-role.sig';
    const rest = fakePostgrest(
      { profiles: ['id', 'coach_model'], phase32_quarantine: ['id'], provider_connections: ['user_id', 'client', 'timezone'] },
      expected.functions,
    );
    expect(await checkSchema({ url, key, expected, fetch: rest.fetch })).toEqual({ missing: [], unverified: [] });
    expect(rest.calls).toHaveLength(4);
    for (const call of rest.calls) {
      expect(call.url).not.toContain(key);
      expect(call.headers).toEqual({ apikey: key, Authorization: `Bearer ${key}` });
      if (!call.url.endsWith('/rest/v1/')) expect(new URL(call.url).searchParams.get('limit')).toBe('0');
    }
  });

  it('names the missing table, every missing column, and the missing function', async () => {
    const rest = fakePostgrest({ profiles: ['id'], provider_connections: ['user_id'] }, ['last_performed_by_name']);
    expect(await checkSchema({ url, key: 'k', expected, fetch: rest.fetch })).toEqual({
      missing: [
        { kind: 'table', name: 'phase32_quarantine' },
        { kind: 'column', table: 'profiles', name: 'coach_model' },
        { kind: 'column', table: 'provider_connections', name: 'client' },
        { kind: 'column', table: 'provider_connections', name: 'timezone' },
        { kind: 'function', name: 'bump_rate_limit' },
      ],
      unverified: [],
    });
  });

  it('an unreachable project or a rejected key is a skip, not drift', async () => {
    const offline = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    };
    expect(await checkSchema({ url, key: 'k', expected, fetch: offline })).toEqual({
      skipped: 'could not reach ref.supabase.co (ENOTFOUND)',
    });

    const sent: Record<string, string>[] = [];
    const rejected = async (_: string, init: { headers: Record<string, string> }) => {
      sent.push(init.headers);
      return new Response('{"message":"Invalid API key"}', { status: 401 });
    };
    const result = await checkSchema({ url, key: 'sb_secret_abc', expected, fetch: rejected });
    expect(result.skipped).toMatch(/rejected the service-role key \(401\)/);
    // sb_ keys are not JWTs: they go in apikey alone, with no Authorization header.
    expect(sent).toEqual([{ apikey: 'sb_secret_abc' }]);
  });
});
