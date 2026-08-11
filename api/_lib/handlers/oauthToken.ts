import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { generateMcpToken, sha256hex } from '../mcp/tokens.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  OAUTH_SCOPE,
  parseFormBody,
  verifyPkce,
} from '../oauth/common.js';

// OAuth 2.1 token endpoint: exchanges a PKCE authorization code (or a
// refresh token) for tokens. Public clients only — client identity is the
// client_id + possession of the PKCE verifier / refresh token; there is no
// client secret. Access tokens are ordinary apx_ tokens minted into
// mcp_tokens (kind 'oauth', 1h expiry), so the MCP endpoint's auth path is
// unchanged. Refresh tokens rotate on every use.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

interface CodeRow {
  code_hash: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string | null;
  expires_at: string;
  consumed_at: string | null;
}

interface RefreshRow {
  id: string;
  user_id: string;
  client_id: string | null;
  scope: string | null;
  name: string;
}

function oauthError(res: VercelResponse, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

async function mintTokenPair(
  supabase: Admin,
  userId: string,
  clientId: string,
  clientName: string,
  scope: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const accessToken = generateMcpToken();
  const refreshToken = generateRefreshToken();
  const { error } = await supabase.from('mcp_tokens').insert([
    {
      user_id: userId,
      token_hash: sha256hex(accessToken),
      token_last4: accessToken.slice(-4),
      name: clientName,
      kind: 'oauth',
      client_id: clientId,
      scope,
      expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    },
    {
      user_id: userId,
      token_hash: sha256hex(refreshToken),
      token_last4: refreshToken.slice(-4),
      name: clientName,
      kind: 'refresh',
      client_id: clientId,
      scope,
    },
  ]);
  if (error) {
    console.error('[oauth-token] token insert failed:', error.message);
    return null;
  }
  return { accessToken, refreshToken };
}

async function clientNameOf(supabase: Admin, clientId: string): Promise<string> {
  const { data } = await supabase
    .from('oauth_clients')
    .select('client_name')
    .eq('client_id', clientId)
    .maybeSingle<{ client_name: string }>();
  return data?.client_name || 'OAuth client';
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

  const body = parseFormBody(req.body);
  const grantType = body.grant_type;

  if (grantType === 'authorization_code') {
    const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier } = body;
    if (!code || !redirectUri || !clientId || !codeVerifier) {
      return oauthError(res, 400, 'invalid_request', 'code, redirect_uri, client_id, and code_verifier are required');
    }

    // One-shot consume: the guarded update wins exactly once, so a replayed
    // code fails here even in a race.
    const { data: consumed, error } = await supabase
      .from('oauth_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('code_hash', sha256hex(code))
      .is('consumed_at', null)
      .select('code_hash, user_id, client_id, redirect_uri, code_challenge, scope, expires_at, consumed_at');
    if (error) {
      console.error('[oauth-token] code lookup failed:', error.message);
      res.status(500).send('Token exchange failed');
      return;
    }
    const row = (consumed?.[0] ?? null) as CodeRow | null;
    if (!row) return oauthError(res, 400, 'invalid_grant', 'Unknown, expired, or already-used code');
    if (Date.parse(row.expires_at) < Date.now()) {
      return oauthError(res, 400, 'invalid_grant', 'Authorization code expired');
    }
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return oauthError(res, 400, 'invalid_grant', 'client_id or redirect_uri does not match the authorization request');
    }
    if (!verifyPkce(codeVerifier, row.code_challenge)) {
      return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    }

    const scope = row.scope ?? OAUTH_SCOPE;
    const pair = await mintTokenPair(supabase, row.user_id, clientId, await clientNameOf(supabase, clientId), scope);
    if (!pair) {
      res.status(500).send('Token exchange failed');
      return;
    }
    res.status(200).json({
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: pair.refreshToken,
      scope,
    });
    return;
  }

  if (grantType === 'refresh_token') {
    const { refresh_token: refreshToken, client_id: clientId } = body;
    if (!refreshToken || !clientId) {
      return oauthError(res, 400, 'invalid_request', 'refresh_token and client_id are required');
    }

    // Rotate: revoking the presented token first makes reuse (or a race)
    // fail cleanly — each refresh token works exactly once.
    const { data: rotated, error } = await supabase
      .from('mcp_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('token_hash', sha256hex(refreshToken))
      .eq('kind', 'refresh')
      .is('revoked_at', null)
      .select('id, user_id, client_id, scope, name');
    if (error) {
      console.error('[oauth-token] refresh lookup failed:', error.message);
      res.status(500).send('Token refresh failed');
      return;
    }
    const row = (rotated?.[0] ?? null) as RefreshRow | null;
    if (!row || row.client_id !== clientId) {
      return oauthError(res, 400, 'invalid_grant', 'Unknown, revoked, or mismatched refresh token');
    }

    const scope = row.scope ?? OAUTH_SCOPE;
    const pair = await mintTokenPair(supabase, row.user_id, clientId, row.name, scope);
    if (!pair) {
      res.status(500).send('Token refresh failed');
      return;
    }
    res.status(200).json({
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: pair.refreshToken,
      scope,
    });
    return;
  }

  return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
}
