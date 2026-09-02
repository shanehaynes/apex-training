import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler, { NON_CASCADING_TABLES, USER_DATA_TABLES } from '../_lib/handlers/account';
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
}

function makeAdmin(state: AdminState) {
  return {
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          state.deleteUserCalled = id;
          return { error: state.deleteUserError ? { message: state.deleteUserError } : null };
        },
      },
    },
    from(table: string) {
      const builder: Record<string, unknown> = {};
      builder.select = () => {
        state.selectedFrom.push(table);
        builder.eq = async () => ({ data: state.rows?.[table] ?? [], error: null });
        builder.maybeSingle = async () => ({ data: null, error: null });
        // profiles uses .select().eq().maybeSingle()
        builder.eq = (() => {
          const leaf: Record<string, unknown> = {
            maybeSingle: async () => ({ data: state.rows?.[table]?.[0] ?? null, error: null }),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: state.rows?.[table] ?? [], error: null }).then(resolve),
          };
          return () => leaf;
        })();
        return builder;
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
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload, headers };
}

let state: AdminState;

beforeEach(() => {
  state = { deletedFrom: [], selectedFrom: [] };
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
