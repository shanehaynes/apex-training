import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';

// Account export and deletion — the two capabilities the Privacy Policy
// (legal/privacy-v1.md §6) promises, and which did not exist before it.
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
  'recurring_exceptions',
  'event_mutations_log',
  'workout_completions',
  'workout_completion_log',
  'workout_sessions',
  'workout_set_logs',
  'workout_cardio_logs',
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

/**
 * Tables holding secret material. Their existence is disclosed in the
 * export; their contents are not. Exporting an encrypted OAuth token or a
 * token hash would hand a copy of credential material to whatever the user
 * does with the download, and buys them nothing they can use.
 */
const REDACTED_TABLES = {
  user_api_keys: 'Your saved Anthropic API key is stored encrypted and is deliberately not exported. Remove or replace it in Profile → AI Coach.',
  mcp_tokens: 'Access tokens are stored only as hashes and cannot be recovered. Their names and usage dates are in the summary below.',
  provider_connections: 'Watch-provider OAuth tokens are stored encrypted and are deliberately not exported.',
  oauth_clients: 'OAuth client registrations belong to the connecting application, not to your account data.',
  oauth_codes: 'Short-lived OAuth authorization codes; they expire within minutes and are not exported.',
} as const;

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

async function buildExport(supabase: Admin, userId: string) {
  const data: Record<string, unknown> = {};

  const { data: profile, error: profileErr } = await supabase
    .from('profiles').select('*').eq('id', userId).maybeSingle();
  if (profileErr) throw new Error(`profiles: ${profileErr.message}`);
  data.profiles = profile ?? null;

  // Sequential rather than Promise.all: one export is a rare, unbounded read
  // over every table a user owns, and firing 23 of them at once is how a
  // single click becomes a database incident.
  for (const table of USER_DATA_TABLES) {
    const { data: rows, error } = await supabase.from(table).select('*').eq('user_id', userId);
    if (error) throw new Error(`${table}: ${error.message}`);
    data[table] = rows ?? [];
  }

  // Token metadata is genuinely the user's — which clients they connected
  // and when — even though the hashes are not.
  const { data: tokens } = await supabase
    .from('mcp_tokens')
    .select('name, token_last4, kind, created_at, last_used_at, revoked_at, expires_at')
    .eq('user_id', userId);

  return {
    exportedAt: new Date().toISOString(),
    userId,
    notes: REDACTED_TABLES,
    mcpTokenSummary: tokens ?? [],
    data,
  };
}

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
      const payload = await buildExport(supabase, userId);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="apex-training-export.json"');
      res.status(200).send(JSON.stringify(payload, null, 2));
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
