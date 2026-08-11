import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { completeOAuth, findPendingByState } from '../providers/connection.js';
import { exchangeCode, OAuthTokenError } from '../providers/coros/oauth.js';

// OAuth redirect target for provider connections. Arrives as a plain
// browser navigation from the provider's consent screen — no Supabase JWT
// — so identity comes from the unguessable state value parked on the
// pending provider_connections row by connect-start (128-bit random,
// 10-minute TTL, cleared on use). GET only; on success or failure we
// bounce back into the SPA, which shows the outcome via query params.

const OK_REDIRECT = '/?connected=coros';
const FAIL_REDIRECT = '/?connect_error=coros';

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

  if (providerError || !state || !code) {
    // User declined at COROS, or a mangled redirect. Nothing to clean up —
    // the pending row expires on its own TTL.
    res.redirect(302, FAIL_REDIRECT);
    return;
  }

  try {
    const pending = await findPendingByState(supabase, 'coros', state);
    if (!pending) {
      res.redirect(302, FAIL_REDIRECT);
      return;
    }
    const tokens = await exchangeCode(code, pending.codeVerifier);
    await completeOAuth(supabase, pending.userId, 'coros', tokens);
    res.redirect(302, OK_REDIRECT);
  } catch (err) {
    const detail = err instanceof OAuthTokenError ? err.code : err instanceof Error ? err.message : 'unknown';
    console.error('[api/provider-callback] exchange failed:', detail);
    res.redirect(302, FAIL_REDIRECT);
  }
}
