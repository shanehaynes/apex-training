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

export const SERVER_INFO = { name: 'apex-training', version: '2.0.0' } as const;

export const SERVER_INSTRUCTIONS =
  "The authenticated user's Apex Training data: workouts, logs, records, training blocks, exercise library, meals, " +
  'coach notes and memory. Read tools are always available; the tools that change data appear only when the ' +
  'connection was granted write access (if a change is asked for and no such tool is listed, say the connection is ' +
  'read-only and that a new connection or code with write access is needed). All dates are YYYY-MM-DD. ' +
  'Logged weights/reps/durations are free text and may carry units (e.g. "185lb", "2 min"); ' +
  'computed fields like estimated_1rm and tonnage are provided — cite them rather than recomputing. ' +
  'Prefer get_period_stats and get_prs for aggregates instead of deriving from get_workout_detail. ' +
  'Exercise names are alias-aware: use search_exercises to resolve a name before get_exercise_history. ' +
  'Event ids come from get_schedule; a recurring occurrence is addressed as base-id__YYYY-MM-DD. ' +
  "Changes land immediately in the user's account and are listed in Apex under Profile → Coach activity, so " +
  'state what you are about to change and ask before anything that deletes or overwrites (delete_*, ' +
  'uncomplete_workout, set_event_exercises). Never invent weights, reps, distances or macros the user did not ' +
  "state. Pass `today` (the user's local date) on write tools — it decides whether a created workout is a plan or " +
  'a retro-log of something already done.';

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

/**
 * The spec's tool annotations (2025-03-26+): hints a client uses to decide
 * how much to ask before running a tool. Claude and ChatGPT both read
 * readOnlyHint; ChatGPT asks for confirmation before any tool without it.
 * Hints, not enforcement — the dispatcher's write guard is the enforcement.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  /** JSON Schema (object) for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /**
   * 'write' for a tool that changes data. Omitted means read: the dispatcher
   * lets a read-only connection call it and lists it as readOnlyHint. A
   * write tool runs only for a connection with write access, and only after
   * the context's beforeWrite check passes.
   */
  access?: 'read' | 'write';
  annotations?: McpToolAnnotations;
  run(supabase: Admin, userId: string, args: Record<string, unknown>): Promise<unknown>;
}

export function isWriteTool(tool: McpToolDef): boolean {
  return tool.access === 'write';
}

/** The annotations a tools/list entry carries: the tool's own, defaulted from its access. */
export function toolAnnotations(tool: McpToolDef): McpToolAnnotations {
  return { readOnlyHint: !isWriteTool(tool), openWorldHint: false, ...tool.annotations };
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
  /** Whether the connection's token carries write access (resolveMcpAccess). */
  canWrite: boolean;
  /**
   * Runs before every write tool: the daily AI-change cap, in the handler.
   * Returns the message to refuse with, or null to proceed. Absent → proceed.
   */
  beforeWrite?: () => Promise<string | null>;
}

export const READ_ONLY_CONNECTION_MESSAGE =
  'This connection is read-only. To let the assistant make changes, connect again (OAuth) or create a new code in ' +
  'Apex Training → Profile → Claude or ChatGPT with "Can make changes" ticked.';

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
      // Single page; the cursor param is ignored on purpose (a few dozen
      // tools). A read-only connection is not shown the write tools — but
      // the guard below, not this filter, is what stops it calling one.
      return success(id, {
        tools: tools.filter(t => ctx.canWrite || !isWriteTool(t)).map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: toolAnnotations(t),
        })),
      });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = tools.find(t => t.name === name);
      if (!tool) return failure(id, RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      const args =
        typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      // The write guard, enforced here rather than trusted to the listing: a
      // client that cached a fuller tool list, or guessed a name, still
      // cannot write through a read-only token.
      if (isWriteTool(tool)) {
        if (!ctx.canWrite) return success(id, toolError(READ_ONLY_CONNECTION_MESSAGE));
        const refusal = ctx.beforeWrite ? await ctx.beforeWrite() : null;
        if (refusal) return success(id, toolError(refusal));
      }
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
