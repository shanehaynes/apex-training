import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { EXPORT_ORDER, EXPORTED_TABLES, NON_CASCADING_TABLES, USER_DATA_TABLES } from '../_lib/handlers/account';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { requireUser } from '../_lib/auth';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));

const mockedAdmin = vi.mocked(getSupabaseAdmin);
const mockedRequireUser = vi.mocked(requireUser);

interface AdminState {
  /** Tables .delete().eq() was called on, in order. */
  deletedFrom: string[];
  /** Tables .select() was called on. */
  selectedFrom: string[];
  deleteUserCalled?: string;
  deleteUserError?: string;
  tableDeleteError?: { table: string; message: string };
  rows?: Record<string, unknown[]>;
  /** A select on this table answers with this error (e.g. a table not migrated yet). */
  selectErrors?: Record<string, { code: string; message: string }>;
  /** The .order() columns of the latest select on each table. */
  orderedBy: Record<string, string[]>;
  /** What auth.admin.getUserById answers; an Error makes it fail. */
  authUser?: Record<string, unknown> | Error;
  /** Calls made, in order: 'auth' for the auth read, else `${table}` per select. */
  calls: string[];
  /** Runs before a page is served: a test's write landing mid-export. */
  onRange?: (table: string, from: number) => void;
}

/** PostgREST's max-rows: a select with no range answers at most this many. */
const MAX_ROWS = 1000;

const AUTH_USER = {
  id: 'user-123',
  email: 'athlete@example.com',
  phone: '',
  created_at: '2026-10-20T09:00:00Z',
  email_confirmed_at: '2026-10-20T09:05:00Z',
  last_sign_in_at: '2026-11-02T07:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'], age_confirmed_at: '2026-10-20T09:00:00Z' },
  user_metadata: {},
  identities: [{ provider: 'email', created_at: '2026-10-20T09:00:00Z', last_sign_in_at: '2026-11-02T07:00:00Z', identity_data: { sub: 'user-123' } }],
  encrypted_password: '$2a$10$never-exported',
};

function makeAdmin(state: AdminState) {
  return {
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          state.deleteUserCalled = id;
          return { error: state.deleteUserError ? { message: state.deleteUserError } : null };
        },
        getUserById: async () => (state.calls.push('auth'), state.authUser instanceof Error)
          ? { data: { user: null }, error: { message: state.authUser.message } }
          : { data: { user: state.authUser ?? AUTH_USER }, error: null },
      },
    },
    from(table: string) {
      const builder: Record<string, unknown> = {};
      builder.select = (_columns?: string, options?: { count?: string; head?: boolean }) => {
        if (!options?.head) {
          state.selectedFrom.push(table);
          state.calls.push(table);
          state.orderedBy[table] = [];
        }
        const filters: Array<[string, unknown]> = [];
        // Like PostgREST: only rows matching every eq(), in the order asked.
        const matching = () => (state.rows?.[table] ?? [])
          .filter(row => filters.every(([column, value]) => (row as Record<string, unknown>)[column] === value))
          .sort((a, b) => {
            for (const column of state.orderedBy[table] ?? []) {
              const x = String((a as Record<string, unknown>)[column]);
              const y = String((b as Record<string, unknown>)[column]);
              if (x !== y) return x < y ? -1 : 1;
            }
            return 0;
          });
        const answer = (rows: unknown[]) => state.selectErrors?.[table]
          ? { data: null, count: null, error: state.selectErrors[table] }
          : { data: options?.head ? null : rows, count: matching().length, error: null };
        const leaf: Record<string, unknown> = {
          eq: (column: string, value: unknown) => { filters.push([column, value]); return leaf; },
          order: (column: string) => { state.orderedBy[table].push(column); return leaf; },
          range: async (from: number, to: number) => {
            state.onRange?.(table, from);
            return answer(matching().slice(from, to + 1));
          },
          // profiles uses .select().eq().maybeSingle()
          maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(answer(matching().slice(0, MAX_ROWS))).then(resolve),
        };
        return leaf;
      };
      builder.delete = () => ({
        eq: async () => {
          state.deletedFrom.push(table);
          return state.tableDeleteError?.table === table
            ? { error: { message: state.tableDeleteError.message } }
            : { error: null };
        },
      });
      return builder;
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, body?: unknown): VercelRequest {
  return { method, headers: {}, body, query: {} } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const written: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    write(chunk: string) { written.push(chunk); return true; },
    end() { if (written.length) payload = written.join(''); return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload, headers, chunks: () => written.length };
}

let state: AdminState;

beforeEach(() => {
  state = { deletedFrom: [], selectedFrom: [], orderedBy: {}, calls: [] };
  mockedAdmin.mockReset();
  mockedAdmin.mockReturnValue(makeAdmin(state));
  mockedRequireUser.mockReset();
  mockedRequireUser.mockResolvedValue('user-123');
});

describe('GET /api/account — export', () => {
  it('reads every table in USER_DATA_TABLES, plus profiles', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    for (const table of USER_DATA_TABLES) expect(state.selectedFrom).toContain(table);
    expect(state.selectedFrom).toContain('profiles');
  });

  it('exports a table its migration has not reached yet as empty, and fails on any other error', async () => {
    state.selectErrors = { daily_metrics: { code: 'PGRST205', message: "Could not find the table 'public.daily_metrics'" } };
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(JSON.parse(body() as string).data.daily_metrics).toEqual([]);

    state.selectErrors = { daily_metrics: { code: '57014', message: 'canceling statement due to statement timeout' } };
    const failed = makeRes();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await handler(makeReq('GET'), failed.res);
    expect(failed.statusCode()).toBe(500);
  });

  // The delete screens say "export a copy first": an export capped at 1000
  // rows would lose the rest of a long history for good.
  it('pages past PostgREST\'s 1000-row cap, so a long history exports whole', async () => {
    const sets = Array.from({ length: 2 * MAX_ROWS + 500 }, (_, i) => ({ id: `set-${i}`, user_id: 'user-123' }));
    state.rows = { workout_set_logs: sets };
    const { res, body } = makeRes();
    await handler(makeReq('GET'), res);
    const exported = JSON.parse(body() as string).data.workout_set_logs as { id: string }[];
    expect(exported).toHaveLength(sets.length);
    expect(new Set(exported.map(r => r.id)).size).toBe(sets.length);
  });

  it('pages every table in a total order: its key, user_id aside', async () => {
    const { res } = makeRes();
    await handler(makeReq('GET'), res);
    for (const table of EXPORTED_TABLES) {
      expect(state.orderedBy[table], table).toEqual([...(EXPORT_ORDER[table] ?? ['id'])]);
    }
  });

  it('carries the sign-in record, the email and the 18+ stamp, but never the password', async () => {
    const { res, body } = makeRes();
    await handler(makeReq('GET'), res);
    const text = body() as string;
    const payload = JSON.parse(text);
    expect(state.calls[0]).toBe('auth');
    expect(payload.account).toMatchObject({
      email: 'athlete@example.com',
      phone: null,
      createdAt: '2026-10-20T09:00:00Z',
      emailConfirmedAt: '2026-10-20T09:05:00Z',
      appMetadata: { age_confirmed_at: '2026-10-20T09:00:00Z' },
      identities: [{ provider: 'email', createdAt: '2026-10-20T09:00:00Z' }],
    });
    expect(Object.keys(payload.notes)).toContain('password');
    expect(text).not.toContain('never-exported');
    expect(text).not.toContain('identity_data');
  });

  it('fails rather than export without the sign-in record', async () => {
    state.authUser = new Error('User not found');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(500);
  });

  it('is never cached', async () => {
    const { res, headers } = makeRes();
    await handler(makeReq('GET'), res);
    expect(headers['Cache-Control']).toBe('no-store');
  });

  // The service-role client bypasses RLS: the user_id filter is all that
  // keeps another athlete's rows out of this file.
  it('exports only the requesting user\'s rows, from every table', async () => {
    state.rows = Object.fromEntries(EXPORTED_TABLES.map(table => [table, [
      { id: `${table}-mine`, user_id: 'user-123' },
      { id: `${table}-theirs`, user_id: 'someone-else' },
    ]]));
    const { res, body } = makeRes();
    await handler(makeReq('GET'), res);
    const text = body() as string;
    expect(text).not.toContain('someone-else');
    for (const table of EXPORTED_TABLES) {
      expect(JSON.parse(text).data[table], table).toEqual([{ id: `${table}-mine`, user_id: 'user-123' }]);
    }
  });

  // Swept on delete, so a record we hold: privacy-v2 §6, "across every table".
  it('exports the non-cascading tables too', async () => {
    state.rows = { phase32_quarantine: [{ id: 1, user_id: 'user-123', row_data: { kept: true } }] };
    const { res, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(JSON.parse(body() as string).data.phase32_quarantine).toEqual([{ id: 1, user_id: 'user-123', row_data: { kept: true } }]);
    for (const table of NON_CASCADING_TABLES) expect(state.selectedFrom).toContain(table);
  });

  // A delete while a table is paged shifts the later pages left: one live
  // row is never read. An insert shifts them right: one row is read twice.
  it('reads a table again when it changed while it was paged, so no row is skipped or repeated', async () => {
    const sets = Array.from({ length: 2 * MAX_ROWS + 500 }, (_, i) => ({ id: `set-${String(i).padStart(5, '0')}`, user_id: 'user-123' }));
    state.rows = { workout_set_logs: [...sets] };
    let deleted = false;
    state.onRange = (table, from) => {
      if (table === 'workout_set_logs' && from === MAX_ROWS && !deleted) {
        deleted = true;
        state.rows!.workout_set_logs.splice(5, 1);
      }
    };
    const { res, body, statusCode } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    const exported = (JSON.parse(body() as string).data.workout_set_logs as { id: string }[]).map(r => r.id);
    expect(exported).toEqual(state.rows!.workout_set_logs.map(r => (r as { id: string }).id));
  });

  it('fails rather than export a table that never holds still', async () => {
    state.rows = { workout_set_logs: Array.from({ length: MAX_ROWS + 10 }, (_, i) => ({ id: `set-${i}`, user_id: 'user-123' })) };
    let n = 0;
    state.onRange = (table, from) => {
      if (table === 'workout_set_logs' && from === MAX_ROWS) state.rows!.workout_set_logs.unshift({ id: `new-${n++}`, user_id: 'user-123' });
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, statusCode } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(500);
  });

  it('reads the sign-in record before any table, so its failure costs no table reads', async () => {
    const { res } = makeRes();
    await handler(makeReq('GET'), res);
    expect(state.calls[0]).toBe('auth');
  });

  // Vercel refuses a buffered function response over 4.5 MB; a streamed one
  // has no such limit, and a long history with watch streams passes 4.5 MB.
  it('streams a large export in chunks, compact', async () => {
    const points = Array.from({ length: 4000 }, (_, i) => i);
    state.rows = { activity_streams: Array.from({ length: 150 }, (_, i) => ({
      event_id: `ride-${i}`, event_date: '2026-10-01', user_id: 'user-123', hr: points, latlng: points,
    })) };
    const { res, body, chunks, statusCode } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect((body() as string).length).toBeGreaterThan(4.5 * 1024 * 1024);
    expect(chunks()).toBeGreaterThan(1);
    expect(body() as string).not.toMatch(/\n {2}/);
    expect(JSON.parse(body() as string).data.activity_streams).toHaveLength(150);
  });

  it('summarises provider connections without their tokens', async () => {
    state.rows = { provider_connections: [{ user_id: 'user-123', provider: 'apple', status: 'connected', categories: { workoutsRead: true } }] };
    const { res, body } = makeRes();
    await handler(makeReq('GET'), res);
    const payload = JSON.parse(body() as string);
    expect(payload.providerConnectionSummary).toMatchObject([{ provider: 'apple', status: 'connected', categories: { workoutsRead: true } }]);
    expect(payload.data).not.toHaveProperty('provider_connections');
  });

  it('serves as a downloadable attachment', async () => {
    const { res, headers } = makeRes();
    await handler(makeReq('GET'), res);
    expect(headers['Content-Disposition']).toContain('attachment');
    expect(headers['Content-Type']).toContain('application/json');
  });

  it('explains, rather than exports, every table holding secret material', async () => {
    const { res, body } = makeRes();
    await handler(makeReq('GET'), res);
    const payload = JSON.parse(body() as string);
    for (const table of ['user_api_keys', 'mcp_tokens', 'provider_connections']) {
      expect(Object.keys(payload.notes)).toContain(table);
      expect(Object.keys(payload.data)).not.toContain(table);
    }
  });

  // Export and delete must not be held hostage to accepting new terms — see
  // RequireUserOptions in auth.ts.
  it('is exempt from the terms gate', async () => {
    const { res } = makeRes();
    await handler(makeReq('GET'), res);
    expect(mockedRequireUser).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), { skipTermsGate: true },
    );
  });
});

describe('DELETE /api/account', () => {
  it('refuses without the confirm field, touching nothing', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', {}), res);
    expect(statusCode()).toBe(400);
    expect(state.deleteUserCalled).toBeUndefined();
    expect(state.deletedFrom).toEqual([]);
  });

  it('refuses a wrong confirm value', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { confirm: 'yes' }), res);
    expect(statusCode()).toBe(400);
    expect(state.deleteUserCalled).toBeUndefined();
  });

  it('sweeps the non-cascading tables and then deletes the auth user', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { confirm: 'DELETE' }), res);
    expect(statusCode()).toBe(200);
    expect(state.deletedFrom).toEqual([...NON_CASCADING_TABLES]);
    expect(state.deleteUserCalled).toBe('user-123');
  });

  // Order matters: a failed sweep must leave the account intact and
  // retryable, not strand rows under a user id that no longer exists.
  it('aborts with the account intact when the sweep fails', async () => {
    state.tableDeleteError = { table: NON_CASCADING_TABLES[0], message: 'permission denied' };
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { confirm: 'DELETE' }), res);
    expect(statusCode()).toBe(500);
    expect(state.deleteUserCalled, 'the auth user must survive a failed sweep').toBeUndefined();
  });

  it('500s when the auth delete itself fails', async () => {
    state.deleteUserError = 'Database error deleting user';
    const { res, statusCode } = makeRes();
    await handler(makeReq('DELETE', { confirm: 'DELETE' }), res);
    expect(statusCode()).toBe(500);
  });

  it('deletes the verified user, never one named in the body', async () => {
    mockedRequireUser.mockResolvedValue('verified-user');
    const { res } = makeRes();
    await handler(makeReq('DELETE', { confirm: 'DELETE', user_id: 'someone-else' }), res);
    expect(state.deleteUserCalled).toBe('verified-user');
  });
});

// ── Coverage of the deletion promise ─────────────────────────────────────────
// legal/privacy-v1.md §5 says account deletion removes everything. That claim
// is only as good as this list, and the failure mode is silent: a new table
// with a user_id and no cascade leaves a "deleted" user's rows sitting in the
// database, contradicting a published document.
//
// phase32_quarantine is exactly that — a user_id, whole rows as JSONB, and no
// foreign key at all. It was found by hand while writing the export. This test
// is so the next one is not.

const MIGRATIONS_DIR = join(import.meta.dirname, '../../supabase/migrations');
const SCHEMA_SQL = join(import.meta.dirname, '../../supabase/schema.sql');

/** Tables carrying user data that are deliberately not in the export. */
const REDACTED = new Set([
  'user_api_keys',        // encrypted key material
  'mcp_tokens',           // hashes; metadata exported separately
  'provider_connections', // encrypted OAuth tokens
  'oauth_codes',          // expire within minutes
  'profiles',             // exported, but keyed by `id` not `user_id`
]);

interface TableInfo {
  name: string;
  file: string;
  cascades: boolean;
}

/** Every CREATE TABLE body in the repo's SQL, with its column text. */
function userTables(): TableInfo[] {
  const files = [SCHEMA_SQL, ...readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => join(MIGRATIONS_DIR, f))];
  const found = new Map<string, TableInfo>();

  for (const file of files) {
    const sql = readFileSync(file, 'utf8');

    // phase9 adds user_id to a list of pre-existing tables inside a DO block,
    // with the cascade in the ALTER template rather than a CREATE body.
    if (/ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth\.users \(id\) ON DELETE CASCADE/i.test(sql)) {
      const arrayBlock = /FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]/i.exec(sql);
      for (const m of arrayBlock?.[1].matchAll(/'([a-z_]+)'/g) ?? []) {
        found.set(m[1], { name: m[1], file, cascades: true });
      }
    }

    for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_0-9]+)\s*\(([\s\S]*?)\n\);/gi)) {
      const [, name, body] = m;
      const userIdLine = body.split('\n').find(l => /^\s*user_id\s/i.test(l));
      if (!userIdLine) continue;
      const cascades = /REFERENCES\s+auth\.users\s*\(\s*id\s*\)\s*ON DELETE CASCADE/i.test(userIdLine);
      // A later migration never removes a cascade, so first definition wins
      // unless it is the phase9 ALTER form already recorded above.
      if (!found.has(name)) found.set(name, { name, file, cascades });
    }
  }
  return [...found.values()];
}

describe('account deletion covers every table holding user data', () => {
  const tables = userTables();

  it('finds the tables at all (guards the parser itself)', () => {
    expect(tables.length).toBeGreaterThan(20);
    expect(tables.map(t => t.name)).toContain('workout_events');
    expect(tables.map(t => t.name)).toContain('terms_acceptances');
  });

  it('every table with a user_id either cascades or is swept explicitly', () => {
    const orphans = tables
      .filter(t => !t.cascades && !NON_CASCADING_TABLES.includes(t.name as never))
      .map(t => `${t.name} (${t.file.split('/').pop()})`);
    expect(
      orphans,
      'these tables have a user_id but no cascade from auth.users, so deleting an '
      + 'account would leave their rows behind — add a cascading FK, or add them to '
      + 'NON_CASCADING_TABLES in api/_lib/handlers/account.ts so the delete sweeps them',
    ).toEqual([]);
  });

  it('every table with a user_id is exported, swept, or explicitly redacted', () => {
    const covered = new Set<string>([
      ...USER_DATA_TABLES, ...NON_CASCADING_TABLES, ...REDACTED,
    ]);
    const missing = tables.map(t => t.name).filter(n => !covered.has(n));
    expect(
      missing,
      'these tables hold user data but appear in neither the export nor the '
      + 'redaction notes — add them to USER_DATA_TABLES in account.ts, or to '
      + 'REDACTED here with a reason',
    ).toEqual([]);
  });

  it('records the non-cascading tables it knows about, so the list is deliberate', () => {
    expect(NON_CASCADING_TABLES).toContain('phase32_quarantine');
  });

  it('exports no table twice', () => {
    expect(new Set(USER_DATA_TABLES).size).toBe(USER_DATA_TABLES.length);
  });
});

/**
 * Each table's primary key at the end of the given SQL, statement by
 * statement in order: a CREATE TABLE's table-level PRIMARY KEY (…) or a column
 * marked PRIMARY KEY; ALTER TABLE … ADD [CONSTRAINT name] PRIMARY KEY (…),
 * which replaces it; DROP TABLE, which forgets it until the table is created
 * again.
 */
function primaryKeysIn(sqlFiles: string[]): Map<string, string[]> {
  const columns = (list: string) => list.split(',').map(c => c.trim().toLowerCase());
  const keys = new Map<string, string[]>();
  const statement = new RegExp([
    String.raw`CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(?<created>[a-z_0-9]+)\s*\((?<body>[\s\S]*?)\n\);`,
    String.raw`ALTER TABLE (?:ONLY )?(?:public\.)?(?<altered>[a-z_0-9]+)\s+ADD (?:CONSTRAINT [a-z_0-9]+ )?PRIMARY KEY\s*\((?<key>[^)]+)\)`,
    String.raw`DROP TABLE (?:IF EXISTS )?(?:public\.)?(?<dropped>[a-z_0-9]+)`,
  ].join('|'), 'gi');
  for (const raw of sqlFiles) {
    const sql = raw.replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(statement)) {
      const { created, body, altered, key, dropped } = m.groups!;
      if (dropped) { keys.delete(dropped); continue; }
      if (altered) { keys.set(altered, columns(key)); continue; }
      if (keys.has(created)) continue; // IF NOT EXISTS on a table that exists
      const tableLevel = /PRIMARY KEY\s*\(([^)]+)\)/i.exec(body);
      const inline = body.split('\n').find(l => /^\s*[a-z_0-9]+\s[^\n]*\bPRIMARY KEY\b/i.test(l));
      if (tableLevel) keys.set(created, columns(tableLevel[1]));
      else if (inline) keys.set(created, [inline.trim().split(/\s+/)[0].toLowerCase()]);
    }
  }
  return keys;
}

/** The repo's schema, then its migrations in phase order. */
function primaryKeys(): Map<string, string[]> {
  const phase = (f: string) => Number(/^phase(\d+)/.exec(f)?.[1] ?? -1);
  const files = [SCHEMA_SQL, ...readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => phase(a) - phase(b) || a.localeCompare(b))
    .map(f => join(MIGRATIONS_DIR, f))];
  return primaryKeysIn(files.map(f => readFileSync(f, 'utf8')));
}

describe('the export pages each table in a total order', () => {
  const keys = primaryKeys();

  it('finds the keys at all (guards the parser itself)', () => {
    expect(keys.get('workout_events')).toEqual(['user_id', 'id']);
    expect(keys.get('workout_exercise_notes')).toEqual(['user_id', 'event_id', 'event_date', 'section', 'exercise_id']);
    expect(keys.get('coach_runs')).toEqual(['id']);
    expect(keys.get('phase32_quarantine')).toEqual(['id']);
  });

  it('follows a key that a later migration names, replaces, or recreates', () => {
    const later = primaryKeysIn([
      'CREATE TABLE IF NOT EXISTS a (\n  id uuid PRIMARY KEY,\n  user_id uuid\n);',
      'CREATE TABLE IF NOT EXISTS b (\n  id uuid PRIMARY KEY\n);',
      'ALTER TABLE a DROP CONSTRAINT a_pkey;\nALTER TABLE a ADD CONSTRAINT a_pkey PRIMARY KEY (user_id, created_at);',
      'DROP TABLE IF EXISTS b;\nCREATE TABLE b (\n  user_id uuid,\n  day date,\n  PRIMARY KEY (user_id, day)\n);',
    ]);
    expect(later.get('a')).toEqual(['user_id', 'created_at']);
    expect(later.get('b')).toEqual(['user_id', 'day']);
  });

  it('orders every exported table by its primary key, user_id aside', () => {
    const wrong = EXPORTED_TABLES.flatMap(table => {
      const key = keys.get(table)?.filter(c => c !== 'user_id');
      const order = [...(EXPORT_ORDER[table] ?? ['id'])];
      return key && [...key].sort().join() === [...order].sort().join()
        ? []
        : [`${table}: key (${key?.join(', ') ?? 'not found'}), paged by (${order.join(', ')})`];
    });
    expect(
      wrong,
      'a page range over a non-unique order repeats or skips rows — set EXPORT_ORDER '
      + 'in api/_lib/handlers/account.ts to the table\'s primary key without user_id',
    ).toEqual([]);
  });
});
