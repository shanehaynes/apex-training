import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { canonicalResource, publicOrigin, redirectUriMatches } from '../oauth/common.js';

// OAuth 2.1 authorization endpoint. Validates the request, then hands off to
// the SPA consent page (/connect) with the parameters echoed in the query —
// the browser is already (or will be) signed in to Supabase there, and the
// consent page calls /api/oauth-approve with the user's JWT to mint the
// code. No code is minted here.
//
// Error routing follows RFC 6749 §4.1.2.1: an invalid client_id or
// redirect_uri gets a 400 page (NEVER a redirect to an unvalidated URI);
// every other problem redirects back to the client with error params.

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

const q = (req: VercelRequest, key: string): string | undefined => {
  const v = req.query[key];
  return typeof v === 'string' && v ? v : undefined;
};

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

  const clientId = q(req, 'client_id');
  const redirectUri = q(req, 'redirect_uri');
  if (!clientId || !redirectUri) {
    res.status(400).send('Missing client_id or redirect_uri');
    return;
  }

  const { data: client } = await supabase
    .from('oauth_clients')
    .select('client_id, client_name, redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle<ClientRow>();
  if (!client) {
    res.status(400).send('Unknown client_id');
    return;
  }
  if (!(client.redirect_uris ?? []).some(r => redirectUriMatches(r, redirectUri))) {
    res.status(400).send('redirect_uri is not registered for this client');
    return;
  }

  const state = q(req, 'state');
  const fail = (error: string, description: string) => {
    const params = new URLSearchParams({ error, error_description: description });
    if (state) params.set('state', state);
    res.status(302).setHeader('Location', `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}${params}`);
    res.end();
  };

  if (q(req, 'response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
  const codeChallenge = q(req, 'code_challenge');
  if (!codeChallenge) return fail('invalid_request', 'code_challenge is required (PKCE)');
  if ((q(req, 'code_challenge_method') ?? 'plain') !== 'S256') {
    return fail('invalid_request', 'Only code_challenge_method=S256 is supported');
  }
  const origin = publicOrigin(req);
  const resource = q(req, 'resource');
  if (resource && resource !== canonicalResource(origin) && resource !== origin) {
    return fail('invalid_target', `Unknown resource; this server is ${canonicalResource(origin)}`);
  }

  // Hand off to the SPA consent page with everything oauth-approve needs to
  // re-validate, plus the client name for display.
  const consent = new URLSearchParams({
    client_id: clientId,
    client_name: client.client_name,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
  });
  const scope = q(req, 'scope');
  if (scope) consent.set('scope', scope);
  if (resource) consent.set('resource', resource);
  if (state) consent.set('state', state);

  res.status(302).setHeader('Location', `${origin}/connect?${consent}`);
  res.end();
}
