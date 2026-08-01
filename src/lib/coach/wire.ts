// Wire protocol between /api/chat and useChat: newline-delimited JSON, one
// event per line. Tool inputs arrive as one complete tool_use event — the
// server buffers the partial-JSON deltas. A single response may carry
// SEVERAL tool_use events (the model can call tools in parallel); the
// client must keep every one, since the API demands a tool_result for each.

export type ChatWireEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** A complete tool call as it appears on the wire and in the Anthropic
 *  messages array — /api/chat forwards these shapes verbatim. */
export type WireToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface WireCollector {
  /** Feed a decoded chunk; complete lines are parsed as they arrive. */
  push(chunk: string): void;
  /** Flush any trailing line left in the buffer once the stream ends. */
  end(): void;
  readonly text: string;
  readonly toolUses: WireToolUse[];
}

/**
 * Accumulates a chat response from NDJSON chunks: text deltas concatenate
 * (onText fires with the running total, for streaming display) and every
 * tool_use event is kept in arrival order. An error event throws.
 */
export function createWireCollector(onText?: (fullText: string) => void): WireCollector {
  let text = '';
  let buffer = '';
  const toolUses: WireToolUse[] = [];

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as ChatWireEvent;
    if (event.type === 'text') {
      text += event.delta;
      onText?.(text);
    } else if (event.type === 'tool_use') {
      toolUses.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    end() {
      const rest = buffer;
      buffer = '';
      handleLine(rest);
    },
    get text() { return text; },
    get toolUses() { return toolUses; },
  };
}
