import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { enforceRateLimit } from '../rateLimit.js';
import { resolveMcpToken } from '../mcp/tokens.js';
import { handleMcpMessage, isJsonRpcRequest, RPC_INVALID_REQUEST, RPC_PARSE_ERROR } from '../mcp/protocol.js';
import { MCP_TOOLS } from '../mcp/toolRegistry.js';
import { OAUTH_SCOPE, requestOrigin } from '../oauth/common.js';

// Remote MCP server endpoint (Streamable HTTP, stateless). One POST per
// JSON-RPC message, application/json back — the 2025-06-18 spec allows a
// stateless server to skip SSE, session ids, and the GET stream entirely.
// Auth is a personal access token minted in Profile (see handlers/mcpTokens.ts);
// Stage 2 (OAuth) will add resource_metadata to the 401 challenge.

function rpcError(res: VercelResponse, code: number, message: string): void {
  res.status(200).json({ jsonrpc: '2.0', id: null, error: { code, message } });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).send('Method not allowed — this MCP server is stateless; POST JSON-RPC messages.');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await resolveMcpToken(supabase, req);
  if (!userId) {
    // resource_metadata points OAuth-capable clients (claude.ai, ChatGPT) at
    // the RFC 9728 discovery document, which starts the sign-in flow.
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="apex-training", resource_metadata="${requestOrigin(req)}/.well-known/oauth-protected-resource", scope="${OAUTH_SCOPE}"`,
    );
    res.status(401).send('Missing or invalid access token. Connect via OAuth, or mint a token in Apex Training → Profile → AI connector.');
    return;
  }

  if (!(await enforceRateLimit(supabase, res, userId, 'mcp'))) return;

  // Vercel and the dev plugin parse application/json bodies; tolerate a raw
  // string (e.g. a charset-suffixed content type that skipped parsing).
  let body: unknown = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      rpcError(res, RPC_PARSE_ERROR, 'Parse error');
      return;
    }
  }
  if (Array.isArray(body)) {
    // JSON-RPC batching was removed in the 2025-06-18 MCP revision.
    rpcError(res, RPC_INVALID_REQUEST, 'Batch requests are not supported');
    return;
  }
  if (!isJsonRpcRequest(body)) {
    rpcError(res, RPC_INVALID_REQUEST, 'Invalid JSON-RPC request');
    return;
  }

  const outcome = await handleMcpMessage(body, MCP_TOOLS, { supabase, userId });
  if (outcome.kind === 'accepted') {
    res.status(202).end();
    return;
  }
  res.status(200).json(outcome.body);
}
