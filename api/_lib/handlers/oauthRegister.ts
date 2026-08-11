import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { generateClientId, isValidRedirectUri } from '../oauth/common.js';

// RFC 7591 Dynamic Client Registration — how Claude/ChatGPT connectors mint
// a client_id on first connect. Necessarily unauthenticated (there is no
// user yet), so it cannot use the per-user rate limiter; the hard cap on
// total registered clients is the abuse guard, and registration stores
// nothing sensitive (public clients, PKCE, no secrets).

const MAX_CLIENTS = 500;
const MAX_REDIRECT_URIS = 10;
const MAX_NAME_LENGTH = 120;

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

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every(u => typeof u === 'string' && isValidRedirectUri(u))
  ) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris must be https URLs or http loopback URLs',
    });
    return;
  }
  const clientName = typeof body.client_name === 'string' ? body.client_name.trim().slice(0, MAX_NAME_LENGTH) : '';

  const { count, error: countErr } = await supabase
    .from('oauth_clients')
    .select('client_id', { count: 'exact', head: true });
  if (countErr) {
    console.error('[oauth-register] count failed:', countErr.message);
    res.status(500).send('Registration failed');
    return;
  }
  if ((count ?? 0) >= MAX_CLIENTS) {
    res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Registration closed' });
    return;
  }

  const clientId = generateClientId();
  const { error } = await supabase.from('oauth_clients').insert({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
  });
  if (error) {
    console.error('[oauth-register] insert failed:', error.message);
    res.status(500).send('Registration failed');
    return;
  }

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}
