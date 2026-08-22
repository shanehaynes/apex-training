import { createHash, randomBytes } from 'node:crypto';
import { optionalEnv, requireEnv } from '../../env.js';

// OAuth 2.1 client for the official COROS remote MCP server. Verified by
// scripts/coros-spike.mjs on 2026-08-10 (frozen in
// api/__tests__/fixtures/coros/oauth-discovery.json): the MCP endpoint
// 401s with a WWW-Authenticate pointing at RFC 9728 protected-resource
// metadata on https://mcpus.coros.com, whose RFC 8414 authorization-server
// metadata offers auth-code + PKCE S256, refresh_token grant, scopes
// "openid mcp.tools offline_access", and OPEN dynamic client registration
// (public clients, token_endpoint_auth_method "none", arbitrary https and
// localhost redirect URIs).
//
// The production client is minted once via that DCR endpoint (run
// `node scripts/coros-spike.mjs discover` with the real callback URL) and
// pinned as COROS_CLIENT_ID; COROS_REDIRECT_URI must exactly match a
// registered redirect. No client secret exists — PKCE carries the proof.

export const COROS_MCP_ENDPOINT = 'https://mcp.coros.com/mcp';
export const COROS_SCOPES = 'openid mcp.tools offline_access';

export interface AuthServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  /** RFC 8707 resource indicator — the protected resource the token is for. */
  resource: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

// Module-level cache: discovery docs are static per deploy region and a
// lambda instance serves many requests.
let cachedMeta: AuthServerMeta | null = null;

async function fetchJson(url: string | URL): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  try {
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Resolve the COROS authorization server via MCP 2025-06-18 discovery. */
export async function discoverAuthServer(): Promise<AuthServerMeta> {
  if (cachedMeta) return cachedMeta;

  // An unauthenticated initialize yields the WWW-Authenticate header whose
  // resource_metadata URL locates the protected-resource doc (RFC 9728).
  const probe = await fetch(COROS_MCP_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'apex-training', version: '1.0.0' } },
    }),
  });
  const www = probe.headers.get('www-authenticate') ?? '';
  const prmUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1]
    ?? new URL('/.well-known/oauth-protected-resource', COROS_MCP_ENDPOINT).href;

  const prm = await fetchJson(prmUrl);
  const asBase = (prm?.authorization_servers as string[] | undefined)?.[0]
    ?? new URL(COROS_MCP_ENDPOINT).origin;
  const resource = (prm?.resource as string | undefined) ?? asBase;

  const meta = await fetchJson(new URL('/.well-known/oauth-authorization-server', asBase));
  if (!meta?.authorization_endpoint || !meta.token_endpoint) {
    throw new Error('COROS OAuth discovery failed — no authorization server metadata');
  }
  cachedMeta = {
    issuer: String(meta.issuer ?? asBase),
    authorization_endpoint: String(meta.authorization_endpoint),
    token_endpoint: String(meta.token_endpoint),
    registration_endpoint: meta.registration_endpoint ? String(meta.registration_endpoint) : undefined,
    resource,
  };
  return cachedMeta;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function generateState(): string {
  return b64url(randomBytes(16));
}

function clientConfig(): { clientId: string; redirectUri: string } {
  return { clientId: requireEnv('COROS_CLIENT_ID'), redirectUri: requireEnv('COROS_REDIRECT_URI') };
}

export function isCorosConfigured(): boolean {
  return Boolean(optionalEnv('COROS_CLIENT_ID') && optionalEnv('COROS_REDIRECT_URI'));
}

export async function buildAuthorizeUrl(state: string, pkce: PkcePair): Promise<string> {
  const meta = await discoverAuthServer();
  const { clientId, redirectUri } = clientConfig();
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: COROS_SCOPES,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    resource: meta.resource,
  }).toString();
  return url.href;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const meta = await discoverAuthServer();
  const { clientId } = clientConfig();
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...params, client_id: clientId, resource: meta.resource }).toString(),
  });
  const body = await res.json().catch(() => null) as (TokenResponse & { error?: string }) | null;
  if (!res.ok || !body?.access_token) {
    // invalid_grant on refresh means the user must reconnect; surface the
    // OAuth error code, never the raw body (it could echo parameters).
    throw new OAuthTokenError(body?.error ?? `http_${res.status}`);
  }
  return body;
}

export class OAuthTokenError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`COROS token request failed: ${code}`);
    this.code = code;
  }
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const { redirectUri } = clientConfig();
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}
