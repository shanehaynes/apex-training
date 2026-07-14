import Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from './_lib/auth.js';
import { coachToolSchemas } from '../src/lib/coach/tools.js';
import type { ChatWireEvent } from '../src/lib/coach/wire.js';

// Server-side proxy for the coach chat. The Anthropic key never reaches the
// browser; the client posts { messages, system, withTools } and reads back
// newline-delimited JSON (one ChatWireEvent per line — see
// src/lib/coach/wire.ts). Tool inputs are buffered here and emitted as one
// complete tool_use event — simpler for the client than forwarding partial
// JSON deltas.

// Structural subset of the SDK's MessageStreamEvent — keeps the translator
// testable with plain objects.
export interface UpstreamEvent {
  type: string;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type: string; text?: string; partial_json?: string };
}

/** Translate the Anthropic event stream into the NDJSON wire events. */
export async function streamToWireEvents(
  stream: AsyncIterable<UpstreamEvent>,
  emit: (event: ChatWireEvent) => void,
): Promise<void> {
  let currentTool: { id: string; name: string; json: string } | null = null;

  for await (const event of stream) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      currentTool = { id: event.content_block.id ?? '', name: event.content_block.name ?? '', json: '' };
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        emit({ type: 'text', delta: event.delta.text });
      } else if (event.delta?.type === 'input_json_delta' && currentTool) {
        currentTool.json += event.delta.partial_json ?? '';
      }
    } else if (event.type === 'content_block_stop' && currentTool) {
      emit({
        type: 'tool_use',
        id: currentTool.id,
        name: currentTool.name,
        input: JSON.parse(currentTool.json || '{}') as Record<string, unknown>,
      });
      currentTool = null;
    }
  }

  emit({ type: 'done' });
}

interface Body {
  messages?: unknown;
  system?: unknown;
  withTools?: unknown;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  // VITE_ fallback: the pre-proxy deployments configured the key under the
  // VITE_ name. Server-side it is a plain env var — safe as long as no
  // client code references it via import.meta.env (none does).
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.VITE_ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).send('ANTHROPIC_API_KEY not configured');
    return;
  }

  // Auth gate only: the system prompt is built client-side from the caller's
  // own RLS-filtered data, so per-user scoping is by construction. The gate
  // stops unauthenticated callers burning the Anthropic key.
  if (!(await requireUser(req, res))) return;

  const body = req.body as Body | undefined;
  if (!Array.isArray(body?.messages) || typeof body.system !== 'string') {
    res.status(400).send('Missing messages or system');
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (event: ChatWireEvent) => { res.write(JSON.stringify(event) + '\n'); };

  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system: body.system,
      messages: body.messages as Anthropic.MessageParam[],
      ...(body.withTools ? { tools: coachToolSchemas() } : {}),
    });
    await streamToWireEvents(stream as AsyncIterable<UpstreamEvent>, send);
  } catch (err) {
    console.error('[api/chat] stream failed:', err);
    send({ type: 'error', message: 'Chat request failed' });
  }

  res.end();
}
