import { createHash, randomBytes } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { scopeGrantsWrite } from '../oauth/common.js';

// Personal access tokens for the remote MCP endpoint. A token is
// `apx_` + base64url(32 random bytes), shown once at mint; only its
// sha256 hex lands in mcp_tokens.token_hash. The prefix keeps a
// mistakenly-pasted Supabase JWT from ever hitting the hash lookup, and
// lets OAuth access tokens (kind = 'oauth', expires_at set) share this
// exact resolution path.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export const MCP_TOKEN_PREFIX = 'apx_';

/** Stamp last_used_at at most this often — one write per tool call would be noise. */
const LAST_USED_STALE_MS = 5 * 60 * 1000;

export function generateMcpToken(): string {
  return MCP_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface TokenRow {
  id: string;
  user_id: string;
  last_used_at: string | null;
  scope: string | null;
}

/** What a resolved bearer token lets its holder do. */
export interface McpAccess {
  userId: string;
  /**
   * True only when the token's stored scope names mcp:write. A token whose
   * scope is NULL was minted before write access existed, under a promise
   * that the connection "can look but never change anything" — that promise
   * holds for the token's whole life. Write access is granted by minting a
   * new code or reconnecting the OAuth client, never retroactively.
   */
  canWrite: boolean;
}

/**
 * Resolve the request's bearer token to the access it grants, or null when
 * absent, malformed, unknown, revoked, or expired. Best-effort last_used_at
 * stamp (fire-and-forget, throttled) — display metadata, never a security input.
 */
export async function resolveMcpAccess(supabase: Admin, req: VercelRequest): Promise<McpAccess | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) return null;

  const { data, error } = await supabase
    .from('mcp_tokens')
    .select('id, user_id, last_used_at, scope')
    .eq('token_hash', sha256hex(token))
    .is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .maybeSingle<TokenRow>();
  if (error || !data) return null;

  const lastUsed = data.last_used_at ? Date.parse(data.last_used_at) : 0;
  if (Date.now() - lastUsed > LAST_USED_STALE_MS) {
    void supabase
      .from('mcp_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(({ error: e }) => {
        if (e) console.error('[mcp] last_used_at stamp failed:', e.message);
      });
  }

  return { userId: data.user_id, canWrite: scopeGrantsWrite(data.scope) };
}

/** The token's owner alone — for callers that only need identity. */
export async function resolveMcpToken(supabase: Admin, req: VercelRequest): Promise<string | null> {
  return (await resolveMcpAccess(supabase, req))?.userId ?? null;
}
