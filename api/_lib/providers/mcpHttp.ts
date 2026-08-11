// Minimal outbound MCP client over Streamable HTTP (2025-06-18 spec),
// hand-rolled instead of pulling @modelcontextprotocol/sdk into the
// catch-all lambda — same philosophy as the inbound server in
// api/_lib/mcp/protocol.ts: every dependency there taxes ALL /api/* cold
// starts, and a stateless client only needs POST JSON-RPC out, JSON or
// single-shot SSE back. Provider-generic: a future Garmin MCP reuses it.

export class McpAuthExpiredError extends Error {
  constructor() {
    super('MCP server rejected the access token');
  }
}

export class McpToolError extends Error {
  constructor(readonly code: number | string, message: string) {
    super(`MCP error ${code}: ${message}`);
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpHttpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(
    private readonly endpoint: string,
    private readonly bearerToken: string,
    private readonly clientInfo = { name: 'apex-training', version: '1.0.0' },
  ) {}

  private async post(method: string, params?: Record<string, unknown>, expectReply = true): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.bearerToken}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const id = expectReply ? this.nextId++ : undefined;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) }),
    });
    this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;

    if (res.status === 401 || res.status === 403) throw new McpAuthExpiredError();
    // Notifications legitimately answer 202/204 with no body.
    if (!expectReply) return null;
    if (!res.ok) throw new McpToolError(`http_${res.status}`, (await res.text()).slice(0, 300));

    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (contentType.includes('text/event-stream')) {
      // Single-shot SSE: the stream carries our one response then ends. Scan
      // data: lines for the message answering our id.
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
          if (msg.id === id && ('result' in msg || 'error' in msg)) return msg;
        } catch {
          // Ignore keep-alives and non-JSON data lines.
        }
      }
      throw new McpToolError('bad_sse', `no response for id ${id} in SSE body`);
    }
    return JSON.parse(text) as JsonRpcResponse;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const reply = await this.post('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    if (reply?.error) throw new McpToolError(reply.error.code, reply.error.message);
    await this.post('notifications/initialized', undefined, false);
    this.initialized = true;
  }

  async toolsList(): Promise<McpToolInfo[]> {
    await this.ensureInitialized();
    const reply = await this.post('tools/list', {});
    if (reply?.error) throw new McpToolError(reply.error.code, reply.error.message);
    return (reply?.result?.tools as McpToolInfo[] | undefined) ?? [];
  }

  /**
   * Call a tool and return its structured payload: structuredContent when
   * present, otherwise the first content block's text JSON-parsed (the
   * common structured-as-text convention), otherwise the raw text.
   */
  async toolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const reply = await this.post('tools/call', { name, arguments: args });
    if (reply?.error) throw new McpToolError(reply.error.code, reply.error.message);
    const result = reply?.result ?? {};
    if (result.isError) {
      const text = extractText(result) ?? 'tool reported an error';
      throw new McpToolError('tool_error', `${name}: ${text.slice(0, 300)}`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = extractText(result);
    if (text === null) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

function extractText(result: Record<string, unknown>): string | null {
  const content = result.content as Array<{ type?: string; text?: string }> | undefined;
  const block = content?.find(b => b.type === 'text' && typeof b.text === 'string');
  return block?.text ?? null;
}
