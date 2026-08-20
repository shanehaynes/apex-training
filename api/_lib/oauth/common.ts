import { createHash, randomBytes } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';

// Shared pieces of the OAuth 2.1 authorization server that fronts the MCP
// endpoint: origin/URL derivation, PKCE S256, redirect-URI matching, and
// form-body tolerance. Pure except for crypto randomness.

export const OAUTH_SCOPE = 'mcp:read';

/** Access tokens live 1 hour; refresh tokens until revoked. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
/** Authorization codes are one-shot and short-lived. */
export const CODE_TTL_SECONDS = 60;

export const REFRESH_TOKEN_PREFIX = 'apxr_';

/**
 * Origin taken from the request itself, e.g. "https://apex.example.com".
 * Trusts x-forwarded-proto (Vercel sets it); local dev (no forwarded proto)
 * falls back to http for localhost and https otherwise.
 *
 * Prefer publicOrigin() for anything a client stores — this varies with
 * whichever host served the request.
 */
export function requestOrigin(req: VercelRequest): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  return `${proto}://${host}`;
}

/**
 * The canonical origin this deployment publishes as.
 *
 * Every OAuth identifier is derived from it — issuer, the three endpoints,
 * and the RFC 8707 resource — and a connector records those at registration
 * time, so they must not vary with the host that happened to serve the
 * discovery request. Vercel deployment URLs (apex-training-<hash>.vercel.app)
 * are per-build and frozen, so metadata minted from one pins the client to
 * code that will never be updated, on a URL that eventually 404s.
 *
 * VITE_PUBLIC_ORIGIN pins it to the real domain instead. Unset — local dev,
 * e2e, preview deployments — falls back to the request's own host, which is
 * what those need.
 */
export function publicOrigin(req: VercelRequest): string {
  return normalizeOrigin(process.env.VITE_PUBLIC_ORIGIN) ?? requestOrigin(req);
}

/** Origin part of a configured URL, or undefined if it isn't a usable one. */
function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    console.warn(`[oauth] VITE_PUBLIC_ORIGIN is not a URL: ${value} — falling back to the request host`);
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    console.warn(`[oauth] VITE_PUBLIC_ORIGIN is not http(s): ${value} — falling back to the request host`);
    return undefined;
  }
  return url.origin;
}

/** The canonical RFC 8707 resource identifier for the MCP server. */
export function canonicalResource(origin: string): string {
  return `${origin}/api/mcp`;
}

export function sha256base64url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/** PKCE S256: does the verifier hash to the stored challenge? */
export function verifyPkce(verifier: string, challenge: string): boolean {
  return sha256base64url(verifier) === challenge;
}

export function generateClientId(): string {
  return 'mcp_' + randomBytes(16).toString('base64url');
}

export function generateAuthorizationCode(): string {
  return randomBytes(32).toString('base64url');
}

export function generateRefreshToken(): string {
  return REFRESH_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

const LOOPBACK_RE = /^(127\.0\.0\.1|localhost|\[::1\])$/;

/**
 * A registerable redirect URI: https anywhere, or http on a loopback host
 * (native clients — Claude Code — use loopback redirects).
 */
export function isValidRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_RE.test(url.hostname);
}

/**
 * OAuth 2.1 redirect matching: exact string match, except loopback URIs
 * compare ignoring the port (native clients bind an ephemeral port per run).
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let a: URL, b: URL;
  try {
    a = new URL(registered);
    b = new URL(requested);
  } catch {
    return false;
  }
  if (!(a.protocol === 'http:' && LOOPBACK_RE.test(a.hostname))) return false;
  return (
    b.protocol === a.protocol &&
    LOOPBACK_RE.test(b.hostname) &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
}

/**
 * Token-endpoint bodies arrive as application/x-www-form-urlencoded (per
 * OAuth), which Vercel parses to an object but the dev plugin leaves as a
 * raw string. JSON is tolerated too.
 */
export function parseFormBody(body: unknown): Record<string, string> {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      try {
        return parseFormBody(JSON.parse(trimmed));
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(body));
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
    return out;
  }
  return {};
}
