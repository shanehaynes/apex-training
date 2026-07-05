// Wire protocol between /api/chat and useChat: newline-delimited JSON, one
// event per line. Tool inputs arrive as one complete tool_use event — the
// server buffers the partial-JSON deltas.

export type ChatWireEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; message: string };
