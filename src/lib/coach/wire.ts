// Wire protocol between /api/chat and useChat: newline-delimited JSON, one
// event per line. Tool inputs arrive as one complete tool_use event — the
// server buffers the partial-JSON deltas. A single response may carry
// SEVERAL tool_use events (the model can call tools in parallel); the
// client must keep every one, since the API demands a tool_result for each.
//
// The sight loop (coach initiative, lane B01) adds the server-side reads.
// The read tools and read_doctrine never become confirm cards: api/chat.ts
// runs them itself, several rounds deep, and narrates each one on the wire —
// `tool_read` when a call starts, `tool_read_result` when it finishes — so
// the client can show what the coach checked and rebuild an API-valid
// history (assistant tool_use → user tool_result) for the stored thread.
// Per round the server emits: the round's text, then one tool_read per
// server-side call, then their tool_read_results, then — on the last round
// only — any write tool_use events and `done`.

export type ChatWireEvent =
  | { type: 'text'; delta: string }
  /** `label`: the confirmation-card one-liner, computed server-side with
   *  real context (W5a). Wire-only — never forwarded to the model. */
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; label?: string }
  /** A server-side call has started. `label` is the chip: "Checked: Deadlift
   *  history", or the doctrine topic's title for read_doctrine. */
  | { type: 'tool_read'; id: string; name: string; input: Record<string, unknown>; label: string }
  /** The same call has finished; `text` is what the model was handed. */
  | { type: 'tool_read_result'; id: string; text: string; isError: boolean }
  /** A doctrine line the reply relies on (citations on the document block). */
  | { type: 'citation'; citedText: string; documentTitle: string | null }
  /** Something the user should know that is not the model's text — the
   *  round bound, say. Display-only; never part of the history. */
  | { type: 'notice'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** A complete tool call as it appears on the wire and in the Anthropic
 *  messages array — /api/chat forwards these shapes verbatim. */
export type WireToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** One server-side call as the client sees it: the tool_use block the
 *  assistant turn carries, the chip, and the result the user turn answers with. */
export interface WireRead {
  use: WireToolUse;
  label: string;
  result: { text: string; isError: boolean };
}

export interface WireCitation {
  citedText: string;
  documentTitle: string | null;
}

/**
 * One assistant response of the turn: the text it streamed, then the
 * server-side calls it made. Every round but the last is a server round —
 * its reads were answered and the model spoke again; the last round holds
 * the final text and, on a mixed response, the reads whose results travel
 * with the client's write results (see useChat).
 */
export interface WireRound {
  text: string;
  reads: WireRead[];
}

export interface WireCollector {
  /** Feed a decoded chunk; complete lines are parsed as they arrive. */
  push(chunk: string): void;
  /** Flush any trailing line left in the buffer once the stream ends. */
  end(): void;
  /** Every round's text joined for display (a blank line between rounds). */
  readonly text: string;
  /** Write tool_use events, in arrival order. */
  readonly toolUses: WireToolUse[];
  /** Every server-side call, in arrival order. */
  readonly reads: WireRead[];
  /** The turn split by upstream response — see WireRound. */
  readonly rounds: WireRound[];
  readonly citations: WireCitation[];
  readonly notices: string[];
}

/**
 * Accumulates a chat response from NDJSON chunks: text deltas concatenate
 * (onText fires with the running total, for streaming display) and every
 * tool_use event is kept in arrival order. onRead fires with every chip so
 * far each time a server-side call starts, so the panel can show "Checked:
 * …" while the coach is still reading. An error event throws.
 */
export function createWireCollector(
  onText?: (fullText: string) => void,
  onRead?: (labels: string[]) => void,
): WireCollector {
  let text = '';
  let buffer = '';
  const toolUses: WireToolUse[] = [];
  const reads: WireRead[] = [];
  const rounds: WireRound[] = [{ text: '', reads: [] }];
  const citations: WireCitation[] = [];
  const notices: string[] = [];

  // Whether the current round's reads have been answered: once they have,
  // the next text or read belongs to the model's NEXT response.
  let answered = false;

  const current = () => rounds[rounds.length - 1];
  const newRound = () => { rounds.push({ text: '', reads: [] }); answered = false; };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as ChatWireEvent;
    if (event.type === 'text') {
      // The round's own text is kept exact for the history; the display
      // text gets a blank line between responses.
      if (answered) {
        newRound();
        if (text && !/\s$/.test(text)) text += '\n\n';
      }
      current().text += event.delta;
      text += event.delta;
      onText?.(text);
    } else if (event.type === 'tool_use') {
      toolUses.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
    } else if (event.type === 'tool_read') {
      // The model read again without speaking in between.
      if (answered) newRound();
      const read: WireRead = {
        use: { type: 'tool_use', id: event.id, name: event.name, input: event.input },
        label: event.label,
        result: { text: '', isError: false },
      };
      reads.push(read);
      current().reads.push(read);
      onRead?.(reads.map(r => r.label));
    } else if (event.type === 'tool_read_result') {
      const read = reads.find(r => r.use.id === event.id);
      if (read) read.result = { text: event.text, isError: event.isError };
      if (current().reads.some(r => r.use.id === event.id)) answered = true;
    } else if (event.type === 'citation') {
      citations.push({ citedText: event.citedText, documentTitle: event.documentTitle });
    } else if (event.type === 'notice') {
      notices.push(event.message);
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
    get reads() { return reads; },
    get rounds() { return rounds; },
    get citations() { return citations; },
    get notices() { return notices; },
  };
}
