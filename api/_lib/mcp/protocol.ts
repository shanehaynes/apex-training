// Minimal stateless MCP (Model Context Protocol) server core, hand-rolled
// instead of pulling @modelcontextprotocol/sdk into the catch-all lambda —
// every dependency there taxes ALL /api/* cold starts, and a stateless
// Streamable HTTP server (2025-06-18 spec) only needs: POST JSON-RPC in,
// application/json out, 405 for GET, no session ids, no SSE. This module is
// pure (no I/O): the handler owns HTTP and hands parsed messages here.

import type { getSupabaseAdmin } from '../supabaseAdmin.js';

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** Newest first. An unknown client version gets our latest; the client may disconnect. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;

export const SERVER_INFO = { name: 'apex-training', version: '1.0.0' } as const;

export const SERVER_INSTRUCTIONS =
  'Read-only access to the authenticated user\'s training data. All dates are YYYY-MM-DD. ' +
  'Logged weights/reps/durations are free text and may carry units (e.g. "185lb", "2 min"); ' +
  'computed fields like estimated_1rm and tonnage are provided — cite them rather than recomputing. ' +
  'Prefer get_period_stats and get_prs for aggregates instead of deriving from get_workout_detail. ' +
  'Exercise names are alias-aware: use search_exercises to resolve a name before get_exercise_history.';

// ---------------------------------------------------------------------------
// JSON-RPC shapes

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Tool registry contract

/** One text content block; every tool result is a single JSON payload. */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  /** JSON Schema (object) for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  run(supabase: Admin, userId: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Wrap a tool's payload / thrown error into MCP tool-result shape. */
export function toolJson(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function toolError(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Tools throw this for caller mistakes (bad range, unknown exercise) → isError result, not a crash. */
export class ToolInputError extends Error {}

// ---------------------------------------------------------------------------
// Dispatch

export interface McpContext {
  supabase: Admin;
  userId: string;
}

export type McpOutcome =
  | { kind: 'response'; body: JsonRpcResponse }
  | { kind: 'accepted' }; // notification → HTTP 202, empty body

function failure(id: number | string | null, code: number, message: string): McpOutcome {
  return { kind: 'response', body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function success(id: number | string, result: unknown): McpOutcome {
  return { kind: 'response', body: { jsonrpc: '2.0', id, result } };
}

/** True when the parsed body is a structurally valid single JSON-RPC request. */
export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === '2.0' && typeof m.method === 'string';
}

export async function handleMcpMessage(
  msg: JsonRpcRequest,
  tools: readonly McpToolDef[],
  ctx: McpContext,
): Promise<McpOutcome> {
  // Messages without an id are notifications (incl. notifications/initialized):
  // never respond, just HTTP 202.
  if (msg.id === undefined || msg.id === null) return { kind: 'accepted' };
  const id = msg.id;
  const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return success(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }

    case 'ping':
      return success(id, {});

    case 'tools/list':
      // Single page; the cursor param is ignored on purpose (8 tools).
      return success(id, {
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = tools.find(t => t.name === name);
      if (!tool) return failure(id, RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      const args =
        typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return success(id, toolJson(await tool.run(ctx.supabase, ctx.userId, args)));
      } catch (err) {
        if (err instanceof ToolInputError) return success(id, toolError(err.message));
        console.error(`[mcp] tool ${name} failed:`, err instanceof Error ? err.stack ?? err.message : err);
        return success(id, toolError('Internal error running tool.'));
      }
    }

    default:
      return failure(id, RPC_METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}
