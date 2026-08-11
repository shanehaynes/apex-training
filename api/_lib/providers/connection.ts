import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { decryptSecret, encryptSecret, hasEncryptionSecret } from '../keyCrypto.js';
import { OAuthTokenError, refreshTokens, type TokenResponse } from './coros/oauth.js';

// provider_connections access (phase27). Provider-generic on purpose: the
// row shape, encryption, and refresh flow are identical for Garmin/Apple
// later; only the refresh call itself is provider-dispatched.
//
// RULE (anthropicKey.ts precedent): raw OAuth tokens leave this module only
// via getFreshAccessToken, and only into the outbound MCP client. Never log
// them, never include them in a response body. The browser sees only the
// status projection from connectionStatus().

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export type SyncProvider = 'coros';

export interface ConnectionRow {
  user_id: string;
  provider: SyncProvider;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  status: 'pending' | 'connected' | 'expired';
  pending_oauth: { state?: string; codeVerifier?: string; createdAt?: string } | null;
  last_synced_at: string | null;
  connected_at: string | null;
  /** IANA zone stamped from the browser on manual actions; the nightly cron's
   *  only way to place activities on the user's calendar dates. */
  timezone: string | null;
  /** Per-connection opt-out for the nightly cron. */
  auto_sync: boolean;
  /** Matches awaiting a fill/keep-separate decision — the Sync-button badge. */
  pending_fill_count: number;
}

/** Encrypt when the secret is configured; plaintext + loud log otherwise
 *  (keyCrypto contract — the env var can be introduced without a migration). */
function sealed(value: string): string {
  if (!hasEncryptionSecret()) {
    console.error('[providers] API_KEY_ENCRYPTION_SECRET is not set — storing OAuth token UNENCRYPTED');
    return value;
  }
  return encryptSecret(value);
}

function unsealed(value: string): string {
  return value.startsWith('enc:v1:') ? decryptSecret(value) : value;
}

export async function getConnection(
  supabase: Admin, userId: string, provider: SyncProvider,
): Promise<ConnectionRow | null> {
  const { data, error } = await supabase
    .from('provider_connections')
    .select('user_id, provider, access_token, refresh_token, token_expires_at, status, pending_oauth, last_synced_at, connected_at, timezone, auto_sync, pending_fill_count')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw new Error(`provider_connections lookup failed: ${error.message}`);
  return (data as ConnectionRow | null) ?? null;
}

/** The only projection the browser ever sees. */
export function connectionStatus(row: ConnectionRow | null): {
  status: 'disconnected' | 'pending' | 'connected' | 'expired';
  lastSyncedAt: string | null;
  connectedAt: string | null;
  autoSync: boolean;
  pendingFillCount: number;
} {
  if (!row) return { status: 'disconnected', lastSyncedAt: null, connectedAt: null, autoSync: true, pendingFillCount: 0 };
  return {
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    connectedAt: row.connected_at,
    autoSync: row.auto_sync ?? true,
    pendingFillCount: row.pending_fill_count ?? 0,
  };
}

/** Remember the browser's IANA zone for the nightly cron. Best-effort. */
export async function stampTimezone(
  supabase: Admin, userId: string, provider: SyncProvider, timezone: string,
): Promise<void> {
  const { error } = await supabase
    .from('provider_connections')
    .update({ timezone, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) console.error('[providers] stampTimezone failed:', error.message);
}

export async function setAutoSync(
  supabase: Admin, userId: string, provider: SyncProvider, enabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('provider_connections')
    .update({ auto_sync: enabled, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) throw new Error(`setAutoSync failed: ${error.message}`);
}

export async function setPendingFillCount(
  supabase: Admin, userId: string, provider: SyncProvider, count: number,
): Promise<void> {
  const { error } = await supabase
    .from('provider_connections')
    .update({ pending_fill_count: count, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) console.error('[providers] setPendingFillCount failed:', error.message);
}

/** Every connected row eligible for the nightly job, all providers. */
export async function listAutoSyncConnections(
  supabase: Admin,
): Promise<{ user_id: string; provider: SyncProvider; timezone: string | null }[]> {
  const { data, error } = await supabase
    .from('provider_connections')
    .select('user_id, provider, timezone')
    .eq('status', 'connected')
    .eq('auto_sync', true);
  if (error) throw new Error(`auto-sync listing failed: ${error.message}`);
  return (data ?? []) as { user_id: string; provider: SyncProvider; timezone: string | null }[];
}

/** Start the redirect dance: park state + encrypted PKCE verifier on the row. */
export async function beginOAuth(
  supabase: Admin, userId: string, provider: SyncProvider, state: string, codeVerifier: string,
): Promise<void> {
  const { error } = await supabase
    .from('provider_connections')
    .upsert({
      user_id: userId,
      provider,
      status: 'pending',
      pending_oauth: { state, codeVerifier: sealed(codeVerifier), createdAt: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider' });
  if (error) throw new Error(`beginOAuth upsert failed: ${error.message}`);
}

const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;

/** Locate the pending row for a callback by its unguessable state value. */
export async function findPendingByState(
  supabase: Admin, provider: SyncProvider, state: string,
): Promise<{ userId: string; codeVerifier: string } | null> {
  const { data, error } = await supabase
    .from('provider_connections')
    .select('user_id, pending_oauth')
    .eq('provider', provider)
    .eq('pending_oauth->>state', state)
    .maybeSingle();
  if (error) throw new Error(`pending-state lookup failed: ${error.message}`);
  const pending = (data?.pending_oauth ?? null) as ConnectionRow['pending_oauth'];
  if (!data || !pending?.codeVerifier || !pending.createdAt) return null;
  if (Date.now() - Date.parse(pending.createdAt) > PENDING_OAUTH_TTL_MS) return null;
  return { userId: data.user_id as string, codeVerifier: unsealed(pending.codeVerifier) };
}

function tokenPatch(tokens: TokenResponse): Record<string, unknown> {
  return {
    access_token: sealed(tokens.access_token),
    // Rotation-safe: keep the old refresh token when the response omits one.
    ...(tokens.refresh_token ? { refresh_token: sealed(tokens.refresh_token) } : {}),
    token_expires_at: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  };
}

/** Callback success: store tokens, flip to connected, clear the dance state. */
export async function completeOAuth(
  supabase: Admin, userId: string, provider: SyncProvider, tokens: TokenResponse,
): Promise<void> {
  const { error } = await supabase
    .from('provider_connections')
    .update({
      ...tokenPatch(tokens),
      status: 'connected',
      connected_at: new Date().toISOString(),
      pending_oauth: null,
    })
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) throw new Error(`completeOAuth update failed: ${error.message}`);
}

export class NotConnectedError extends Error {
  constructor(readonly reason: 'disconnected' | 'expired') {
    super(`provider connection ${reason}`);
  }
}

const REFRESH_SKEW_MS = 60 * 1000;

/**
 * The raw access token, refreshed when expiring within 60 s. On a refused
 * refresh (invalid_grant — revoked or rotten) the row flips to 'expired'
 * so Profile shows "Reconnect", and NotConnectedError surfaces to the
 * caller as a 409.
 */
export async function getFreshAccessToken(
  supabase: Admin, userId: string, provider: SyncProvider,
): Promise<string> {
  const row = await getConnection(supabase, userId, provider);
  if (!row || row.status !== 'connected' || !row.access_token) {
    throw new NotConnectedError(row?.status === 'expired' ? 'expired' : 'disconnected');
  }

  const freshUntil = row.token_expires_at ? Date.parse(row.token_expires_at) - REFRESH_SKEW_MS : Infinity;
  if (Date.now() < freshUntil) return unsealed(row.access_token);

  if (!row.refresh_token) {
    await markExpired(supabase, userId, provider);
    throw new NotConnectedError('expired');
  }
  try {
    const tokens = await refreshTokens(unsealed(row.refresh_token));
    const { error } = await supabase
      .from('provider_connections')
      .update(tokenPatch(tokens))
      .eq('user_id', userId)
      .eq('provider', provider);
    if (error) throw new Error(`token refresh persist failed: ${error.message}`);
    return tokens.access_token;
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      await markExpired(supabase, userId, provider);
      throw new NotConnectedError('expired');
    }
    throw err;
  }
}

async function markExpired(supabase: Admin, userId: string, provider: SyncProvider): Promise<void> {
  const { error } = await supabase
    .from('provider_connections')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) console.error('[providers] markExpired failed:', error.message);
}

/** Stamp the activity-grab watermark after a successful apply. */
export async function recordSync(
  supabase: Admin, userId: string, provider: SyncProvider,
): Promise<void> {
  const { error } = await supabase
    .from('provider_connections')
    .update({ last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) throw new Error(`recordSync failed: ${error.message}`);
}

/** Drop the connection row; the imports ledger and streams stay. */
export async function disconnect(
  supabase: Admin, userId: string, provider: SyncProvider,
): Promise<void> {
  const { error } = await supabase
    .from('provider_connections')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) throw new Error(`disconnect failed: ${error.message}`);
}
