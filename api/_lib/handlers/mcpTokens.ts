import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { generateMcpToken, sha256hex } from '../mcp/tokens.js';

// Mint / list / revoke personal access tokens for the MCP endpoint. Called
// only by the SPA (Supabase JWT auth). The plaintext token leaves the server
// exactly once — in the POST response; only its sha256 is stored.

const MAX_ACTIVE_TOKENS = 10;
const MAX_NAME_LENGTH = 60;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  if (req.method === 'GET') {
    const [patRes, grantRes] = await Promise.all([
      supabase
        .from('mcp_tokens')
        .select('id, name, token_last4, created_at, last_used_at, revoked_at')
        .eq('user_id', userId)
        .eq('kind', 'pat')
        .order('created_at', { ascending: false }),
      // OAuth connections, one per client: the refresh grant is the durable
      // half of a connection (access tokens expire hourly).
      supabase
        .from('mcp_tokens')
        .select('name, client_id, created_at, last_used_at')
        .eq('user_id', userId)
        .eq('kind', 'refresh')
        .is('revoked_at', null)
        .order('created_at', { ascending: false }),
    ]);
    if (patRes.error || grantRes.error) {
      console.error('[api/mcp-tokens] list failed:', patRes.error?.message ?? grantRes.error?.message);
      res.status(500).send('Failed to list tokens');
      return;
    }
    const connections = new Map<string, { client_id: string; name: string; created_at: string }>();
    for (const g of grantRes.data ?? []) {
      if (g.client_id && !connections.has(g.client_id)) {
        connections.set(g.client_id, { client_id: g.client_id, name: g.name, created_at: g.created_at });
      }
    }
    res.status(200).json({ tokens: patRes.data ?? [], connections: [...connections.values()] });
    return;
  }

  if (req.method === 'POST') {
    if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

    const body = req.body as { name?: unknown } | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      res.status(400).send(`Token name must be 1–${MAX_NAME_LENGTH} characters`);
      return;
    }

    const { count, error: countErr } = await supabase
      .from('mcp_tokens')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('kind', 'pat')
      .is('revoked_at', null);
    if (countErr) {
      console.error('[api/mcp-tokens] count failed:', countErr.message);
      res.status(500).send('Failed to create token');
      return;
    }
    if ((count ?? 0) >= MAX_ACTIVE_TOKENS) {
      res.status(400).send(`Token limit reached (${MAX_ACTIVE_TOKENS} active) — revoke one first`);
      return;
    }

    const token = generateMcpToken();
    const { data, error } = await supabase
      .from('mcp_tokens')
      .insert({
        user_id: userId,
        token_hash: sha256hex(token),
        token_last4: token.slice(-4),
        name,
      })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[api/mcp-tokens] insert failed:', error?.message);
      res.status(500).send('Failed to create token');
      return;
    }
    // The only response that ever carries the plaintext token.
    res.status(200).json({ id: data.id, token });
    return;
  }

  if (req.method === 'DELETE') {
    if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

    // ?client_id= disconnects an OAuth client: every live token it holds
    // (access + refresh) is revoked in one shot.
    const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : undefined;
    if (clientId) {
      const { data, error } = await supabase
        .from('mcp_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('client_id', clientId)
        .is('revoked_at', null)
        .select('id');
      if (error) {
        console.error('[api/mcp-tokens] disconnect failed:', error.message);
        res.status(500).send('Failed to disconnect');
        return;
      }
      if (!data || data.length === 0) {
        res.status(404).send('Connection not found');
        return;
      }
      res.status(200).json({ ok: true, revoked: data.length });
      return;
    }

    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    if (!id) {
      res.status(400).send('Missing token id');
      return;
    }
    // Revoke rather than delete: last_used_at history survives for the list.
    const { data, error } = await supabase
      .from('mcp_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .select('id');
    if (error) {
      console.error('[api/mcp-tokens] revoke failed:', error.message);
      res.status(500).send('Failed to revoke token');
      return;
    }
    if (!data || data.length === 0) {
      res.status(404).send('Token not found');
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
