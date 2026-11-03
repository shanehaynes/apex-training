import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';

// Account export and deletion — the two capabilities the Privacy Policy
// (legal/privacy-v2.md §6) promises, and which did not exist before it.
//
// EXEMPT FROM THE TERMS GATE (see RequireUserOptions in auth.ts). Taking
// your data out and closing your account are the things a user who declines
// new terms most needs to do; withholding them until they agree would make
// the acceptance modal coercive rather than informative.

/**
 * Tables read by the export and swept by the delete, keyed on user_id.
 *
 * Kept in one list rather than two so an added table cannot appear in the
 * export and be missed by the delete, or the reverse.
 * api/__tests__/account.test.ts parses the migrations and fails if a table
 * carrying user data is absent from this list.
 */
export const USER_DATA_TABLES = [
  'workout_events',
  'coach_annotations',
  'coach_reflections',
  'recurring_exceptions',
  'event_mutations_log',
  'workout_completions',
  'workout_completion_log',
  'workout_sessions',
  'workout_set_logs',
  'workout_cardio_logs',
  'workout_exercise_notes',
  'exercise_definitions',
  'definition_mutations_log',
  'workout_templates',
  'objectives',
  'training_blocks',
  'block_mutations_log',
  'meals',
  'meal_mutations_log',
  'meal_favorites',
  'reviews',
  'activity_streams',
  'provider_activity_imports',
  'analytics_tiles',
  'terms_acceptances',
  'api_request_counts',
  'coach_runs',
  'coach_conversations',
  'coach_messages',
  'coach_memory',
  'live_activity_tokens',
  'daily_metrics',
] as const;

/**
 * Tables holding user data that do NOT cascade from auth.users, and so
 * survive a plain account deletion. Every one of these is a bug waiting to
 * happen, which is why they are named here rather than assumed absent:
 *
 *   phase32_quarantine — a diagnostic table from the phase 32 event_date
 *     backfill. It stores whole rows as JSONB, carries user_id, and has no
 *     foreign key at all, so the cascade never reaches it.
 *
 * Swept explicitly, BEFORE the auth user is deleted: if the sweep fails we
 * abort with the account intact, rather than leaving a deleted user's rows
 * behind with no account left to retry from.
 */
export const NON_CASCADING_TABLES = ['phase32_quarantine'] as const;

/** Every table the export reads by user_id: the swept ones are records too. */
export const EXPORTED_TABLES = [...USER_DATA_TABLES, ...NON_CASCADING_TABLES] as const;

/**
 * The key each table is paged by, when it is not just `id`: its primary key
 * without `user_id`, which every read already filters on. A page starts after
 * the last key read, so the key must be unique and total.
 * api/__tests__/account.test.ts checks every table's key against its primary
 * key in the migrations.
 */
export const EXPORT_ORDER: Partial<Record<(typeof EXPORTED_TABLES)[number], readonly string[]>> = {
  workout_completions: ['event_id'],
  workout_exercise_notes: ['event_id', 'event_date', 'section', 'exercise_id'],
  activity_streams: ['event_id', 'event_date'],
  provider_activity_imports: ['provider', 'activity_id'],
  api_request_counts: ['bucket', 'window_start'],
  daily_metrics: ['date', 'provider'],
};

/**
 * The secret-holding tables, summarised: the named columns only, never the
 * secrets. Paged like any table, by `order` (the primary key without
 * user_id, checked against the migrations like EXPORT_ORDER): every OAuth
 * refresh adds two mcp_tokens rows and none is ever deleted, so a long-used
 * connector passes PostgREST's 1000-row cap.
 */
export const SUMMARIES = {
  mcp_tokens: {
    columns: ['name', 'token_last4', 'kind', 'created_at', 'last_used_at', 'revoked_at', 'expires_at'],
    order: ['id'],
  },
  provider_connections: {
    columns: ['provider', 'status', 'connected_at', 'last_synced_at', 'auto_sync', 'categories'],
    order: ['provider'],
  },
} as const;

/**
 * Tables holding secret material. Their existence is disclosed in the
 * export; their contents are not. Exporting an encrypted OAuth token or a
 * token hash would hand a copy of credential material to whatever the user
 * does with the download, and buys them nothing they can use.
 */
const REDACTED_TABLES = {
  user_api_keys: 'Your saved Anthropic API key is stored encrypted and is deliberately not exported. Remove or replace it in Profile → Anthropic key.',
  mcp_tokens: 'Access tokens are stored only as hashes and cannot be recovered. Their names and usage dates are in the summary below.',
  provider_connections: 'Watch-provider OAuth tokens are stored encrypted and are deliberately not exported. Each connection — the provider, its status, its dates and, for Apple Health, the categories you switched on — is in the summary below.',
  oauth_clients: 'OAuth client registrations belong to the connecting application, not to your account data.',
  oauth_codes: 'Short-lived OAuth authorization codes; they expire within minutes and are not exported.',
  password: 'Your password is stored only as a hash by Supabase Auth. Apex never sees it, and it is not exported.',
} as const;

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** PostgREST's "no such table" (its schema cache) or Postgres's own. */
function isTableMissing(error: { code?: string }): boolean {
  return error.code === 'PGRST205' || error.code === '42P01';
}

/** Rows asked for per page; PostgREST's max_rows may answer fewer. */
const PAGE_SIZE = 1000;

/** A PostgREST filter value, quoted so commas, dots, colons and parentheses stay data. */
function literal(value: unknown): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The PostgREST `or` filter for "after this key" over a composite key, as
 * (a > x) or (a = x and b > y) or …: a row comparison in filter syntax.
 */
export function afterKey(order: readonly string[], last: Record<string, unknown>): string {
  return order.map((column, i) => {
    const gt = `${column}.gt.${literal(last[column])}`;
    if (i === 0) return gt;
    const equal = order.slice(0, i).map(c => `${c}.eq.${literal(last[c])}`);
    return `and(${[...equal, gt].join(',')})`;
  }).join(',');
}

/**
 * Every row of the user's in one table, paged by key.
 *
 * Paged: PostgREST caps a select at 1000 rows, and the delete screens tell the
 * athlete to export first, so a capped export would lose their history for
 * good once the account goes. By key, not by offset: an insert or delete while
 * the table is read (a write-queue flush, a Health import, another device)
 * would shift an offset page and skip or repeat a row that never changed. A
 * key cursor reads every row that exists throughout, with its key unchanged,
 * exactly once. Rows written mid-read appear or not, as of when their page was
 * read. A row whose key itself changes mid-read (relabelTrackedEventId) can
 * still appear twice or not at all; only one snapshot, a single SQL function,
 * prevents that.
 *
 * Done at the first empty page, not the first short one: PostgREST's max_rows
 * caps every page, and a cap below PAGE_SIZE would make the first full page
 * look like the last. The empty page costs one read per non-empty table.
 */
async function readTable(
  supabase: Admin,
  table: (typeof EXPORTED_TABLES)[number] | keyof typeof SUMMARIES,
  userId: string,
  order: readonly string[],
  columns = '*',
) {
  const rows: Record<string, unknown>[] = [];
  for (let last: Record<string, unknown> | undefined; ;) {
    let query = supabase.from(table).select(columns).eq('user_id', userId);
    if (last) {
      query = order.length === 1
        ? query.gt(order[0] as never, last[order[0]] as never)
        : query.or(afterKey(order, last));
    }
    for (const column of order) query = query.order(column as never, { ascending: true });
    const { data, error } = await query.limit(PAGE_SIZE);
    // A table whose migration has not reached this database yet holds no rows
    // for anyone: export it empty rather than fail the whole export.
    // Migrations are pasted into production by hand and can trail the code
    // that lists their tables here (phase59's daily_metrics). Only on the
    // first page: after it, the table existed, and an empty answer would be a
    // failure presented as a download.
    if (error && isTableMissing(error) && !last) return [];
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    if (page.length === 0) break;
    rows.push(...page);
    last = page[page.length - 1];
  }
  // A key cursor cannot read a key twice; if it ever does, the order is not
  // the table's key, and the copy would be wrong.
  const keys = new Set(rows.map(row => JSON.stringify(order.map(column => row[column]))));
  if (keys.size !== rows.length) throw new Error(`${table}: a key was read twice; its export order is not its key`);
  return rows;
}

/** A summary's rows, with its named columns and nothing else. */
async function readSummary(supabase: Admin, table: keyof typeof SUMMARIES, userId: string) {
  const { columns, order } = SUMMARIES[table];
  const rows = await readTable(supabase, table, userId, order, [...new Set([...order, ...columns])].join(', '));
  return rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
}

async function buildExport(supabase: Admin, userId: string) {
  // The authentication record first: if it cannot be read there is no
  // complete export, and nothing else is worth reading. The email address and
  // the 18+ confirmation (app_metadata.age_confirmed_at) are records we hold
  // too (privacy-v2 §2). Never the password hash, identity tokens or MFA
  // secrets: the fields below are named, not spread.
  const { data: auth, error: authErr } = await supabase.auth.admin.getUserById(userId);
  if (authErr || !auth.user) throw new Error(`auth user: ${authErr?.message ?? 'not found'}`);
  const user = auth.user;
  const account = {
    email: user.email ?? null,
    pendingEmail: user.new_email ?? null,
    phone: user.phone || null,
    createdAt: user.created_at,
    updatedAt: user.updated_at ?? null,
    invitedAt: user.invited_at ?? null,
    confirmationSentAt: user.confirmation_sent_at ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    recoverySentAt: user.recovery_sent_at ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
    appMetadata: user.app_metadata ?? {},
    userMetadata: user.user_metadata ?? {},
    identities: (user.identities ?? []).map(i => ({
      provider: i.provider,
      createdAt: i.created_at ?? null,
      lastSignInAt: i.last_sign_in_at ?? null,
    })),
    factors: (user.factors ?? []).map(f => ({
      type: f.factor_type,
      status: f.status,
      createdAt: f.created_at,
    })),
  };

  const data: Record<string, unknown> = {};

  const { data: profile, error: profileErr } = await supabase
    .from('profiles').select('*').eq('id', userId).maybeSingle();
  if (profileErr) throw new Error(`profiles: ${profileErr.message}`);
  data.profiles = profile ?? null;

  // Sequential rather than Promise.all: one export is a rare, unbounded read
  // over every table a user owns, and firing all of them at once is how a
  // single click becomes a database incident.
  for (const table of EXPORTED_TABLES) {
    data[table] = await readTable(supabase, table, userId, EXPORT_ORDER[table] ?? ['id']);
  }

  // Token metadata is genuinely the user's — which clients they connected
  // and when — even though the hashes are not. Connections without their
  // tokens: which providers, since when, and the Health categories the
  // athlete consented to (phase59). A failed read fails the export, like any
  // table's: an empty summary would be a wrong record presented as a download.
  const mcpTokenSummary = await readSummary(supabase, 'mcp_tokens', userId);
  const providerConnectionSummary = await readSummary(supabase, 'provider_connections', userId);

  return {
    exportedAt: new Date().toISOString(),
    userId,
    account,
    notes: REDACTED_TABLES,
    mcpTokenSummary,
    providerConnectionSummary,
    data,
  };
}

/** Bytes per res.write: the export streams, so no single body has to fit. */
const CHUNK_BYTES = 256 * 1024;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    res.status(405).send('Method not allowed');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res, { skipTermsGate: true });
  if (!userId) return;
  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  if (req.method === 'GET') {
    try {
      // Every read finishes before the first byte, so any failure is still a
      // clean 500 rather than a cut-off file presented as a download.
      // Encoded once, then sliced as bytes: slicing the string could split a
      // surrogate pair, and each half would be written as U+FFFD.
      const body = Buffer.from(JSON.stringify(await buildExport(supabase, userId)), 'utf8');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="apex-training-export.json"');
      // Everything the account holds: never kept by a browser, proxy or URLCache.
      res.setHeader('Cache-Control', 'no-store');
      // Streamed in chunks: Vercel refuses a buffered function response over
      // 4.5 MB, and one long history with watch streams passes that; a
      // streamed response has no such limit. Compact, for the same reason.
      res.status(200);
      for (let at = 0; at < body.length; at += CHUNK_BYTES) res.write(body.subarray(at, at + CHUNK_BYTES));
      res.end();
    } catch (err) {
      console.error('[api/account] export failed:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to build export');
    }
    return;
  }

  // DELETE — irreversible, so it demands an explicit confirmation field. Not
  // security (the JWT already proved who they are); a guard against a
  // mis-wired client turning a stray request into an account deletion.
  const body = req.body as { confirm?: unknown } | undefined;
  if (body?.confirm !== 'DELETE') {
    res.status(400).send('Send { "confirm": "DELETE" } to delete this account');
    return;
  }

  // Sweep non-cascading tables first: a failure here leaves the account
  // intact and retryable, whereas the reverse order would strand rows under
  // a user id that no longer exists.
  for (const table of NON_CASCADING_TABLES) {
    const { error } = await supabase.from(table).delete().eq('user_id', userId);
    if (error) {
      console.error(`[api/account] pre-delete sweep of ${table} failed:`, error.message);
      res.status(500).send('Failed to delete account');
      return;
    }
  }

  // No upstream revocation happens here, and it is not an oversight: the
  // provider_connections row (tokens included) cascades away with the auth
  // user, but the OAuth grant itself lives at COROS, whose revocation endpoint
  // refuses public clients — see src/lib/sync/corosRevocation.ts for the
  // evidence. The user is told to remove Apex in the COROS app before they
  // delete (COROS_DELETE_NOTICE, shown in Profile → Your data), because
  // afterwards there is no account left to tell.
  //
  // Deleting the auth user cascades into every table that references it,
  // which is all of USER_DATA_TABLES — verified by api/__tests__/account.test.ts.
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) {
    console.error('[api/account] auth delete failed:', error.message);
    res.status(500).send('Failed to delete account');
    return;
  }

  console.log('[api/account] deleted account', userId);
  res.status(200).json({ ok: true, deleted: userId });
}
