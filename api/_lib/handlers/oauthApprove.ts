import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { sha256hex } from '../mcp/tokens.js';
import {
  CODE_TTL_SECONDS,
  generateAuthorizationCode,
  OAUTH_SCOPE,
  redirectUriMatches,
} from '../oauth/common.js';

// Consent decision endpoint, called by the SPA's /connect page with the
// signed-in user's Supabase JWT. Re-validates the authorize parameters
// (the query string that reached the SPA is attacker-influenceable), mints
// the one-shot PKCE code on approval, and returns the redirect target for
// the SPA to navigate to. The user identity comes exclusively from the JWT.

interface ClientRow {
  client_id: string;
  redirect_uris: string[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }
  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' && body[k] ? (body[k] as string) : undefined);

  const clientId = str('client_id');
  const redirectUri = str('redirect_uri');
  const codeChallenge = str('code_challenge');
  const decision = str('decision');
  const state = str('state');
  if (!clientId || !redirectUri || !codeChallenge || (decision !== 'approve' && decision !== 'deny')) {
    res.status(400).send('Missing or invalid consent fields');
    return;
  }

  const { data: client } = await supabase
    .from('oauth_clients')
    .select('client_id, redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle<ClientRow>();
  if (!client || !(client.redirect_uris ?? []).some(r => redirectUriMatches(r, redirectUri))) {
    res.status(400).send('Unknown client or unregistered redirect_uri');
    return;
  }

  const sep = redirectUri.includes('?') ? '&' : '?';

  if (decision === 'deny') {
    const params = new URLSearchParams({ error: 'access_denied' });
    if (state) params.set('state', state);
    res.status(200).json({ redirect_to: `${redirectUri}${sep}${params}` });
    return;
  }

  const code = generateAuthorizationCode();
  const { error } = await supabase.from('oauth_codes').insert({
    code_hash: sha256hex(code),
    user_id: userId,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    scope: str('scope') ?? OAUTH_SCOPE,
    resource: str('resource') ?? null,
    expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) {
    console.error('[oauth-approve] code insert failed:', error.message);
    res.status(500).send('Failed to create authorization code');
    return;
  }

  const params = new URLSearchParams({ code });
  if (state) params.set('state', state);
  res.status(200).json({ redirect_to: `${redirectUri}${sep}${params}` });
}
