import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { MCP_TOOLS } from '../mcp/toolRegistry.js';
import { ToolInputError } from '../mcp/protocol.js';

// POST /api/query { tool, args } — a Supabase-JWT door onto the read-only
// MCP tool registry (PRs, period stats, exercise history, library search,
// block progress, meals). Same McpToolDef.run the connector path uses, so a
// native client gets every server-side aggregate with zero new logic
// (docs/ios/backend-changes.md, W0). Read-only by construction: the registry
// exposes no mutations.

interface Body {
  tool?: unknown;
  args?: unknown;
}

export const QUERY_TOOL_NAMES: readonly string[] = MCP_TOOLS.map(t => t.name);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const body = (req.body ?? {}) as Body;
  const tool = typeof body.tool === 'string' ? MCP_TOOLS.find(t => t.name === body.tool) : undefined;
  if (!tool) {
    res.status(400).send(`unknown tool — one of: ${QUERY_TOOL_NAMES.join(', ')}`);
    return;
  }
  if (body.args !== undefined && (typeof body.args !== 'object' || body.args === null || Array.isArray(body.args))) {
    res.status(400).send('args must be an object');
    return;
  }
  const args = (body.args ?? {}) as Record<string, unknown>;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await enforceRateLimit(supabase, res, userId, 'reads'))) return;

  try {
    const result = await tool.run(supabase, userId, args);
    res.status(200).json({ tool: tool.name, result });
  } catch (err) {
    if (err instanceof ToolInputError) {
      res.status(400).send(err.message);
      return;
    }
    console.error(`[api/query] ${tool.name} failed:`, err instanceof Error ? err.message : err);
    res.status(500).send('Query failed');
  }
}
