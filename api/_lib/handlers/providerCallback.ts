import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import {
  completeOAuth,
  findPendingByState,
  type PendingLookup,
  type ProviderClient,
} from '../providers/connection.js';
import { exchangeCode, OAuthTokenError } from '../providers/coros/oauth.js';

// OAuth redirect target for provider connections. Arrives as a plain
// browser navigation from the provider's consent screen — no Supabase JWT
// — so identity comes from the unguessable state value parked on the
// pending provider_connections row by connect-start (128-bit random,
// 10-minute TTL, cleared on use). GET only; on success or failure we
// bounce back into the SPA, which shows the outcome via query params.
//
// W11: the same flow runs inside the native app's ASWebAuthenticationSession,
// which only closes when the redirect hits the app's own scheme. connect-start
// records which client started the dance on the pending row (phase41), and
// that decides the target here. The web's two strings are byte-identical to
// what src/components/sync/ProviderSyncControls.tsx has always parsed.

const WEB_OK = '/?connected=coros';
const WEB_FAIL = '/?connect_error=coros';
const IOS_OK = 'apextraining://connected?provider=coros';

/** Why a connect failed. iOS-only: the web target never carries a reason, and
 *  the SPA's toast has never distinguished them. */
type FailReason = 'denied' | 'missing_code' | 'expired' | 'exchange_failed';

function failTarget(client: ProviderClient, reason: FailReason): string {
  return client === 'ios'
    ? `apextraining://connect_error?provider=coros&reason=${reason}`
    : WEB_FAIL;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const providerError = typeof req.query.error === 'string' ? req.query.error : '';

  // The pending row is read before any failure branch, because the row is the
  // only place the client is recorded and the commonest failures — declining at
  // COROS, and a consent screen left open past the 10-minute TTL — have to
  // dismiss the in-app browser just as a success does. Its own try/catch: a
  // lookup or decrypt failure must still redirect, and with no row to read the
  // client is genuinely unknowable, so it falls back to the web.
  let pending: PendingLookup = { ok: false, client: null };
  if (state) {
    try {
      pending = await findPendingByState(supabase, 'coros', state);
    } catch (err) {
      console.error('[api/provider-callback] pending lookup failed:', err instanceof Error ? err.message : err);
    }
  }
  const client = pending.client;
  const fail = (reason: FailReason): void => { res.redirect(302, failTarget(client, reason)); };

  // User declined at COROS, or a mangled redirect. Nothing to clean up —
  // the pending row expires on its own TTL.
  if (providerError) { fail('denied'); return; }
  if (!state || !code) { fail('missing_code'); return; }
  if (!pending.ok) { fail('expired'); return; }

  try {
    const tokens = await exchangeCode(code, pending.codeVerifier);
    await completeOAuth(supabase, pending.userId, 'coros', tokens);
    res.redirect(302, client === 'ios' ? IOS_OK : WEB_OK);
  } catch (err) {
    const detail = err instanceof OAuthTokenError ? err.code : err instanceof Error ? err.message : 'unknown';
    console.error('[api/provider-callback] exchange failed:', detail);
    fail('exchange_failed');
  }
}
